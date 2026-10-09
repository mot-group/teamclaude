import http from 'node:http';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderDashboardHtml, dashboardCsp } from './dashboard.js';
import { THRESHOLD_BUCKET_KEYS } from './model.js';

const derive = promisify(scrypt);
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'teamclaude_dashboard';

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) throw new Error('Use a password between 16 and 256 characters.');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt, 64)).toString('hex') };
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const plain = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A percent the proxy's strict check would also take: 1-100 with at most one
// fractional digit, as a finite number or its canonical decimal string. Tested
// on the text so '1e2', ' 98' and 98.55 fail instead of being rounded.
const percent = (/** @type {unknown} */ v) => ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string')
  && /^[1-9]\d{0,2}(\.\d)?$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 100;

/**
 * Rebuilds `{ buckets }` with only bucket keys that can't touch a prototype.
 * @param {unknown} buckets
 */
function bucketsPayload(buckets) {
  if (!plain(buckets)) return null;
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (buckets));
  if (entries.length > 7 || !entries.every(([k, v]) => k.length <= 32 && (v === null || percent(v)))) return null;
  return Object.fromEntries(entries.filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k)));
}

const TABLE_KEYS = ['default', ...THRESHOLD_BUCKET_KEYS];

/**
 * Rebuilds a stored threshold or cap sent as a precondition: a number or null
 * as is, a table with only `default` and known bucket keys holding plain values.
 * Anything else it named would only turn the compare into a 409 anyway.
 * @param {unknown} v
 */
function tablePayload(v) {
  if (!plain(v)) return v;
  const t = /** @type {Record<string, unknown>} */ (v);
  return Object.fromEntries(TABLE_KEYS.filter(k => Object.hasOwn(t, k) && (t[k] === null || ['number', 'string', 'boolean'].includes(typeof t[k]))).map(k => [k, t[k]]));
}

/**
 * Shape-checks a limits (`account`) or fleet threshold body and rebuilds it
 * field by field, or returns null. Like the override check above, this
 * duplicates the proxy's validation on purpose rather than importing it.
 * @param {unknown} data
 * @param {boolean} account
 */
function limitsPayload(data, account) {
  if (!plain(data)) return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const stored = (/** @type {unknown} */ v) => v === null || typeof v === 'number' || plain(v);
  if (!stored(d.expected)) return null;
  if (!account) {
    const buckets = bucketsPayload(d.buckets);
    return buckets && { expected: tablePayload(d.expected), buckets };
  }
  const expected = /** @type {Record<string, unknown>} */ (d.expected);
  if (typeof d.id !== 'string' || !d.id || d.id.length > 256 || !plain(expected)
    || !stored(expected.switchThreshold ?? null) || !stored(expected.maxUsage ?? null)) return null;
  /** @type {Record<string, unknown>} */
  // An absent precondition stays absent (stringify drops undefined), so the
  // proxy, not this relay, decides what a missing one means.
  const out = { id: d.id, expected: { switchThreshold: tablePayload(expected.switchThreshold), maxUsage: tablePayload(expected.maxUsage) } };
  for (const field of ['switchThreshold', 'maxUsage']) {
    const change = d[field];
    if (change === undefined) continue;
    if (!plain(change)) return null;
    const c = /** @type {Record<string, unknown>} */ (change);
    if (c.reset !== undefined) {
      if (c.reset !== true) return null;
      out[field] = { reset: true };
    } else {
      const buckets = bucketsPayload(c.buckets);
      if (!buckets) return null;
      out[field] = { buckets };
    }
  }
  return out;
}

export function createDashboardServer({ credential, proxyUrl = 'http://127.0.0.1:3456', apiKey = '', hosts = ['127.0.0.1', 'localhost'], secure = false }) {
  if (!/^[a-f0-9]{32}$/.test(credential?.salt) || !/^[a-f0-9]{128}$/.test(credential?.hash)) throw new Error('Invalid dashboard password file');
  const upstream = new URL(proxyUrl);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname)) throw new Error('Dashboard proxy URL must use HTTP on loopback');
  const allowedHosts = new Set(hosts.map(host => host.replace(/^\[|\]$/g, '').toLowerCase()));
  const sessions = new Map();
  const attempts = new Map();
  let checking = 0;
  let loginWindow = { until: 0, count: 0 };
  const page = renderDashboardHtml({ sessionAuth: true });
  const cookie = (token, age) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
      let origin;
      try { origin = new URL(`${secure ? 'https' : 'http'}://${req.headers.host}`); } catch { reply(400, { error: 'Invalid host' }); return; }
      // Hostnames are case-insensitive and URL lowercases them, so compare the raw header lowercased too.
      if (!allowedHosts.has(origin.hostname.replace(/^\[|\]$/g, '').toLowerCase()) || origin.host !== String(req.headers.host).toLowerCase()) { reply(403, { error: 'Unknown dashboard host' }); return; }
      if (req.method === 'GET' && ['/', '/teamclaude/dashboard'].includes(req.url)) {
        reply(200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': dashboardCsp(page) }); return;
      }
      if ((req.headers.origin && req.headers.origin !== origin.origin) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        reply(403, { error: 'Cross-origin request refused' }); return;
      }
      if (req.method === 'POST' && req.url === '/teamclaude/login') {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const now = Date.now();
        for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
        if (loginWindow.until <= now) loginWindow = { until: now + 60000, count: 0 };
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || { count: 0, until: now + 60000 };
        if (entry.count >= 5 || loginWindow.count >= 30 || checking >= 4) { reply(429, { error: 'Too many attempts. Try again in a minute.' }, { 'Retry-After': '60' }); return; }
        entry.count++; loginWindow.count++; attempts.set(ip, entry);
        const { password } = await body(req);
        if (typeof password !== 'string' || password.length > 256) { reply(401, { error: 'Incorrect password' }); return; }
        if (checking >= 4) { reply(429, { error: 'Too many attempts. Try again in a minute.' }, { 'Retry-After': '60' }); return; }
        checking++;
        let actual;
        try { actual = await derive(password, credential.salt, 64); } finally { checking--; }
        if (!timingSafeEqual(actual, Buffer.from(credential.hash, 'hex'))) { reply(401, { error: 'Incorrect password' }); return; }
        for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, now + SESSION_MS);
        reply(200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_MS / 1000) }); return;
      }
      const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!token || (sessions.get(token) || 0) <= Date.now()) {
        if (token) sessions.delete(token);
        reply(401, { error: 'Sign in to continue' }); return;
      }
      if (req.method === 'POST' && req.url === '/teamclaude/logout') {
        sessions.delete(token);
        reply(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
      }
      const allowed = req.method === 'GET' && ['/teamclaude/status', '/teamclaude/quota', '/teamclaude/forecast'].includes(req.url);
      const switching = req.method === 'POST' && req.url === '/teamclaude/switch';
      const forcing = req.method === 'POST' && req.url === '/teamclaude/routes/override';
      const labeling = req.method === 'POST' && req.url === '/teamclaude/accounts/label';
      const limits = req.method === 'POST' && req.url === '/teamclaude/accounts/limits';
      const threshold = req.method === 'POST' && req.url === '/teamclaude/threshold';
      const graceful = req.method === 'POST' && req.url === '/teamclaude/graceful';
      if (!allowed && !switching && !forcing && !labeling && !limits && !threshold && !graceful) { reply(404, { error: 'Not found' }); return; }
      let payload;
      if (switching) {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const data = await body(req);
        if (typeof data.account !== 'string' || !data.account || data.account.length > 256) { reply(400, { error: 'Account name required' }); return; }
        payload = JSON.stringify({ account: data.account });
      }
      if (forcing) {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const data = await body(req);
        // Checked here as well as on the proxy, and re-serialised field by field
        // like the switch above: this is the server reachable from the LAN, and
        // it forwards nothing it has not named itself. The duplication is
        // deliberate — importing the proxy's validator would pull its whole
        // module graph (MITM certs, upstream pool) into this process.
        const name = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
        const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
        const expected = data.expected;
        const shaped = name(data.route)
          && (data.clear === true || (name(data.account) && ['fallback', 'hold'].includes(data.whenSpent)))
          && object(expected) && Array.isArray(expected.match) && Array.isArray(expected.accounts)
          && (expected.persisted === null || object(expected.persisted));
        if (!shaped) { reply(400, { error: 'Route override request is malformed' }); return; }
        payload = JSON.stringify({
          route: data.route,
          expected: { match: expected.match, accounts: expected.accounts, persisted: expected.persisted },
          ...(data.clear === true ? { clear: true } : { account: data.account, whenSpent: data.whenSpent }),
        });
      }
      if (labeling) {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const data = await body(req);
        const text = (/** @type {unknown} */ v) => typeof v === 'string' && v.length <= 256;
        if (!text(data.id) || !data.id || !text(data.label)) { reply(400, { error: 'Rename request is malformed' }); return; }
        payload = JSON.stringify({ id: data.id, label: data.label });
      }
      if (graceful) {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const data = await body(req);
        if (typeof data.enabled !== 'boolean') { reply(400, { error: 'Graceful switch request is malformed' }); return; }
        payload = JSON.stringify({ enabled: data.enabled });
      }
      if (limits || threshold) {
        if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415, { error: 'Use JSON' }); return; }
        const data = await body(req);
        const out = limitsPayload(data, limits);
        if (!out) { reply(400, { error: limits ? 'Limits request is malformed' : 'Threshold request is malformed' }); return; }
        payload = JSON.stringify(out);
      }
      const response = await fetch(new URL(req.url, upstream), {
        method: req.method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      // The force endpoint answers its refusals in the body — which field was
      // rejected, and the row as it is now for a 409 — and the dialog needs them
      // to say anything useful. They name routes and accounts this signed-in
      // session already reads from /teamclaude/status.
      // 500 included: the endpoint answers a failed reload with
      // `{ persisted: true, applied: false }`, and swapping that for the generic
      // error told the operator nothing changed after the config write landed.
      const explained = (forcing || labeling || limits || threshold) && [400, 404, 409, 500].includes(response.status);
      if (!response.ok && !explained) { reply(response.status === 401 ? 502 : response.status, { error: 'Proxy request failed' }); return; }
      reply(response.status, await response.json());
    } catch (err) {
      if (!res.headersSent && !res.destroyed) reply(err instanceof SyntaxError || err.message === 'Request too large' ? 400 : 502, { error: 'Request failed. Check the proxy service.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const passwordFile = process.env.TEAMCLAUDE_DASHBOARD_PASSWORD_FILE || join(configDir, 'teamclaude-dashboard-password.json');
  if (process.argv.includes('--init-password')) {
    const password = randomBytes(24).toString('base64url');
    await mkdir(dirname(passwordFile), { recursive: true, mode: 0o700 });
    await writeFile(passwordFile, JSON.stringify(await hashPassword(password)) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(password);
    return;
  }
  const configFile = process.env.TEAMCLAUDE_CONFIG || join(configDir, 'teamclaude.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const credential = JSON.parse(await readFile(passwordFile, 'utf8'));
  const host = process.env.TEAMCLAUDE_DASHBOARD_HOST || '127.0.0.1';
  const port = Number(process.env.TEAMCLAUDE_DASHBOARD_PORT || 3457);
  const secure = process.env.TEAMCLAUDE_DASHBOARD_SECURE === 'true';
  if (['0.0.0.0', '::'].includes(host)) throw new Error('Bind to a specific LAN address');
  const hosts = [...new Set([host, '127.0.0.1', 'localhost', ...(process.env.TEAMCLAUDE_DASHBOARD_HOSTNAMES || '').split(',').filter(Boolean)])];
  const server = createDashboardServer({ credential, hosts, secure, proxyUrl: `http://127.0.0.1:${config.proxy?.port || 3456}`, apiKey: config.proxy?.apiKey || '' });
  server.on('error', err => { console.error(`Dashboard: ${err.message}`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`TeamClaude dashboard: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 11000).unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}

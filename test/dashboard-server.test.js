import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDashboardServer, hashPassword } from '../src/dashboard-server.js';

const credential = await hashPassword('test-dashboard-password');
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const requests = [];
  const proxy = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ url: req.url, key: req.headers['x-api-key'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/routes/override')) {
      const data = JSON.parse(body);
      // The proxy answers a stale precondition with the row as it is now, and
      // the page needs that to offer "use current" — so the refusal is not a
      // generic failure here either.
      if (data.route === 'stale') {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false, error: 'changed elsewhere', row: { name: 'stale' } }));
        return;
      }
      // A write that landed and then failed to apply. The 500 body is the only
      // place that difference is stated, and the operator has to act on it.
      if (data.route === 'half-applied') {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, persisted: true, applied: false, error: 'reload failed; see the proxy log' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, row: { name: data.route }, persisted: true, applied: true, warnings: [] }));
      return;
    }
    res.end(JSON.stringify(req.url.endsWith('/switch') ? { ok: true, account: JSON.parse(body).account } : { accounts: [{ name: 'test-account' }] }));
  });
  const proxyUrl = await listen(proxy);
  const server = createDashboardServer({ credential, proxyUrl, apiKey: 'upstream-secret' });
  const url = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); proxy.closeAllConnections(); proxy.close(); });
  const login = (password = 'test-dashboard-password', headers = {}) => fetch(url + '/teamclaude/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify({ password }) });
  return { url, requests, login };
}

test('dashboard gates every data route, including loopback, and never serves as a proxy', async t => {
  const { url, requests, login } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal((await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'links can open the static sign-in page');
  assert.match(page.headers.get('content-security-policy'), /sha256-/);
  const html = await page.text();
  assert.match(html, /var SESSION_AUTH = true/);
  assert.doesNotMatch(html, /upstream-secret|test-account/);
  for (const path of ['/teamclaude/status', '/teamclaude/quota', '/v1/messages']) assert.equal((await fetch(url + path)).status, 401);
  assert.equal((await login('wrong')).status, 401);
  const response = await login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
  const headers = { cookie: cookie.split(';')[0] };
  assert.equal((await fetch(url + '/teamclaude/status', { headers })).status, 200);
  assert.equal(requests[0].key, 'upstream-secret');
  assert.equal((await fetch(url + '/v1/messages', { headers })).status, 404);
  assert.equal((await fetch(url + '/teamclaude/reload', { method: 'POST', headers })).status, 404);
  assert.equal(requests.length, 1);
  assert.equal((await fetch(url + '/teamclaude/logout', { method: 'POST', headers: { ...headers, origin: url } })).status, 200);
  assert.equal((await fetch(url + '/teamclaude/status', { headers })).status, 401);
});

test('LAN browser origin fallback works without Sec-Fetch-Site; cross-origin requests and DNS rebinding fail', async t => {
  const { url, login, requests } = await fixture(t);
  assert.equal((await login('test-dashboard-password', { origin: 'http://attacker.test' })).status, 403);
  const rebound = await new Promise(resolve => { http.get(url, { headers: { host: 'attacker.test' } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(rebound, 403);
  const response = await login();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const options = { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ account: 'b' }) };
  assert.equal((await fetch(url + '/teamclaude/switch', options)).status, 200);
  assert.deepEqual(JSON.parse(requests[0].body), { account: 'b' });
  assert.equal((await fetch(url + '/teamclaude/switch', { ...options, headers: { ...options.headers, origin: 'http://attacker.test' } })).status, 403);
  assert.equal((await fetch(url + '/teamclaude/status', { headers: { cookie, 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal(requests.length, 1);
});

test('login attempts are throttled and malformed credentials fail closed', async t => {
  const { login } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.throws(() => createDashboardServer({ credential: {} }), /password file/);
  assert.throws(() => createDashboardServer({ credential, proxyUrl: 'https://example.com' }), /loopback/);
  await assert.rejects(hashPassword('short'), /16 and 256/);
});

test('a restart invalidates sessions and a missing proxy reports an outage', async t => {
  const { url, login } = await fixture(t);
  const response = await login();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const server = createDashboardServer({ credential, proxyUrl: 'http://127.0.0.1:1' });
  const other = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await fetch(other + '/teamclaude/status', { headers: { cookie } })).status, 401);
  const signedIn = await fetch(other + '/teamclaude/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: other }, body: JSON.stringify({ password: 'test-dashboard-password' }) });
  const headers = { cookie: signedIn.headers.get('set-cookie').split(';')[0] };
  const failed = await fetch(other + '/teamclaude/status', { headers });
  assert.equal(failed.status, 502);
  assert.equal((await fetch(url + '/teamclaude/status', { headers: { cookie } })).status, 200);
});


test('the CLI runs through the deployment symlink and creates a password hash', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-dashboard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = join(dir, 'current');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), current, 'dir');
  const passwordFile = join(dir, 'password.json');
  const { stdout } = await promisify(execFile)(process.execPath, [join(current, 'src/dashboard-server.js'), '--init-password'], {
    env: { ...process.env, TEAMCLAUDE_DASHBOARD_PASSWORD_FILE: passwordFile },
  });
  assert.match(stdout.trim(), /^[A-Za-z0-9_-]{32}$/);
  const saved = JSON.parse(await readFile(passwordFile, 'utf8'));
  assert.match(saved.salt, /^[a-f0-9]{32}$/);
  assert.match(saved.hash, /^[a-f0-9]{128}$/);
});

test('IPv6 host literals match unbracketed configured addresses', async t => {
  const server = createDashboardServer({ credential, hosts: ['::1'] });
  const url = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const status = await new Promise(resolve => {
    http.get(url, { headers: { host: '[::1]:3457' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 200);
});

// The Force dialog reaches the proxy through here on a LAN deployment. The
// forwarded body is rebuilt field by field, like the switch above: this is the
// server exposed to the LAN, and it relays nothing it has not named itself.
test('a route override is forwarded field by field, and a malformed one never leaves', async t => {
  const { url, requests, login } = await fixture(t);
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: url, 'content-type': 'application/json' };
  const send = body => fetch(url + '/teamclaude/routes/override', { method: 'POST', headers, body: JSON.stringify(body) });
  const expected = { match: ['*opus*'], accounts: ['a@example.com'], persisted: null };

  const applied = await send({ route: 'bulk', expected, account: 'a@example.com', whenSpent: 'hold', note: 'dropped' });
  assert.equal(applied.status, 200);
  assert.deepEqual(JSON.parse(requests[0].body), { route: 'bulk', expected, account: 'a@example.com', whenSpent: 'hold' });
  assert.equal((await applied.json()).row.name, 'bulk');

  for (const bad of [
    { expected, account: 'a@example.com', whenSpent: 'hold' },                          // no route
    { route: 'bulk', expected, whenSpent: 'hold' },                                     // no account and no clear
    { route: 'bulk', expected, account: 'a@example.com', whenSpent: 'forever' },
    { route: 'bulk', account: 'a@example.com', whenSpent: 'hold' },                     // no precondition
    { route: 'bulk', expected: { match: '*opus*', accounts: [], persisted: null }, clear: true },
    { route: 'bulk', expected: { match: [], accounts: [] }, clear: true },               // persisted missing
    { route: 'x'.repeat(257), expected, clear: true },
  ]) {
    assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(requests.length, 1, 'nothing malformed was forwarded');

  const conflict = await send({ route: 'stale', expected, clear: true });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'changed elsewhere');
  assert.equal(requests.length, 2);

  // A 500 from this endpoint is explained too: replacing it with the generic
  // error told the operator nothing had changed after the config write landed.
  const halfApplied = await send({ route: 'half-applied', expected, clear: true });
  assert.equal(halfApplied.status, 500);
  assert.deepEqual(await halfApplied.json(),
    { ok: false, persisted: true, applied: false, error: 'reload failed; see the proxy log' });

  const notJson = await fetch(url + '/teamclaude/routes/override', { method: 'POST', headers: { cookie, origin: url }, body: '{}' });
  assert.equal(notJson.status, 415);
});

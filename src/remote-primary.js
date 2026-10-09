import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const instances = new WeakMap();
const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
const MODEL_PATHS = new Set([
  'POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models',
  'POST /backend-api/codex/responses', 'POST /backend-api/codex/responses/compact', 'GET /backend-api/codex/models',
]);

function headersFor(headers) {
  const excluded = new Set([...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(':') && !excluded.has(name.toLowerCase())));
}

function answer(res, message, status = 503) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }));
}

export function isRemoteModelRequest(req) {
  return MODEL_PATHS.has(`${req.method} ${String(req.url || '').split('?')[0]}`);
}

export function getRemotePrimary(config) {
  if (!config.remotePrimary) return null;
  if (!instances.has(config)) instances.set(config, new RemotePrimary(config.remotePrimary));
  return instances.get(config);
}

export class RemotePrimary {
  constructor(settings, { intervalMs = 5000, deadlineMs = 2000, recoveryMs = 60000, recoveryProbes = 13, failures = 3, now = Date.now, log = line => console.error(line) } = {}) {
    this.url = new URL(settings.url);
    const loopback = ['127.0.0.1', '[::1]'].includes(this.url.hostname);
    if ((this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && loopback)) || this.url.username || this.url.password || this.url.pathname !== '/' || this.url.search || this.url.hash) {
      throw new Error('remotePrimary.url must be an HTTPS origin, or an HTTP loopback origin');
    }
    if (typeof settings.instanceId !== 'string' || !settings.instanceId.trim()) throw new Error('remotePrimary.instanceId is required');
    if (!isAbsolute(settings.apiKeyFile || '')) throw new Error('remotePrimary.apiKeyFile must be an absolute path');
    this.key = readFileSync(settings.apiKeyFile, 'utf8').trim();
    if (!this.key || /[\r\n]/.test(this.key)) throw new Error('Invalid remote primary client key');
    this.mode = settings.mode || 'auto';
    if (!['auto', 'primary-only', 'local-only'].includes(this.mode)) throw new Error('Invalid remotePrimary.mode');
    this.instanceId = settings.instanceId;
    this.deadlineMs = deadlineMs;
    this.recoveryMs = recoveryMs;
    this.recoveryProbes = recoveryProbes;
    this.failureLimit = failures;
    this.now = now;
    this.log = log;
    this.route = this.mode === 'local-only' ? 'local' : 'starting';
    this.reason = null;
    this.failed = 0;
    this.good = 0;
    this.goodSince = null;
    this.forwarded = 0;
    this.local = 0;
    this.inFlight = 0;
    this.probing = null;
    this.probeRequest = null;
    this.closed = false;
    this.ready = this.mode === 'local-only' ? Promise.resolve() : this.probe();
    this.timer = setInterval(() => { if (this.mode !== 'local-only') void this.probe(); }, intervalMs);
    this.timer.unref();
  }

  status() {
    return { mode: this.mode, route: this.route, reason: this.reason, consecutiveFailures: this.failed, consecutiveSuccesses: this.good, forwarded: this.forwarded, local: this.local, inFlight: this.inFlight };
  }

  transition(route, reason = null) {
    if (this.closed) return;
    if (this.route !== route || this.reason !== reason) this.log(`[TeamClaude] Remote primary route: ${route}${reason ? ` (${reason})` : ''}`);
    this.route = route;
    this.reason = reason;
  }

  observe(ok, reason = null, availability = false, immediate = false) {
    if (this.closed) return;
    if (ok) {
      this.failed = 0;
      this.good++;
      if (this.goodSince === null) this.goodSince = this.now();
      if (this.route === 'starting' || this.route === 'primary' || (this.good >= this.recoveryProbes && this.now() - this.goodSince >= this.recoveryMs)) this.transition('primary');
      return;
    }
    this.good = 0;
    this.goodSince = null;
    this.failed++;
    if (!availability) { this.transition('blocked', reason); return; }
    if (this.route === 'blocked') return;
    if (this.mode === 'primary-only') { this.transition('unavailable', reason); return; }
    if (immediate || this.route === 'starting' || this.failed >= this.failureLimit) this.transition('local', reason);
  }

  probe() {
    if (this.closed || this.probing) return this.probing || Promise.resolve();
    const transport = this.url.protocol === 'https:' ? https : http;
    this.probing = new Promise(resolve => {
      let settled = false;
      const finish = (ok, reason = null, availability = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.observe(ok, reason, availability);
        resolve();
      };
      const req = transport.get(new URL('/teamclaude/health', this.url), { headers: { 'x-api-key': this.key }, agent: false }, res => {
        let body = '';
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 8192) { finish(false, 'invalid-health-response'); res.destroy(); }
        });
        res.on('error', () => finish(false, 'health-connection-failed', true));
        res.on('end', () => {
          if ([502, 503, 504].includes(res.statusCode)) { finish(false, 'health-unavailable', true); return; }
          if (res.statusCode !== 200) { finish(false, `health-http-${res.statusCode}`); return; }
          try {
            const health = JSON.parse(body);
            if (health.service !== 'teamclaude' || health.instanceId !== this.instanceId || health.acceptsRelay !== true) { finish(false, 'primary-identity-mismatch'); return; }
            finish(true);
          } catch { finish(false, 'invalid-health-response'); }
        });
      });
      this.probeRequest = req;
      const timer = setTimeout(() => { finish(false, 'health-timeout', true); req.destroy(); }, this.deadlineMs);
      req.on('error', err => {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        finish(false, NETWORK_ERRORS.has(code) ? 'health-connection-failed' : 'health-tls-or-config-error', NETWORK_ERRORS.has(code));
      });
    }).finally(() => { this.probing = null; this.probeRequest = null; });
    return this.probing;
  }

  async handle(req, res, { pinned = false } = {}) {
    if (!isRemoteModelRequest(req)) return false;
    if (req.headers['x-teamclaude-relay-hop']) { answer(res, 'Chained TeamClaude remote-primary routing is not supported', 508); return true; }
    if (pinned && this.mode !== 'local-only') { answer(res, 'Account pins cannot cross TeamClaude instances. Clear the pin or explicitly select local-only mode.', 400); return true; }
    await this.ready;
    if (res.destroyed || req.aborted) return true;
    if (this.route === 'local') { this.local++; return false; }
    if (this.route !== 'primary') { answer(res, `Remote primary is ${this.route}; check /teamclaude/health`); return true; }
    const transport = this.url.protocol === 'https:' ? https : http;
    const headers = headersFor(req.headers);
    delete headers.authorization;
    delete headers['x-api-key'];
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers.forwarded;
    headers['x-api-key'] = this.key;
    headers['x-teamclaude-relay-hop'] = '1';
    this.forwarded++;
    this.inFlight++;
    await new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.inFlight--;
        clearTimeout(headerTimer);
        resolve();
      };
      const outgoing = transport.request(new URL(req.url, this.url), { method: req.method, headers, agent: false }, upstream => {
        clearTimeout(headerTimer);
        if ([401, 403].includes(upstream.statusCode)) this.observe(false, `inference-http-${upstream.statusCode}`);
        res.writeHead(upstream.statusCode, headersFor(upstream.headers));
        upstream.on('error', () => { res.destroy(); finish(); });
        upstream.on('aborted', () => { res.destroy(); finish(); });
        upstream.on('end', finish);
        upstream.pipe(res);
      });
      const headerTimer = setTimeout(() => { answer(res, 'Remote primary response timed out; this request was not replayed'); outgoing.destroy(); finish(); }, 300000);
      outgoing.on('socket', socket => {
        let connected = false;
        const timer = setTimeout(() => {
          if (connected) return;
          const err = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
          outgoing.destroy(err);
        }, this.deadlineMs);
        socket.once(this.url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(timer); });
        socket.once('close', () => clearTimeout(timer));
      });
      outgoing.on('error', err => {
        if (!req.aborted && !res.destroyed) {
          if (NETWORK_ERRORS.has(/** @type {NodeJS.ErrnoException} */ (err).code)) this.observe(false, 'primary-connection-failed', true, true);
          else this.observe(false, 'primary-tls-or-config-error');
          answer(res, 'Remote primary request failed; it was not replayed. Check route health before continuing.');
        }
        finish();
      });
      req.on('aborted', () => { outgoing.destroy(); finish(); });
      req.on('error', () => { outgoing.destroy(); finish(); });
      res.on('close', () => { outgoing.destroy(); finish(); });
      req.pipe(outgoing);
    });
    return true;
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.probeRequest?.destroy();
  }
}

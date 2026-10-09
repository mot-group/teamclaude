import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePrimary, getRemotePrimary } from '../src/remote-primary.js';
import { createProxyServer } from '../src/server.js';
import { createConnectHandler } from '../src/mitm.js';
import { generateCertChain } from '../src/x509.js';
import { AccountManager } from '../src/account-manager.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => { server.closeAllConnections(); server.close(); };

async function fixture(t, settings = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-remote-'));
  const keyFile = join(dir, 'client.key');
  await writeFile(keyFile, 'client-key', { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { health: 200, instanceId: 'ubuntu', acceptsRelay: true, modelStatus: 200, fault: '', received: [], now: 0 };
  const primary = http.createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'client-key');
    if (req.url === '/teamclaude/health') {
      if (state.fault === 'health-timeout') return;
      res.writeHead(state.health, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'teamclaude', instanceId: state.instanceId, acceptsRelay: state.acceptsRelay }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      state.received.push({ path: req.url, body, headers: req.headers });
      if (state.fault === 'after-dispatch') { req.socket.destroy(); return; }
      res.writeHead(state.modelStatus, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      if (state.fault === 'mid-stream') { setTimeout(() => res.destroy(), 10); return; }
      res.end('data: last\n\n');
    });
  });
  const url = await listen(primary);
  t.after(() => stop(primary));
  const config = { url, apiKeyFile: keyFile, instanceId: 'ubuntu', ...settings };
  const router = new RemotePrimary(config, { intervalMs: 1000000, deadlineMs: 100, now: () => state.now, log: () => {} });
  t.after(() => router.close());
  await router.ready;
  const gateway = http.createServer(async (req, res) => {
    if (!await router.handle(req, res, { pinned: req.headers['test-pin'] === 'true' })) res.end('LOCAL');
  });
  const local = await listen(gateway);
  t.after(() => stop(gateway));
  const send = (headers = {}, path = '/v1/messages?beta=true') => fetch(local + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"model":"test"}' });
  return { state, router, config, send, local, primary };
}

test('relay preserves streamed response, query and body, replaces the key and never shares native Authorization', async t => {
  const { router, state, send } = await fixture(t);
  const r = await send({ 'x-api-key': 'incoming', authorization: 'Bearer native-secret' });
  assert.equal(await r.text(), 'data: first\n\ndata: last\n\n');
  assert.equal(state.received[0].path, '/v1/messages?beta=true');
  assert.equal(state.received[0].body, '{"model":"test"}');
  assert.equal(state.received[0].headers['x-api-key'], 'client-key');
  assert.equal(state.received[0].headers.authorization, undefined);
  assert.equal(state.received[0].headers['x-teamclaude-relay-hop'], '1');
  assert.equal(router.status().forwarded, 1);
});

test('three failures select local fallback and recovery requires 13 good probes over 60 seconds', async t => {
  const { router, state, send } = await fixture(t);
  state.health = 503;
  await router.probe(); await router.probe();
  assert.equal(router.status().route, 'primary');
  await router.probe();
  assert.equal(await (await send()).text(), 'LOCAL');
  state.health = 200;
  for (let i = 0; i < 13; i++) await router.probe();
  assert.equal(router.status().route, 'local', 'probe count alone cannot restore routing');
  state.now = 60000;
  await router.probe();
  assert.equal(router.status().route, 'primary');
});

test('a failed recovery probe resets both success count and elapsed window', async t => {
  const { router, state } = await fixture(t);
  state.health = 503;
  for (let i = 0; i < 3; i++) await router.probe();
  state.health = 200;
  state.now = 60000;
  for (let i = 0; i < 12; i++) await router.probe();
  state.health = 503; await router.probe();
  state.health = 200; state.now = 120000;
  for (let i = 0; i < 13; i++) await router.probe();
  assert.equal(router.status().route, 'local');
  state.now = 180000; await router.probe();
  assert.equal(router.status().route, 'primary');
});

test('authentication, identity mismatch and a chained primary block rather than fall back', async t => {
  const { router, state, send } = await fixture(t);
  state.health = 401; await router.probe();
  assert.equal(router.status().route, 'blocked');
  assert.equal((await send()).status, 503);
  state.health = 503;
  for (let i = 0; i < 4; i++) await router.probe();
  assert.equal(router.status().route, 'blocked', 'network errors cannot bypass a prior key rejection');
  state.health = 200; state.instanceId = 'wrong'; await router.probe();
  assert.equal(router.status().reason, 'primary-identity-mismatch');
  state.instanceId = 'ubuntu'; state.acceptsRelay = false; await router.probe();
  assert.equal(router.status().route, 'blocked');
  assert.equal(state.received.length, 0);
});

test('provider 429 and 5xx are returned without retry or cross-proxy fallback', async t => {
  const { router, state, send } = await fixture(t);
  for (const status of [429, 500, 503]) {
    state.modelStatus = status;
    const res = await send(); await res.text();
    assert.equal(res.status, status);
    assert.equal(router.status().route, 'primary');
  }
  assert.equal(state.received.length, 3);
});

test('a connection lost after receiving the body never replays that request locally', async t => {
  const { router, state, send } = await fixture(t);
  state.fault = 'after-dispatch';
  const response = await send();
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not replayed/);
  assert.equal(state.received.length, 1);
  assert.equal(router.status().local, 0);
  assert.equal(await (await send()).text(), 'LOCAL');
});

test('an interrupted stream fails rather than appending a standby response', async t => {
  const { state, send, router } = await fixture(t);
  state.fault = 'mid-stream';
  const res = await send();
  await assert.rejects(res.text());
  assert.equal(state.received.length, 1);
  assert.equal(router.status().local, 0);
});

test('identity routes and administrative requests stay local; model pins and relay loops are rejected', async t => {
  const { send, state } = await fixture(t);
  for (const path of ['/v1/oauth/token', '/api/oauth/profile', '/v1/code/test', '/teamclaude/reload']) assert.equal(await (await send({}, path)).text(), 'LOCAL');
  assert.equal((await send({ 'test-pin': 'true' })).status, 400);
  assert.equal((await send({ 'x-teamclaude-relay-hop': '1' })).status, 508);
  assert.equal(state.received.length, 0);
});

test('primary-only fails closed; local-only never dispatches a model request remotely', async t => {
  const primary = await fixture(t, { mode: 'primary-only' });
  primary.state.health = 503; await primary.router.probe();
  assert.equal((await primary.send()).status, 503);
  const local = await fixture(t, { mode: 'local-only' });
  assert.equal(await (await local.send()).text(), 'LOCAL');
  assert.equal(local.state.received.length, 0);
});

test('health timeout falls back, while inference retains a separate long deadline', async t => {
  const { router, state, send } = await fixture(t);
  state.fault = 'health-timeout';
  for (let i = 0; i < 3; i++) await router.probe();
  assert.equal(router.status().route, 'local');
  assert.equal(await (await send()).text(), 'LOCAL');
});

test('real proxy health is authenticated, cheap, and reports the configured instance', async t => {
  const server = createProxyServer({ getStatus() { throw new Error('health must not read account status'); } }, { proxy: { apiKey: 'admin-key', trustLoopback: false, instanceId: 'physical-ubuntu' } });
  const url = await listen(server); t.after(() => stop(server));
  assert.equal((await fetch(url + '/teamclaude/health')).status, 401);
  const res = await fetch(url + '/teamclaude/health', { headers: { 'x-api-key': 'admin-key' } });
  assert.deepEqual(await res.json(), { service: 'teamclaude', instanceId: 'physical-ubuntu', acceptsRelay: true, remotePrimary: null });
});

test('real proxy routes inference remotely before local account selection and keeps identity local', async t => {
  const { config, state } = await fixture(t);
  const own = [];
  const native = http.createServer((req, res) => { own.push(req.headers.authorization); req.resume(); res.end('IDENTITY'); });
  const upstream = await listen(native); t.after(() => stop(native));
  const am = new AccountManager([], 0.98);
  const server = createProxyServer(am, { proxy: {}, upstream, remotePrimary: config });
  const url = await listen(server); t.after(() => stop(server));
  const r = await fetch(url + '/v1/messages', { method: 'POST', body: '{"model":"test"}' });
  assert.equal(r.status, 200); await r.text();
  assert.equal(state.received.length, 1);
  const identity = await fetch(url + '/api/oauth/profile', { headers: { authorization: 'Bearer native-identity' } });
  assert.equal(await identity.text(), 'IDENTITY');
  assert.deepEqual(own, ['Bearer native-identity']);
});

test('a real CONNECT and HTTP/2 client reaches the remote primary through the shared listener', { timeout: 10000 }, async t => {
  const { config: remotePrimary, state } = await fixture(t);
  const config = { proxy: {}, upstream: 'http://127.0.0.1:1', remotePrimary };
  const cert = generateCertChain('localhost');
  const server = http.createServer();
  server.on('connect', createConnectHandler({ config, accountManager: new AccountManager([], 0.98), ensureLeaf: async () => ({ key: cert.leafKeyPem, cert: cert.leafCertPem }), log: () => {} }));
  const url = new URL(await listen(server));
  t.after(() => { stop(server); getRemotePrimary(config)?.close(); });
  const socket = net.connect(Number(url.port), '127.0.0.1');
  await once(socket, 'connect');
  socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n');
  let reply = '';
  while (!reply.includes('\r\n\r\n')) reply += String((await once(socket, 'data'))[0]);
  assert.match(reply, /200/);
  const encrypted = tls.connect({ socket, servername: 'localhost', ca: cert.caCertPem, ALPNProtocols: ['h2'] });
  await once(encrypted, 'secureConnect');
  const client = http2.connect('https://localhost', { createConnection: () => encrypted });
  t.after(() => { client.destroy(); encrypted.destroy(); socket.destroy(); });
  const request = client.request({ ':method': 'POST', ':path': '/v1/messages?beta=true', 'content-type': 'application/json' });
  let body = '';
  request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
  request.end('{"model":"claude-test"}');
  await once(request, 'end');
  assert.equal(body, 'data: first\n\ndata: last\n\n');
  assert.equal(state.received.length, 1);
  assert.equal(state.received[0].headers['x-api-key'], 'client-key');
});

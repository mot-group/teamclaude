import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

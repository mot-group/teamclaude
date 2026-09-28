import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createControlQueue, createLimitWriters } from '../src/control-queue.js';

// POST /teamclaude/threshold is the Routing section's fleet editor. It patches
// the fleet switch threshold table bucket by bucket (editing the default never
// drops an override), preconditioned on the table the page was showing. Stub
// hook first, then the real CLI with the config file as the witness.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];
const EXPECTED = { default: 0.98, unified7dFable: 1 };
const SAVE = { expected: EXPECTED, buckets: { default: 95 } };

async function withServer(fn, { hooks = {} } = {}) {
  const am = new AccountManager(ACCTS, { default: 0.98, unified7dFable: 1 });
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port, proxy);
  } finally {
    proxy.close();
  }
}

function recorder(answer = async () => ({ switchThreshold: { default: 0.995 } })) {
  const calls = [];
  return { calls, hook: async (payload) => { calls.push(payload); return answer(payload); } };
}

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/threshold`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('a save reaches the hook as percentages and answers with the stored table', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const res = await post(port, { expected: EXPECTED, buckets: { default: '99.5', unified7dFable: null } });
    assert.equal(res.status, 200, await res.clone().text());
    // What the writer stored, not what the manager held before it.
    assert.deepEqual(await res.json(), { ok: true, switchThreshold: { default: 0.995 } });
    assert.deepEqual(calls[0], { expected: EXPECTED, pairs: [['default', 99.5], ['unified7dFable', null]] });
  }, { hooks: { saveFleetThreshold: hook } });
});

test('a null default, an unknown bucket and a non-canonical percentage are 400 before the hook', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const fields = async body => {
      const res = await post(port, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      return (await res.json()).errors.map(e => e.field);
    };
    assert.deepEqual(await fields({ expected: EXPECTED, buckets: { default: null } }), ['buckets.default']);
    assert.deepEqual(await fields({ expected: EXPECTED, buckets: { foo: 90 } }), ['buckets.foo']);
    for (const bad of ['1e2', '98.55', 98.55, 0, 101, ' 98', true]) {
      assert.deepEqual(await fields({ expected: EXPECTED, buckets: { unified7d: bad } }), ['buckets.unified7d']);
    }
    assert.deepEqual(await fields({ expected: 'x', buckets: { default: 90 } }), ['expected']);
    assert.deepEqual(await fields({ expected: EXPECTED }), ['buckets']);
    assert.equal(calls.length, 0);
  }, { hooks: { saveFleetThreshold: hook } });
});

test('413, 501, 409 with current and the 500 split', async () => {
  let answer = null;
  const fail = code => { answer = () => { throw Object.assign(new Error('x'), { code }); }; };
  const realError = console.error;
  console.error = () => {};
  try {
    await withServer(async (_am, port) => {
      assert.equal((await post(port, JSON.stringify({ ...SAVE, pad: 'x'.repeat(70 * 1024) }))).status, 413);
      fail('changed-elsewhere');
      const conflict = await post(port, SAVE);
      assert.equal(conflict.status, 409);
      // The shape the page builds `expected` from.
      assert.deepEqual(await conflict.json(), { ok: false, error: 'changed elsewhere', current: { default: 0.98, unified7dFable: 1 } });
      fail('reload-failed');
      assert.equal((await (await post(port, SAVE)).json()).persisted, true);
      fail(undefined);
      assert.equal((await (await post(port, SAVE)).json()).persisted, false);
    }, { hooks: { saveFleetThreshold: async () => answer() } });
  } finally {
    console.error = realError;
  }
  await withServer(async (_am, port) => {
    assert.equal((await post(port, SAVE)).status, 501);
  });
});

function remoteRequest(server, body) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/teamclaude/threshold';
  req.headers = {};
  req.socket = { remoteAddress: '203.0.113.9' };
  const res = {
    status: null,
    writeHead(status) { this.status = status; return this; },
    end() { this._done(); },
  };
  const finished = new Promise(resolve => { res._done = resolve; });
  server.emit('request', req, res);
  return finished.then(() => res.status);
}

function postWithHost(port, host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/teamclaude/threshold',
      headers: { host, 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the control-plane gates apply: key, cross-origin, DNS rebinding', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port, server) => {
    assert.equal(await remoteRequest(server, JSON.stringify(SAVE)), 401);
    assert.equal((await post(port, SAVE, { Origin: 'https://evil.example', 'x-api-key': 'tc-test' })).status, 403);
    assert.equal(await postWithHost(port, 'attacker.example', SAVE), 403);
    assert.equal(calls.length, 0);
  }, { hooks: { saveFleetThreshold: hook } });
});

// The writer index.js installs, over a spy config update and reload.
test('a fleet save is one config update and one reload, and resolves to what it stored', async () => {
  const disk = { switchThreshold: { unified7dFable: 1 } };
  const log = [];
  const update = async fn => { log.push('update'); const copy = JSON.parse(JSON.stringify(disk)); await fn(copy); Object.assign(disk, copy); return copy; };
  const reload = async () => { log.push('reload'); };
  const { applyChange } = createControlQueue(reload);
  const { saveFleetThreshold } = createLimitWriters({ applyChange, reload, update, hasAccount: () => true });
  const stored = await saveFleetThreshold({ expected: { default: 0.98, unified7dFable: 1 }, pairs: [['default', 95]] });
  assert.deepEqual(log, ['update', 'reload']);
  assert.deepEqual(stored, { switchThreshold: { default: 0.95, unified7dFable: 1 } });
  assert.deepEqual(disk.switchThreshold, { default: 0.95, unified7dFable: 1 });
});

// ── the real writer ─────────────────────────────────────────

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function withRealServer(switchThreshold, fn, { upstreamPort, accounts = ACCTS } = {}) {
  const port = await closedPort();
  const dead = upstreamPort ?? await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-fleet-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${dead}`,
    upstreamProxy: false,
    switchThreshold,
    accounts,
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  const base = `http://127.0.0.1:${port}/teamclaude`;
  const save = body => fetch(`${base}/threshold`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = async () => (await fetch(`${base}/status`)).json();
  // What the page sends: the resolved default plus the raw table.
  const shown = async () => { const s = await status(); return { default: s.switchThreshold, ...s.switchThresholds }; };
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const editDisk = async edit => { const c = await disk(); edit(c); await writeFile(configPath, JSON.stringify(c)); };

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { if ((await fetch(`${base}/status`)).ok) break; } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise(r => setTimeout(r, 100));
    }
    await fn({ save, status, shown, disk, editDisk, base });
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.on('exit', r));
    clearTimeout(killer);
    await rm(dir, { recursive: true, force: true });
  }
}

test('editing the default keeps an override, clearing the override collapses the table, no restart', async () => {
  await withRealServer({ default: 0.98, unified7dFable: 1 }, async ({ save, status, shown, disk }) => {
    const res = await save({ expected: await shown(), buckets: { default: 95 } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, switchThreshold: { default: 0.95, unified7dFable: 1 } });
    assert.deepEqual((await disk()).switchThreshold, { default: 0.95, unified7dFable: 1 });
    const live = await status();
    assert.equal(live.switchThreshold, 0.95, 'the running router uses it');
    assert.deepEqual(live.switchThresholds, { default: 0.95, unified7dFable: 1 });

    // Key order is not a change.
    const cleared = await save({ expected: { unified7dFable: 1, default: 0.95 }, buckets: { unified7dFable: null } });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await disk()).switchThreshold, 0.95);
    assert.equal((await status()).switchThresholds, null);
  });
});

test('a table without default on disk matches what status shows', async () => {
  await withRealServer({ unified7d: 0.9 }, async ({ save, shown, disk }) => {
    const expected = await shown();
    assert.deepEqual(expected, { default: 0.98, unified7d: 0.9 });
    const res = await save({ expected, buckets: { unified7d: 80 } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await disk()).switchThreshold, { default: 0.98, unified7d: 0.8 });
  });
});

test('a stale expected is 409 with the table as it is now, and writes nothing', async () => {
  await withRealServer(0.98, async ({ save, shown, disk, editDisk }) => {
    const expected = await shown();
    await editDisk(c => { c.switchThreshold = { default: 0.97, unified5h: 0.9 }; });
    const snapshot = JSON.stringify(await disk());
    const res = await save({ expected, buckets: { default: 95 } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(JSON.stringify(await disk()), snapshot);
    assert.deepEqual(body.current, await shown(), 'current is what the next status shows');
    assert.deepEqual(body.current, { default: 0.97, unified5h: 0.9 });
  });
});

test('an unknown key in the fleet table is ignored by the precondition and kept', async () => {
  await withRealServer({ default: 0.98, weekly: 0.5 }, async ({ save, shown, disk }) => {
    // As the LAN relay forwards it, without the unknown key.
    const res = await save({ expected: { default: 0.98 }, buckets: { default: 95 } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await disk()).switchThreshold, { default: 0.95, weekly: 0.5 });
    // As the page sends it, with the key.
    const direct = await save({ expected: await shown(), buckets: { default: 96 } });
    assert.equal(direct.status, 200, await direct.clone().text());
  });
});

async function recordingUpstream() {
  const keys = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages')) keys.push(req.headers['x-api-key']);
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-7d-utilization': '0.95',
        'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 3 * 86400),
      });
      res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { keys, port: server.address().port, close: () => server.close() };
}

test('after a 200 the next routing decision uses the new fleet threshold', async () => {
  const upstream = await recordingUpstream();
  try {
    await withRealServer(0.98, async ({ save, shown, base }) => {
      const send = async () => {
        const res = await fetch(`${base.replace('/teamclaude', '')}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        await res.text();
        return upstream.keys.at(-1);
      };
      // Every account reports 95%, under the fleet's 98%: both take traffic.
      for (let i = 0; i < 3; i++) await send();
      assert.ok(upstream.keys.includes('k1') && upstream.keys.includes('k2'), upstream.keys.join());
      const res = await save({ expected: await shown(), buckets: { default: 90 } });
      assert.equal(res.status, 200, await res.clone().text());
      // The fleet's 90% now bars the first account; the second keeps its own 100%.
      for (let i = 0; i < 3; i++) assert.equal(await send(), 'k2');
    }, {
      upstreamPort: upstream.port,
      accounts: [
        { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
        { name: 'b@example.com', type: 'apikey', apiKey: 'k2', switchThreshold: 1 },
      ],
    });
  } finally {
    upstream.close();
  }
});

test('a named client key is refused on both limit endpoints; the shared key is not', async () => {
  const { calls, hook } = recorder();
  const limits = recorder(async () => ({ switchThreshold: 1, maxUsage: null }));
  const config = { ...CONFIG, proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'laptop', key: 'tc-laptop' }] } };
  const am = new AccountManager(ACCTS, { default: 0.98, unified7dFable: 1 });
  const proxy = createProxyServer(am, config, { saveFleetThreshold: hook, saveAccountLimits: limits.hook });
  const port = await listen(proxy);
  try {
    const account = {
      id: 'a1',
      expected: { switchThreshold: null, maxUsage: null },
      switchThreshold: { buckets: { default: 100 } },
    };
    const send = (url, body, key) => fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
    });
    for (const [url, body] of [['/teamclaude/threshold', SAVE], ['/teamclaude/accounts/limits', account]]) {
      const refused = await send(url, body, 'tc-laptop');
      assert.equal(refused.status, 403, url);
      assert.match((await refused.json()).error, /named client key/);
    }
    assert.equal(calls.length + limits.calls.length, 0);
    assert.equal((await send('/teamclaude/threshold', SAVE, 'tc-test')).status, 200);
    assert.equal((await send('/teamclaude/accounts/limits', account, 'tc-test')).status, 200);
  } finally {
    proxy.close();
  }
});

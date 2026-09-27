import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createControlQueue, createLimitWriters } from '../src/control-queue.js';

// POST /teamclaude/accounts/limits is the account dialog's save: the account's
// own switch threshold and usage cap, in one write and one reload, addressed by
// config entry id and preconditioned on the values the page was showing. The
// first half drives the endpoint against a stub hook (shape, gates, how each
// refusal reaches the caller); the second half drives the real CLI, where the
// config file is the witness.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { id: 'a1', name: 'alice@example.com', type: 'apikey', apiKey: 'k1', switchThreshold: 0.9 },
  { id: 'b1', name: 'bob@example.com', type: 'apikey', apiKey: 'k2', maxUsage: { unified7d: 0.6 } },
];
const EXPECTED = { switchThreshold: 0.9, maxUsage: null };
const SAVE = { id: 'a1', expected: EXPECTED, switchThreshold: { buckets: { default: 100 } } };

async function withServer(fn, { hooks = {} } = {}) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port, proxy);
  } finally {
    proxy.close();
  }
}

function recorder(answer = async () => ({ switchThreshold: 1, maxUsage: null })) {
  const calls = [];
  return { calls, hook: async (payload) => { calls.push(payload); return answer(payload); } };
}

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/accounts/limits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('a save reaches the hook as percentages per bucket and answers with what the writer stored', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const res = await post(port, {
      ...SAVE,
      switchThreshold: { buckets: { default: '99.5', unified7dFable: null } },
      maxUsage: { reset: true },
    });
    assert.equal(res.status, 200, await res.clone().text());
    // What the writer stored, not what the manager held before it.
    assert.deepEqual(await res.json(), { ok: true, switchThreshold: 1, maxUsage: null });
    assert.deepEqual(calls[0], {
      id: 'a1',
      expected: EXPECTED,
      switchThreshold: { pairs: [['default', 99.5], ['unified7dFable', null]] },
      maxUsage: { reset: true },
    });
  }, { hooks: { saveAccountLimits: hook } });
});

test('red-team r1: a percentage that is not canonical is refused before the hook, naming the bucket', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    for (const bad of ['1e2', '98.55', 98.55, 0, 101, ' 98', true, [95], {}]) {
      const res = await post(port, { ...SAVE, maxUsage: { buckets: { unified7d: bad } } });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.deepEqual((await res.json()).errors.map(e => e.field), ['maxUsage.buckets.unified7d'], JSON.stringify(bad));
    }
    assert.equal(calls.length, 0);
    for (const good of [100, 99.5, 60, '60']) {
      assert.equal((await post(port, { ...SAVE, switchThreshold: { buckets: { unified7d: good } } })).status, 200);
    }
    assert.deepEqual(calls.map(c => c.switchThreshold.pairs[0][1]), [100, 99.5, 60, 60]);
  }, { hooks: { saveAccountLimits: hook } });
});

test('every rejected field is named', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const fields = async body => (await (await post(port, body)).json()).errors.map(e => e.field);
    assert.deepEqual(await fields({ ...SAVE, switchThreshold: { buckets: { foo: 90 } } }), ['switchThreshold.buckets.foo']);
    // As JSON text: an object literal would set the prototype, not a key.
    assert.deepEqual(await fields(`{"id":"a1","expected":${JSON.stringify(EXPECTED)},"switchThreshold":{"buckets":{"__proto__":90}}}`),
      ['switchThreshold.buckets.__proto__']);
    assert.deepEqual(await fields({ ...SAVE, id: 'x'.repeat(257) }), ['id']);
    assert.deepEqual(await fields({ ...SAVE, id: undefined, account: 'alice@example.com' }), ['id']);
    assert.deepEqual(await fields({ ...SAVE, expected: undefined }), ['expected']);
    assert.deepEqual(await fields({ ...SAVE, expected: { switchThreshold: 0.9 } }), ['expected.maxUsage']);
    assert.deepEqual(await fields({ id: 'a1', expected: EXPECTED }), ['body']);
    // An explicit null is not "leave it": it is named, alone or beside a valid change.
    assert.deepEqual(await fields({ ...SAVE, maxUsage: null }), ['maxUsage']);
    assert.deepEqual(await fields({ id: 'a1', expected: EXPECTED, switchThreshold: null, maxUsage: { buckets: { default: 60 } } }),
      ['switchThreshold']);
    assert.deepEqual(await fields({ id: 'a1', expected: EXPECTED, switchThreshold: null, maxUsage: null }),
      ['switchThreshold', 'maxUsage']);
    assert.deepEqual(await fields({ ...SAVE, switchThreshold: { reset: 'yes' } }), ['switchThreshold']);
    assert.deepEqual(await fields({ ...SAVE, switchThreshold: { reset: true, buckets: { default: 90 } } }), ['switchThreshold']);
    assert.deepEqual(await fields({ ...SAVE, switchThreshold: { buckets: [] } }), ['switchThreshold.buckets']);
    assert.deepEqual(await fields({ ...SAVE, switchThreshold: { buckets: {} } }), ['switchThreshold.buckets']);
    assert.deepEqual(await fields('[]'), ['body']);
    assert.equal(calls.length, 0, 'nothing malformed reaches the writer');
  }, { hooks: { saveAccountLimits: hook } });
});

test('an oversized body is 413, a malformed one 400, and no hook is 501', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const huge = await post(port, JSON.stringify({ ...SAVE, pad: 'x'.repeat(70 * 1024) }));
    assert.equal(huge.status, 413);
    assert.deepEqual((await huge.json()).errors, [{ field: 'body', message: 'request body too large' }]);
    const broken = await post(port, '{"id": ');
    assert.equal(broken.status, 400);
    assert.equal(calls.length, 0);
  }, { hooks: { saveAccountLimits: hook } });
  await withServer(async (_am, port) => {
    assert.equal((await post(port, SAVE)).status, 501);
  });
});

test('the writer\'s refusals reach the caller as 404, 409 with current, and a sanitised 500', async () => {
  let answer = null;
  const fail = (code, message) => { answer = () => { throw Object.assign(new Error(message), { code }); }; };
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await withServer(async (_am, port) => {
      fail('no-such-account', 'no account with id "zz"');
      const missing = await post(port, { ...SAVE, id: 'zz' });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { ok: false, error: 'no such account' });

      fail('changed-elsewhere', 'stale');
      const conflict = await post(port, { ...SAVE, id: 'b1' });
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), {
        ok: false, error: 'changed elsewhere', current: { switchThreshold: null, maxUsage: { unified7d: 0.6 } },
      });

      fail('reload-failed', 'ENOENT: /home/someone/.config/teamclaude.json');
      const halfDone = await post(port, SAVE);
      assert.equal(halfDone.status, 500);
      assert.equal((await halfDone.json()).persisted, true);

      fail(undefined, 'EACCES writing /home/someone/.config/teamclaude.json');
      const failed = await post(port, SAVE);
      assert.equal(failed.status, 500);
      const body = await failed.json();
      assert.equal(body.persisted, false);
      assert.doesNotMatch(JSON.stringify(body), /home\/someone/);
      assert.ok(logged.some(line => line.includes('EACCES writing /home/someone')), logged.join(' | '));
    }, { hooks: { saveAccountLimits: async () => answer() } });
  } finally {
    console.error = realError;
  }
});

// Loopback is exempt from the key gate, so the gate itself needs a remote peer.
function remoteRequest(server, { headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/teamclaude/accounts/limits';
  req.headers = headers;
  req.socket = { remoteAddress: '203.0.113.9' };
  const res = {
    status: null,
    chunks: '',
    writeHead(status) { this.status = status; return this; },
    end(chunk) { if (chunk) this.chunks += chunk; this._done(); },
  };
  const finished = new Promise(resolve => { res._done = resolve; });
  server.emit('request', req, res);
  return finished.then(() => ({ status: res.status }));
}

// fetch() refuses to set Host, so the rebinding case uses http.request.
function postWithHost(port, host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/teamclaude/accounts/limits',
      headers: { host, 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the control-plane gates apply: key, cross-origin, DNS rebinding', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port, server) => {
    assert.equal((await remoteRequest(server, { body: JSON.stringify(SAVE) })).status, 401);
    assert.equal((await post(port, SAVE, { Origin: 'https://evil.example', 'x-api-key': 'tc-test' })).status, 403);
    assert.equal((await post(port, SAVE, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(await postWithHost(port, 'attacker.example', SAVE), 403);
    assert.equal(calls.length, 0, 'a refused request must not have written anything');

    assert.equal((await remoteRequest(server, { headers: { 'x-api-key': 'tc-test' }, body: JSON.stringify(SAVE) })).status, 200);
    assert.equal(calls.length, 1);
  }, { hooks: { saveAccountLimits: hook } });
});

// The writer index.js installs, over a spy config update and reload: a save
// touching both fields is exactly one update and one reload, in that order.
test('a combined threshold and cap save is one config update and one reload', async () => {
  const disk = { accounts: [{ id: 'a1', name: 'a', switchThreshold: 0.9 }] };
  const log = [];
  const update = async fn => { log.push('update'); const copy = JSON.parse(JSON.stringify(disk)); await fn(copy); Object.assign(disk, copy); return copy; };
  const reload = async () => { log.push('reload'); };
  const { applyChange } = createControlQueue(reload);
  const { saveAccountLimits } = createLimitWriters({ applyChange, reload, update, hasAccount: id => id === 'a1' });

  const stored = await saveAccountLimits({
    id: 'a1', expected: { switchThreshold: 0.9, maxUsage: null },
    switchThreshold: { pairs: [['default', 100]] }, maxUsage: { pairs: [['unified7d', 60]] },
  });
  assert.deepEqual(log, ['update', 'reload']);
  assert.deepEqual(stored, { switchThreshold: 1, maxUsage: { unified7d: 0.6 } });
  assert.deepEqual(disk.accounts[0], { id: 'a1', name: 'a', switchThreshold: 1, maxUsage: { unified7d: 0.6 } });

  // A conflict is the one update (which writes nothing) and the reload that
  // makes `current` fresh.
  log.length = 0;
  await assert.rejects(saveAccountLimits({
    id: 'a1', expected: { switchThreshold: 0.9, maxUsage: null }, switchThreshold: { reset: true }, maxUsage: { reset: true },
  }), { code: 'changed-elsewhere' });
  assert.deepEqual(log, ['update', 'reload']);
  assert.equal(disk.accounts[0].switchThreshold, 1);
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

async function withRealServer(accounts, fn, { upstreamPort } = {}) {
  const port = await closedPort();
  const dead = upstreamPort ?? await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-limits-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${dead}`,
    upstreamProxy: false,
    switchThreshold: 0.98,
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
  const save = body => fetch(`${base}/accounts/limits`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = async () => (await (await fetch(`${base}/status`)).json()).accounts;
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const editDisk = async edit => { const c = await disk(); edit(c); await writeFile(configPath, JSON.stringify(c)); };
  const limits = a => ({ switchThreshold: a.switchThreshold, maxUsage: a.maxUsage });

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { if ((await fetch(`${base}/status`)).ok) break; } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise(r => setTimeout(r, 100));
    }
    await fn({ save, status, disk, editDisk, limits, dir, base });
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.on('exit', r));
    clearTimeout(killer);
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

test('threshold and cap land together, apply without a restart, and touch only the named buckets', async () => {
  await withRealServer([
    { name: 'claude@example.com', type: 'apikey', apiKey: 'k1', maxUsage: { unified7dFable: 0.8 } },
    { name: 'claude@example.com', type: 'apikey', apiKey: 'k2' },
  ], async ({ save, status, disk, limits }) => {
    const [first, second] = await status();
    assert.ok(first.id && second.id && first.id !== second.id);

    const res = await save({
      id: second.id,
      expected: limits(second),
      switchThreshold: { buckets: { default: 100 } },
      maxUsage: { buckets: { unified7d: 60, unified5h: '99.5' } },
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, switchThreshold: 1, maxUsage: { unified7d: 0.6, unified5h: 0.995 } });
    const onDisk = (await disk()).accounts;
    assert.equal(onDisk[1].switchThreshold, 1, 'only default left is stored as a number');
    assert.deepEqual(onDisk[1].maxUsage, { unified7d: 0.6, unified5h: 0.995 });
    assert.equal(onDisk[0].switchThreshold, undefined, 'the same-name account is untouched');
    const [, live] = await status();
    assert.deepEqual(limits(live), { switchThreshold: 1, maxUsage: { unified7d: 0.6, unified5h: 0.995 } });

    // A stored key outside the edit survives; clearing one removes only it.
    const kept = await save({
      id: first.id, expected: limits(first), maxUsage: { buckets: { unified7d: 50 } },
    });
    assert.equal(kept.status, 200, await kept.clone().text());
    assert.deepEqual((await disk()).accounts[0].maxUsage, { unified7dFable: 0.8, unified7d: 0.5 });
    const [afterKeep] = await status();
    const cleared = await save({
      id: first.id,
      expected: { maxUsage: afterKeep.maxUsage, switchThreshold: null },
      maxUsage: { buckets: { unified7d: null, unified7dFable: null } },
    });
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn((await disk()).accounts[0], 'maxUsage'), false, 'no keys left deletes the field');

    // Reset on both removes both keys in one write.
    const [, beforeReset] = await status();
    const reset = await save({
      id: second.id, expected: limits(beforeReset), switchThreshold: { reset: true }, maxUsage: { reset: true },
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true, switchThreshold: null, maxUsage: null });
    const row = (await disk()).accounts[1];
    assert.equal(Object.hasOwn(row, 'switchThreshold') || Object.hasOwn(row, 'maxUsage'), false);
  });
});

test('an unknown id is 404, a stale expected is 409 with current, and neither writes', async () => {
  await withRealServer([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1', switchThreshold: { default: 0.9, unified7d: 0.8 } },
  ], async ({ save, status, disk, editDisk, limits }) => {
    const [a] = await status();
    const before = JSON.stringify(await disk());
    const missing = await save({ id: 'no-such-id', expected: limits(a), switchThreshold: { buckets: { default: 95 } } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { ok: false, error: 'no such account' });
    assert.equal(JSON.stringify(await disk()), before);

    // Key order is not a change.
    const reordered = { switchThreshold: { unified7d: 0.8, default: 0.9 }, maxUsage: null };
    const ok = await save({ id: a.id, expected: reordered, switchThreshold: { buckets: { unified7d: 85 } } });
    assert.equal(ok.status, 200, await ok.clone().text());

    // Someone edits the file by hand; the page still holds the old values.
    await editDisk(c => { c.accounts[0].maxUsage = 0.7; });
    const snapshot = JSON.stringify(await disk());
    const stale = await save({
      id: a.id, expected: { switchThreshold: { default: 0.9, unified7d: 0.85 }, maxUsage: null },
      switchThreshold: { buckets: { default: 100 } },
    });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.error, 'changed elsewhere');
    assert.equal(JSON.stringify(await disk()), snapshot, 'a conflict writes nothing');
    // Read after a reload, so it is what the next status shows.
    const [fresh] = await status();
    assert.deepEqual(body.current, limits(fresh));
    assert.equal(body.current.maxUsage, 0.7);
  });
});

test('an out-of-range hand edit still saves when expected is what status shows', async () => {
  await withRealServer([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1', switchThreshold: { default: 1, unified7d: 98 } },
  ], async ({ save, status, disk, limits }) => {
    const [a] = await status();
    assert.deepEqual(a.switchThreshold, { default: 1 }, 'status drops the out-of-range entry');
    const res = await save({ id: a.id, expected: limits(a), switchThreshold: { buckets: { unified5h: 90 } } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await disk()).accounts[0].switchThreshold, { default: 1, unified7d: 98, unified5h: 0.9 });
    // The reply is the stored value, untouched bad key included; status still drops it.
    assert.deepEqual(await res.json(), { ok: true, switchThreshold: { default: 1, unified7d: 98, unified5h: 0.9 }, maxUsage: null });
    assert.deepEqual((await status())[0].switchThreshold, { default: 1, unified5h: 0.9 });
  });
});

// The LAN relay forwards `expected` with only `default` and known bucket keys,
// so a typo key on disk must not turn every save into a 409, and it stays put.
test('an unknown key on disk is ignored by the precondition and left untouched', async () => {
  await withRealServer([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1', maxUsage: { unified7d: 0.6, weekly: 0.5 } },
  ], async ({ save, status, disk, limits }) => {
    const [a] = await status();
    assert.deepEqual(a.maxUsage, { unified7d: 0.6, weekly: 0.5 });
    // As the LAN relay sends it: the unknown key dropped.
    const relayed = await save({
      id: a.id, expected: { switchThreshold: null, maxUsage: { unified7d: 0.6 } }, maxUsage: { buckets: { unified5h: 70 } },
    });
    assert.equal(relayed.status, 200, await relayed.clone().text());
    assert.deepEqual((await disk()).accounts[0].maxUsage, { unified7d: 0.6, weekly: 0.5, unified5h: 0.7 });
    // As the page sends it: whatever status showed, unknown key included.
    const [after] = await status();
    const direct = await save({ id: a.id, expected: limits(after), maxUsage: { buckets: { unified5h: null } } });
    assert.equal(direct.status, 200, await direct.clone().text());
    assert.deepEqual((await disk()).accounts[0].maxUsage, { unified7d: 0.6, weekly: 0.5 });
    // A known key that differs is still a conflict.
    const stale = await save({
      id: a.id, expected: { switchThreshold: null, maxUsage: { unified7d: 0.5 } }, maxUsage: { buckets: { unified5h: 70 } },
    });
    assert.equal(stale.status, 409);
  });
});

test('a reload that fails after the write is 500 persisted, a write that fails is 500 not persisted', async () => {
  await withRealServer([
    { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
  ], async ({ save, status, disk, editDisk, limits, dir }) => {
    const [a] = await status();
    // A schedule the warmer refuses makes the reload throw after the write lands.
    await editDisk(c => { c.warmupSchedule = { resetTime: 'never' }; });
    const halfDone = await save({
      id: a.id, expected: limits(a), switchThreshold: { buckets: { default: 100 } }, maxUsage: { buckets: { default: 60 } },
    });
    assert.equal(halfDone.status, 500);
    assert.equal((await halfDone.json()).persisted, true);
    const row = (await disk()).accounts[0];
    assert.equal(row.switchThreshold, 1);
    assert.equal(row.maxUsage, 0.6);

    await editDisk(c => { delete c.warmupSchedule; });
    if (process.getuid?.() === 0) return; // root ignores the directory mode below
    const before = JSON.stringify(await disk());
    await chmod(dir, 0o500);
    try {
      const failed = await save({
        id: a.id, expected: { switchThreshold: 1, maxUsage: 0.6 },
        switchThreshold: { buckets: { default: 90 } }, maxUsage: { buckets: { default: 50 } },
      });
      assert.equal(failed.status, 500);
      assert.equal((await failed.json()).persisted, false);
    } finally {
      await chmod(dir, 0o700);
    }
    assert.equal(JSON.stringify(await disk()), before, 'neither field changed');
  });
});

// An upstream that answers every message with 95% of the weekly quota used and
// says which account's key it saw, so a test can watch the router choose.
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

test('after a 200 the next routing decision uses the account\'s new threshold', async () => {
  const upstream = await recordingUpstream();
  try {
    await withRealServer([
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    ], async ({ save, status, limits, base }) => {
      const send = async () => {
        const res = await fetch(`${base.replace('/teamclaude', '')}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        await res.text();
        return upstream.keys.at(-1);
      };
      // 95% is under the fleet's 98%, so both accounts take traffic.
      for (let i = 0; i < 3; i++) await send();
      assert.ok(upstream.keys.includes('k1') && upstream.keys.includes('k2'), upstream.keys.join());
      const [a] = await status();
      const res = await save({ id: a.id, expected: limits(a), switchThreshold: { buckets: { default: 90 } } });
      assert.equal(res.status, 200, await res.clone().text());
      // The first account's own 90% is now behind it: no restart, and nothing
      // more goes to it.
      for (let i = 0; i < 3; i++) assert.equal(await send(), 'k2');
    }, { upstreamPort: upstream.port });
  } finally {
    upstream.close();
  }
});

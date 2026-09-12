import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/routes/override is the dashboard's Force dialog: it writes a
// route's `override` to the CONFIG and then applies it, which is what separates
// it from /switch (a runtime preference) and from a TUI pin (runtime only). The
// writing itself lives behind hooks.saveOverride in index.js. The first half of
// this file tests the endpoint against a stub hook — the gates it inherits, the
// shape it accepts, how each of the writer's refusals reaches the caller — and
// the second half drives the real CLI as a subprocess, where the config file on
// disk is the witness.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
];
const ROUTES = [{ name: 'bulk', match: ['*opus*'] }];
// What the dashboard reads off the row it is looking at.
const EXPECTED = { match: ['*opus*'], accounts: ['alice@example.com', 'bob@example.com'], persisted: null };
const FORCE = { route: 'bulk', expected: EXPECTED, account: 'bob@example.com', whenSpent: 'fallback' };

async function withServer(fn, { hooks = {}, accounts = ACCTS, config = CONFIG } = {}) {
  const am = new AccountManager(accounts, 0.98, { routes: ROUTES });
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port, proxy);
  } finally {
    proxy.close();
  }
}

// A hook that records what it was handed and answers however the test needs.
function recorder(answer = async () => ({ warnings: [] })) {
  const calls = [];
  return {
    calls,
    hook: async (payload) => { calls.push(payload); return answer(payload); },
  };
}

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/routes/override`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('a same-origin dashboard POST forces the route and clears it again', async () => {
  const { calls, hook } = recorder();
  await withServer(async (am, port) => {
    const browser = { 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}` };
    const forced = await post(port, FORCE, browser);
    assert.equal(forced.status, 200);
    const body = await forced.json();
    assert.equal(body.ok, true);
    assert.equal(body.persisted, true);
    assert.equal(body.applied, true);
    assert.deepEqual(body.warnings, []);
    // The row is the same object /teamclaude/status carries, so the page can
    // render the answer without waiting for the next poll.
    assert.equal(body.row.id, 'configured:bulk');
    assert.deepEqual(body.row.members, ['alice@example.com', 'bob@example.com']);
    assert.deepEqual(calls[0], {
      route: 'bulk', expected: EXPECTED, override: { account: 'bob@example.com', whenSpent: 'fallback' },
    });

    const cleared = await post(port, { route: 'bulk', expected: EXPECTED, clear: true }, browser);
    assert.equal(cleared.status, 200);
    // A clear is `override: null` — the one signal the writer needs to delete
    // the field rather than write it.
    assert.equal(calls[1].override, null);
  }, { hooks: { saveOverride: hook } });
});

test('warnings from the reloaded table are handed back', async () => {
  const { hook } = recorder(async () => ({ warnings: ['route "bulk": bucket "weekly" is not one of unified7d'] }));
  await withServer(async (_am, port) => {
    const body = await (await post(port, FORCE)).json();
    assert.deepEqual(body.warnings, ['route "bulk": bucket "weekly" is not one of unified7d']);
  }, { hooks: { saveOverride: hook } });
});

// Loopback is exempt from the proxy-key gate, which is what makes every
// fetch-based test above work, so the gate itself needs a remote peer.
function remoteRequest(server, { headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/teamclaude/routes/override';
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
  return finished.then(() => ({ status: res.status, body: JSON.parse(res.chunks || '{}') }));
}

test('a remote client needs the proxy key to force a route', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, _port, server) => {
    const refused = await remoteRequest(server, { body: JSON.stringify(FORCE) });
    assert.equal(refused.status, 401);
    assert.equal(calls.length, 0, 'a refused request must not have written anything');

    const keyed = await remoteRequest(server, { headers: { 'x-api-key': 'tc-test' }, body: JSON.stringify(FORCE) });
    assert.equal(keyed.status, 200);
    assert.equal(calls.length, 1);
  }, { hooks: { saveOverride: hook } });
});

// The control-plane CSRF rule, inherited whole: a page the operator happens to
// visit is "loopback" too, and forcing the fleet onto one account is a targeted
// quota drain — worth a no-cors POST to whoever wrote the page.
test('a cross-origin POST is refused even with a valid key, and Origin alone is enough to refuse', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const keyed = await post(port, FORCE, { Origin: 'https://evil.example', 'x-api-key': 'tc-test' });
    assert.equal(keyed.status, 403);
    assert.match((await keyed.json()).error, /cross-origin/);

    // No Sec-Fetch-Site: an Origin on a control POST means a page issued it, and
    // the fallback admits no page at all.
    const originOnly = await post(port, FORCE, { Origin: `http://127.0.0.1:${port}` });
    assert.equal(originOnly.status, 403);

    const crossSite = await post(port, FORCE, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.length, 0);
  }, { hooks: { saveOverride: hook } });
});

test('an oversized body is 413 and a malformed one 400, without echoing parser internals', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const huge = await post(port, JSON.stringify({ route: 'bulk', pad: 'x'.repeat(70 * 1024) }));
    assert.equal(huge.status, 413);
    assert.deepEqual((await huge.json()).errors, [{ field: 'body', message: 'request body too large' }]);

    const broken = await post(port, '{"route": ');
    assert.equal(broken.status, 400);
    assert.deepEqual((await broken.json()).errors, [{ field: 'body', message: 'invalid request body' }]);
    assert.equal(calls.length, 0);
  }, { hooks: { saveOverride: hook } });
});

test('every rejected field is named', async () => {
  const { calls, hook } = recorder();
  await withServer(async (_am, port) => {
    const fields = async body => (await (await post(port, body)).json()).errors.map(e => e.field);

    assert.deepEqual(await fields({}), ['route', 'account', 'whenSpent', 'expected']);
    assert.deepEqual(await fields({ ...FORCE, route: 'x'.repeat(257) }), ['route']);
    assert.deepEqual(await fields({ ...FORCE, whenSpent: 'forever' }), ['whenSpent']);
    assert.deepEqual(await fields({ ...FORCE, account: 42 }), ['account']);
    // A clear needs no target: the account and mode fields are not read.
    assert.deepEqual(await fields({ route: 'bulk', expected: { ...EXPECTED, match: 'opus' }, clear: true }), ['expected.match']);
    assert.deepEqual(await fields({ ...FORCE, expected: { ...EXPECTED, accounts: null } }), ['expected.accounts']);
    assert.deepEqual(await fields({ ...FORCE, expected: { match: [], accounts: [] } }), ['expected.persisted']);
    assert.deepEqual(await fields('[]'), ['body']);
    assert.equal(calls.length, 0, 'nothing malformed reaches the writer');
  }, { hooks: { saveOverride: hook } });
});

// A per-account `models` claim makes membership depend on the request's model,
// which is the one thing an override cannot express. Forcing is refused while
// one exists; clearing is not, because it only ever removes a constraint.
test('an account still claiming models blocks a force but not a clear', async () => {
  const { calls, hook } = recorder();
  const claiming = [{ ...ACCTS[0], models: ['*opus*'] }, ACCTS[1]];
  await withServer(async (_am, port) => {
    const blocked = await post(port, FORCE);
    assert.equal(blocked.status, 400);
    const errors = (await blocked.json()).errors;
    assert.equal(errors[0].field, 'route');
    assert.match(errors[0].message, /deprecated "models" setting/);
    assert.equal(calls.length, 0);

    const cleared = await post(port, { route: 'bulk', expected: EXPECTED, clear: true });
    assert.equal(cleared.status, 200);
    assert.equal(calls.length, 1);
  }, { hooks: { saveOverride: hook }, accounts: claiming });
});

test('the writer\'s refusals reach the caller as 404, 409 and a sanitised 500', async () => {
  // One hook, re-aimed before each call: what varies is the writer's answer, not
  // the request, and every one of these is a different reply for the same POST.
  let answer = null;
  const fail = (code, message) => { answer = () => { throw Object.assign(new Error(message), { code }); }; };
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await withServer(async (_am, port) => {
      // A name that is not a configured route — an auto fable/sonnet row's name
      // lands here too, which is the point: auto rows are not written down.
      fail('no-such-route', 'no route named "fable"');
      const notFound = await post(port, { ...FORCE, route: 'fable' });
      assert.equal(notFound.status, 404);
      assert.deepEqual(await notFound.json(), { ok: false, error: 'no such route' });

      fail('changed-elsewhere', 'the override changed');
      const conflict = await post(port, FORCE);
      assert.equal(conflict.status, 409);
      const conflictBody = await conflict.json();
      assert.equal(conflictBody.error, 'changed elsewhere');
      // The row as it is NOW, so the dialog can offer to adopt it.
      assert.equal(conflictBody.row.id, 'configured:bulk');

      // The write landed and only the apply failed: the operator needs a reload,
      // not a retry, and the reply has to tell those apart.
      fail('reload-failed', 'ENOENT: /home/someone/.config/teamclaude.json');
      const halfDone = await post(port, FORCE);
      assert.equal(halfDone.status, 500);
      assert.deepEqual(await halfDone.json(), {
        ok: false, persisted: true, applied: false, error: 'reload failed; see the proxy log',
      });

      fail(undefined, 'EACCES writing /home/someone/.config/teamclaude.json');
      const failed = await post(port, FORCE);
      assert.equal(failed.status, 500);
      const body = await failed.json();
      assert.deepEqual(body, {
        ok: false, persisted: false, applied: false, error: 'could not save the override; see the proxy log',
      });
      // The reason names a path on the operator's disk, and this endpoint is
      // reachable by anyone holding a client key.
      assert.doesNotMatch(JSON.stringify(body), /home\/someone/);
      assert.ok(errors.some(line => line.includes('EACCES writing /home/someone')), errors.join(' | '));
    }, { hooks: { saveOverride: async () => answer() } });
  } finally {
    console.error = realError;
  }
});

test('an installation without the writer answers 501 rather than pretending', async () => {
  await withServer(async (_am, port) => {
    assert.equal((await post(port, FORCE)).status, 501);
  });
});

// `whenSpent: 'hold'` says no account but the forced one may serve this route.
// So the fleet-wide retry-after and the holdSeconds wait are both measuring
// accounts the request may never use: the answer is immediate, and it is the
// forced account's own next known movement.
test('a held route answers 429 at once, with the forced account\'s retry-after', async () => {
  const now = Date.now();
  const am = new AccountManager([
    { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
  ], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], override: { account: 'alice@example.com', whenSpent: 'hold' } }],
  });
  // Rate-limited for two minutes, and recently enough that the exhausted-fleet
  // probe still honours the hold verbatim.
  Object.assign(am.accounts[0], { status: 'throttled', throttledAt: now, rateLimitedUntil: now + 120_000 });

  // A full hour of hold budget: if the held route ever entered that wait, this
  // test would sit here instead of answering.
  const proxy = createProxyServer(am, { ...CONFIG, holdSeconds: 3600 });
  const port = await listen(proxy);
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.ok(Date.now() - started < 5_000, 'a held route must not wait on holdSeconds');
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter > 100 && retryAfter <= 120, `expected ~120s, got ${retryAfter}`);
    const message = (await res.json()).error.message;
    assert.match(message, /Route "bulk" is held on account "alice@example\.com"/);
    // Bob is eligible and still may not serve it — say so, or the operator reads
    // this as an ordinary exhaustion and goes looking at quota.
    assert.match(message, /refuses every other account/);
  } finally {
    proxy.close();
  }
});

// Without a hold pin nothing changes: the same exhaustion still gets the
// fleet-wide retry-after and, where configured, the holdSeconds wait.
test('an exhausted fleet with no held route keeps the fleet-wide 429', async () => {
  const now = Date.now();
  const am = new AccountManager([{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }], 0.98);
  Object.assign(am.accounts[0], { status: 'throttled', throttledAt: now, rateLimitedUntil: now + 120_000 });
  const proxy = createProxyServer(am, CONFIG);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error.message, /No account can serve this request/);
  } finally {
    proxy.close();
  }
});

// ── the real writer ─────────────────────────────────────────
// Everything above stubs hooks.saveOverride. These drive the actual CLI against
// a throwaway TEAMCLAUDE_CONFIG, because the precondition, the disk edit and
// the reload are one sequence and only the file can say it ran in that order.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

// A port nothing is listening on: bind one, learn its number, give it back.
function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function withRealServer(fn) {
  const proxyPort = await closedPort();
  const deadPort = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-override-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${deadPort}`,
    upstreamProxy: false,
    accounts: [
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    ],
    routes: [{ name: 'bulk', match: ['*opus*'], color: 'cyan' }],
  }));

  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  const force = (body) => fetch(`http://127.0.0.1:${proxyPort}/teamclaude/routes/override`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const routesOnDisk = async () => JSON.parse(await readFile(configPath, 'utf8')).routes;
  const rowInStatus = async () => (await (await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).json())
    .routes.find(r => r.name === 'bulk');

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).ok) break; } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise(r => setTimeout(r, 100));
    }
    await fn({ force, routesOnDisk, rowInStatus });
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.on('exit', r));
    clearTimeout(killer);
    await rm(dirname(configPath), { recursive: true, force: true });
  }
}

test('the writer edits the config row, applies it, and clears it again', async () => {
  await withRealServer(async ({ force, routesOnDisk, rowInStatus }) => {
    const expected = { match: ['*opus*'], accounts: ['a@example.com', 'b@example.com'], persisted: null };

    const set = await force({ route: 'bulk', expected, account: 'b@example.com', whenSpent: 'hold' });
    assert.equal(set.status, 200, await set.clone().text());
    const body = await set.json();
    assert.equal(body.applied, true);
    assert.equal(body.row.override.account, 'b@example.com');
    assert.equal(body.row.override.whenSpent, 'hold');

    const [written] = await routesOnDisk();
    assert.equal(written.override.account, 'b@example.com');
    assert.equal(written.override.whenSpent, 'hold');
    assert.ok(Number.isFinite(written.override.since), 'the write is dated');
    // The rest of the operator's row is untouched: the normalised table is for
    // the comparison, never for writing back.
    assert.equal(written.color, 'cyan');
    assert.deepEqual(written.match, ['*opus*']);

    // Applied, not merely written: the running table forces the route too.
    const row = await rowInStatus();
    assert.equal(row.override.source, 'config');
    assert.deepEqual(row.persisted, { account: 'b@example.com', whenSpent: 'hold' });

    // Each part of `expected` is compared, and a stale one is a conflict rather
    // than an overwrite. The row now carries an override, so `persisted: null`
    // is the stale read a dashboard that polled before the force would send.
    const forced = { account: 'b@example.com', whenSpent: 'hold' };
    for (const stale of [
      { ...expected, persisted: null, match: ['*opus*'] },
      { match: ['*sonnet*'], accounts: expected.accounts, persisted: forced },
      { match: ['*opus*'], accounts: ['a@example.com'], persisted: forced },
    ]) {
      const conflict = await force({ route: 'bulk', expected: stale, account: 'a@example.com', whenSpent: 'fallback' });
      assert.equal(conflict.status, 409, JSON.stringify(stale));
      assert.equal((await conflict.json()).row.persisted.account, 'b@example.com', 'the answer carries the row as it is now');
    }
    // Order is not an edit: the same members in another order still apply.
    const reordered = await force({
      route: 'bulk',
      expected: { match: ['*opus*'], accounts: ['b@example.com', 'a@example.com'], persisted: forced },
      clear: true,
    });
    assert.equal(reordered.status, 200, await reordered.clone().text());
    assert.equal((await routesOnDisk())[0].override, undefined, 'a clear deletes the field');
    assert.equal((await rowInStatus()).override, null, 'and releases the running pin');

    // A name that is not a configured route — an auto fable/sonnet row's name
    // included, since those are never written down.
    for (const name of ['fable', 'no-such-route']) {
      const missing = await force({ route: name, expected, account: 'a@example.com', whenSpent: 'fallback' });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { ok: false, error: 'no such route' });
    }
  });
});

// Two Apply clicks (two tabs, or a dashboard and a script) reach the writer at
// once. They are one queue, so the second reads the first's write and is told
// its own precondition is stale — instead of both writing and the later one
// winning by accident.
test('concurrent writes are serialised: the second sees the first', async () => {
  await withRealServer(async ({ force, routesOnDisk }) => {
    const expected = { match: ['*opus*'], accounts: ['a@example.com', 'b@example.com'], persisted: null };
    const [first, second] = await Promise.all([
      force({ route: 'bulk', expected, account: 'a@example.com', whenSpent: 'fallback' }),
      force({ route: 'bulk', expected, account: 'b@example.com', whenSpent: 'hold' }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], `${await first.text()} | ${await second.text()}`);
    const written = (await routesOnDisk())[0].override;
    // Exactly one of them, whole: no half-applied mix of the two.
    assert.ok(
      (written.account === 'a@example.com' && written.whenSpent === 'fallback')
      || (written.account === 'b@example.com' && written.whenSpent === 'hold'),
      JSON.stringify(written),
    );
  });
});

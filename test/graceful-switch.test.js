import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, GRACEFUL_IDLE_MS } from '../src/account-manager.js';
import { SessionTracker } from '../src/session-tracker.js';
import { createProxyServer } from '../src/server.js';
import { setGracefulSwitch, ConfigOpError } from '../src/config-ops.js';

// Graceful switch (MRG-210): when an account crosses its switch threshold, a
// conversation that is mid-turn finishes there instead of moving with the
// fleet. New and idle conversations move at once, and every hard limit still
// applies.

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const quietly = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

// Two accounts, A current. `clock` drives the session tracker, which is where
// "mid-turn" is measured.
function fleet({ gracefulSwitch = true, accounts = [oauth('a'), oauth('b')], ...opts } = {}) {
  const clock = { now: 1_000_000 };
  const sessionTracker = new SessionTracker({ now: () => clock.now });
  const am = new AccountManager(accounts, 0.98, { gracefulSwitch, sessionTracker, ...opts });
  return { am, clock };
}

// One request of conversation `id`: selected, then recorded where it went.
function send(am, id, model = OPUS) {
  const account = quietly(() => am.getActiveAccount(null, model, null, id));
  if (account) am.recordSession(id, account.index, model);
  return account?.name ?? null;
}

// Account A crosses the 0.98 threshold with quota left.
const pastThreshold = am => Object.assign(am.accounts[0].quota, { unified7d: 0.99 });

test('off by default: a running conversation moves when its account crosses the threshold', () => {
  const { am } = fleet({ gracefulSwitch: false });
  assert.equal(send(am, 'conv'), 'a');
  pastThreshold(am);
  assert.equal(send(am, 'conv'), 'b');
});

test('on: a mid-turn conversation stays; a new one moves', () => {
  const { am, clock } = fleet();
  assert.equal(send(am, 'conv'), 'a');
  pastThreshold(am);
  clock.now += 30_000;
  assert.equal(send(am, 'conv'), 'a');
  assert.equal(send(am, 'new'), 'b');
  // The held conversation keeps finishing there while it keeps working.
  clock.now += GRACEFUL_IDLE_MS - 1;
  assert.equal(send(am, 'conv'), 'a');
  assert.equal(am.gracefulHoldCount(), 1);
  assert.equal(am.sessionStats().graceful, 1);
});

test('a conversation idle past the gap moves on its next request', () => {
  const { am, clock } = fleet();
  assert.equal(send(am, 'conv'), 'a');
  pastThreshold(am);
  clock.now += GRACEFUL_IDLE_MS + 1;
  assert.equal(send(am, 'conv'), 'b');
});

test('another request in flight counts as mid-turn however old the pin is', () => {
  const { am, clock } = fleet();
  assert.equal(send(am, 'conv'), 'a');
  pastThreshold(am);
  clock.now += 10 * GRACEFUL_IDLE_MS;
  am.sessionTracker.beginRequest('conv'); // a long stream still running
  am.sessionTracker.beginRequest('conv'); // the request now being routed
  assert.equal(send(am, 'conv'), 'a');
});

test('every hard limit ends the hold', () => {
  const cases = {
    'out of quota': a => Object.assign(a.quota, { unified7d: 1 }),
    'usage cap': a => { a.maxUsage = 0.99; },
    'upstream rejected': a => { a.quota.unifiedStatus = 'rejected'; },
    'rate-limit hold': a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; },
    disabled: a => { a.disabled = true; },
    error: a => { a.status = 'error'; },
    'refused routing': a => { a.routingRefused = true; },
  };
  for (const [what, apply] of Object.entries(cases)) {
    const { am, clock } = fleet();
    assert.equal(send(am, 'conv'), 'a', what);
    pastThreshold(am);
    apply(am.accounts[0]);
    clock.now += 1000;
    assert.equal(send(am, 'conv'), 'b', what);
  }
});

test('an account this request already tried is not held', () => {
  const { am, clock } = fleet();
  assert.equal(send(am, 'conv'), 'a');
  pastThreshold(am);
  clock.now += 1000;
  assert.equal(quietly(() => am.getActiveAccount(new Set([0]), OPUS, null, 'conv'))?.name, 'b');
});

test('holds under session distribution too', () => {
  const { am, clock } = fleet({ distributeSessions: true });
  const first = send(am, 'conv');
  const idx = am.accounts.findIndex(a => a.name === first);
  Object.assign(am.accounts[idx].quota, { unified7d: 0.99 });
  clock.now += 1000;
  assert.equal(send(am, 'conv'), first);
});

test('the pin is per weekly bucket: a Fable pin does not hold an Opus request', () => {
  const { am, clock } = fleet();
  assert.equal(send(am, 'conv', FABLE), 'a');
  Object.assign(am.accounts[0].quota, { unified7d: 0.99, unified7dFable: 0.5 });
  clock.now += 1000;
  // The Opus request has no pin of its own, so it routes as usual.
  assert.equal(send(am, 'conv', OPUS), 'b');
  // The Fable conversation, which is mid-turn on A, finishes there.
  assert.equal(send(am, 'conv', FABLE), 'a');
});

test('the setting is a strict boolean and reports whether it changed', () => {
  const config = {};
  assert.equal(setGracefulSwitch(config, true), true);
  assert.equal(config.gracefulSwitch, true);
  assert.equal(setGracefulSwitch(config, true), false);
  assert.equal(setGracefulSwitch(config, false), true);
  assert.equal(config.gracefulSwitch, false);
  assert.throws(() => setGracefulSwitch(config, 'on'), ConfigOpError);
});

test('POST /teamclaude/graceful saves through the hook and refuses a malformed body', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const calls = [];
  const hooks = { saveGracefulSwitch: async enabled => { calls.push(enabled); am.gracefulSwitch = enabled; } };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, hooks);
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const post = body => fetch(`http://127.0.0.1:${port}/teamclaude/graceful`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'tc-test' }, body: JSON.stringify(body),
  });
  try {
    const ok = await post({ enabled: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, gracefulSwitch: true });
    const bad = await post({ enabled: 'yes' });
    assert.equal(bad.status, 400);
    assert.deepEqual(calls, [true]);
  } finally {
    proxy.close();
  }
});

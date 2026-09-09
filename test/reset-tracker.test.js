import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResetTracker } from '../src/reset-tracker.js';
import { normalizeResetCredits, fetchCodexResetCredits } from '../src/codex-usage.js';
import { Prober } from '../src/prober.js';

const start = 1900000000000;
const reset = start + 86400000;
const a = { name: 'codex', provider: 'codex', accountId: 'account-1' };
const usage = (value, end = reset) => ({ sevenDay: { utilization: value, resetAt: end } });
const status = tracker => tracker.getStatus([a]);
const webhook = 'https://chat.googleapis.com/v1/spaces/test/messages?key=test-key&token=test-token';

for (const [type, end] of [['quota-refill', reset], ['restarted-window', reset + 86400000]]) {
  test(`${type} needs sustained evidence and retains the actual observation interval`, () => {
    const tracker = new ResetTracker();
    tracker.observe(a, usage(.94), { at: start });
    tracker.observe(a, usage(.02, end), { at: start + 300000 });
    assert.equal(status(tracker).events.length, 0);
    assert.equal(status(tracker).accounts[0].pending.length, 1);
    tracker.observe(a, usage(.04, end), { at: start + 600000 });
    const event = status(tracker).events[0];
    assert.equal(event.timing, 'early');
    assert.equal(event.windows[0].type, type);
    assert.equal(event.windows[0].before.at, start);
    assert.equal(event.windows[0].after.at, start + 300000);
    tracker.observe(a, usage(.04, end), { at: start + 900000 });
    assert.equal(status(tracker).events.length, 1);
  });
}

test('scheduled rollover can include more usage and never counts as an extra reset', () => {
  const tracker = new ResetTracker({ webhook });
  tracker.observe(a, usage(.01, start + 200000), { at: start });
  tracker.observe(a, usage(.10, reset), { at: start + 300000 });
  assert.equal(status(tracker).events[0].timing, 'scheduled');
  assert.equal(status(tracker).accounts[0].totals.early, 0);
  assert.equal(status(tracker).notifications.pending, 0);
});

test('corrections, missing windows, out-of-order probes, and long observation gaps do not count', () => {
  for (const sequence of [
    [[.94, 0], [.9, 300000], [.91, 600000]],
    [[.94, 0], [.02, 300000], [.94, 600000]],
    [[.94, 0], [.02, 4000000], [.03, 4300000]],
    [[.94, 0], [null, 300000], [.02, 600000]],
    [[.94, 300000], [.02, 0], [.03, 600000]],
  ]) {
    const tracker = new ResetTracker();
    for (const [value, delta] of sequence) tracker.observe(a, value === null ? {} : usage(value), { at: start + delta });
    assert.equal(status(tracker).events.length, 0);
  }
});

test('multiple windows are one account reset; providers and account identities stay separate', () => {
  const tracker = new ResetTracker();
  const both = value => ({ ...usage(value), fiveHour: { utilization: value, resetAt: reset } });
  tracker.observe(a, both(.94), { at: start });
  tracker.observe({ ...a, accountId: 'account-2' }, both(.01), { at: start + 300000 });
  tracker.observe(a, both(.02), { at: start + 300000 });
  tracker.observe(a, both(.03), { at: start + 600000 });
  assert.equal(status(tracker).events.length, 1);
  assert.equal(status(tracker).events[0].windows.length, 2);
  assert.equal(status(tracker).accounts[0].totals.early, 1);
});

test('pending detections and notification IDs survive restart; secrets stay out of state and status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reset-test-'));
  try {
    const stateFile = join(dir, 'resets.json');
    let tracker = new ResetTracker({ stateFile, webhook });
    tracker.observe(a, usage(.94), { at: start });
    tracker.observe(a, usage(.02), { at: start + 300000 });
    tracker = new ResetTracker({ stateFile, webhook });
    tracker.observe(a, usage(.03), { at: start + 600000 });
    let requestId;
    tracker.fetchFn = async url => { requestId = new URL(url).searchParams.get('messageId'); throw new Error('secret network details'); };
    await tracker.flush();
    assert.equal(status(tracker).notifications.pending, 1);
    tracker = new ResetTracker({ stateFile, webhook, now: () => Date.now() + 86400000, fetchFn: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('messageId'), requestId);
      assert.equal(options.redirect, 'error');
      assert.match(requestId, /^client-[a-z0-9-]{1,56}$/);
      return new globalThis.Response('', { status: 409 });
    } });
    await tracker.flush();
    assert.equal(status(tracker).notifications.pending, 0);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(stateFile, 'utf8') + JSON.stringify(status(tracker)), /test-key|test-token|secret network/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const credit = { id: 'credit-1', status: 'available', resetType: 'full', title: 'Full reset', expiresAt: reset, grantedAt: start };
test('banked inventory establishes a baseline, alerts on additions and expiry once, preserves stale values on errors', () => {
  const tracker = new ResetTracker({ webhook });
  tracker.observe(a, usage(.94), { at: start });
  tracker.observeCredits(a, { availableCount: 0, credits: [] }, start);
  tracker.observeCredits(a, { availableCount: 1, credits: [credit] }, start + 300000);
  assert.equal(status(tracker).notifications.pending, 2);
  tracker.observeCredits(a, { availableCount: 1, credits: [credit] }, start + 600000);
  assert.equal(status(tracker).notifications.pending, 2);
  tracker.observeCredits(a, { error: 'unavailable' }, start + 900000);
  assert.equal(status(tracker).accounts[0].credits.availableCount, 1);
  assert.equal(status(tracker).accounts[0].creditError, 'unavailable');
});

test('credit parser ignores purchase fields and rejects malformed inventories', async () => {
  const payload = { available_count: 1, credits: [{ id: '1', status: 'available', reset_type: 'full', expires_at: new Date(reset).toISOString() }], immediate_reset_purchase_eligible: true };
  const result = normalizeResetCredits(payload);
  assert.equal(result.availableCount, 1);
  assert.equal(result.credits[0].expiresAt, reset);
  assert.equal(result.immediate_reset_purchase_eligible, undefined);
  assert.throws(() => normalizeResetCredits({ credits: [], available_count: -1 }));
  assert.throws(() => normalizeResetCredits({ ...payload, credits: [{ ...payload.credits[0], expires_at: 'invalid' }] }));
  await fetchCodexResetCredits({ ...a, type: 'oauth', credential: 'test' }, { fetchFn: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
    assert.equal(options.method || 'GET', 'GET');
    assert.equal(options.headers['ChatGPT-Account-Id'], a.accountId);
    return new globalThis.Response(JSON.stringify(payload));
  } });
  const refused = await fetchCodexResetCredits({ ...a, provider: 'anthropic', type: 'oauth', credential: 'test' }, { fetchFn: () => assert.fail('wrong provider') });
  assert.ok(refused.error);
});

test('probe failures and quota cache sweeps are not reset observations; credit failure does not fail quota', async () => {
  const account = { ...a, index: 0, type: 'oauth', credential: 'test' };
  const tracker = new ResetTracker({ now: () => start });
  let calls = 0;
  const manager = { accounts: [account], ensureTokenFresh: async () => {}, applyCodexUsageData: () => { calls++; } };
  const prober = new Prober(manager, { resetTracker: tracker, codexProbeFn: async () => usage(.94), creditsFn: async () => ({ error: 'unavailable' }) });
  await prober.probeAll();
  assert.equal(calls, 1);
  assert.equal(prober.getStatus().accounts[0].status, 'ok');
  prober.codexProbeFn = async () => ({ error: 'unavailable' });
  await prober.probeAll();
  assert.equal(status(tracker).accounts[0].windows.sevenDay.utilization, .94);
  assert.equal(status(tracker).events.length, 0);
});

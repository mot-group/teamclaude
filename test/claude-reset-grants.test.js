import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeResetGrants, manualResetCredits, claudeResetInventory } from '../src/claude-reset-grants.js';
import { normalizeUsagePayload, bankedResets } from '../src/oauth.js';
import { ResetTracker } from '../src/reset-tracker.js';
import { Prober } from '../src/prober.js';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const webhook = 'https://chat.googleapis.com/v1/spaces/test/messages?key=test-key&token=test-token';
const HOUR = 3600_000;
const start = Date.parse('2026-10-20T12:00:00Z');

// What the OAuth usage endpoint answers today with ?cedar_ember=1: the account
// holds a banked reset on claude.ai, but the grant is not listed to this token.
const hidden = { eligible: false, ineligible_reason: 'surface', at_limit: false, exhausted: [], grants: [], next_grant_id: null };

test('a usage payload without cedar_ember carries no grant section; an ineligible one records its reason', () => {
  assert.equal(normalizeUsagePayload({ five_hour: { utilization: 10 } }).resetGrants, null);
  assert.equal(normalizeUsagePayload({ five_hour: { utilization: 10 }, cedar_ember: null }).resetGrants, null);
  assert.deepEqual(normalizeUsagePayload({ cedar_ember: hidden }).resetGrants, { eligible: false, reason: 'surface', credits: [] });
});

// The live shape (see LIVE_BLOCK in claude-banked-resets.test.js): one credit
// per reset left, titled by its label, expiring at ends_at.
test('listed grants become one available credit per reset left; spent, malformed and ineligible ones give none', () => {
  const starts = Date.parse('2026-10-08T00:00:00Z');
  const ends = Date.parse('2026-10-22T07:00:00Z');
  const grants = normalizeClaudeResetGrants({ eligible: true, grants: [
    { id: 'spend-handle', label: 'Explore Opus 5.5', resets_left: 2, starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-22T07:00:00Z', usable_now: true, paused: false },
    { id: 'spent-handle', label: 'Spent', resets_left: 0, ends_at: '2026-10-22T07:00:00Z' },
    { label: 'no count' },
    null,
  ] });
  assert.equal(grants.eligible, true);
  assert.equal(grants.credits.length, 2);
  assert.deepEqual(grants.credits[0], {
    id: `oauth:${starts}:${ends}:0`, status: 'available', resetType: 'limit reset', title: 'Explore Opus 5.5',
    grantedAt: starts, expiresAt: ends, source: 'oauth',
  });
  assert.equal(grants.credits[1].id, `oauth:${starts}:${ends}:1`);
  assert.ok(!JSON.stringify(grants).includes('handle'), 'the grant id, which spends a reset, is never kept');
  const ineligible = normalizeClaudeResetGrants({ eligible: false, ineligible_reason: 'surface', grants: [{ label: 'x', resets_left: 1 }] });
  assert.deepEqual(ineligible, { eligible: false, reason: 'surface', credits: [] });
});

test('one source at a time: listed grants, else manual entries, else the grants last listed', () => {
  const listed = normalizeClaudeResetGrants({ eligible: true, grants: [{ label: 'Explore Opus 5.5', resets_left: 1, ends_at: '2026-10-22T07:00:00Z' }] });
  const manual = [{ expiresAt: '2026-10-25', title: 'Recorded by hand' }];
  const inv = claudeResetInventory(listed, manual, start);
  assert.equal(inv.availableCount, 1, 'one reset, not one per source');
  assert.equal(inv.credits[0].source, 'oauth');
  // The endpoint turns ineligible (say a raised cli_version floor), probe after probe.
  const ineligible = normalizeClaudeResetGrants({ eligible: false, ineligible_reason: 'cli_version', grants: [] });
  let carried = inv;
  for (let i = 0; i < 3; i++) carried = claudeResetInventory(ineligible, null, start, carried);
  assert.deepEqual(carried.oauth, { eligible: false, reason: 'cli_version' }, 'the ineligible answer is recorded, so the Resets view says so');
  assert.deepEqual(carried.credits.map(c => c.source), ['oauth'], 'with nothing recorded by hand, the grants last listed stand in');
  const recorded = claudeResetInventory(ineligible, manual, start, carried);
  assert.deepEqual(recorded.credits.map(c => c.title), ['Recorded by hand'], 'manual entries replace them');
  assert.equal(recorded.availableCount, 1);
  assert.equal(claudeResetInventory(normalizeClaudeResetGrants(hidden), manual, start).credits[0].source, 'manual', 'never listed: the manual entry counts');
});

test('the reset tracker and the status line count the same resets from one block', () => {
  const grant = (extra) => ({ label: 'Explore Opus 5.5', starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-22T07:00:00Z', usable_now: true, paused: false, ...extra });
  const blocks = [
    { eligible: true, grants: [grant({ resets_left: 1 })] },
    { eligible: true, grants: [grant({ resets_left: 2 }), grant({ resets_left: 0 })] },
    { eligible: true, grants: [grant({ resets_left: 1, ends_at: '2026-10-01T00:00:00Z' })] },
    { eligible: true, grants: [grant({ resets_left: 1, paused: true })] },
    { eligible: true, grants: [] },
    hidden,
  ];
  for (const block of blocks) {
    assert.equal(claudeResetInventory(normalizeClaudeResetGrants(block), null, start).availableCount, bankedResets(block, start)?.available ?? 0, JSON.stringify(block));
  }
});

test('a manual entry with a bare date expires at the start of that day, local time; unreadable entries are skipped', () => {
  const credits = manualResetCredits([
    { expiresAt: '2026-10-22', title: 'Explore Opus 5.5' },
    { expiresAt: 'not a date' },
    { title: 'missing expiry' },
    { expiresAt: '2026-02-30' },
    { expiresAt: '2026-13-01' },
    'junk',
  ]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].expiresAt, new Date(2026, 9, 22).getTime());
  assert.equal(credits[0].source, 'manual');
  assert.equal(credits[0].status, 'available');
  assert.deepEqual(manualResetCredits(undefined), []);
});

test('the inventory merges both sources and counts only unexpired available credits', () => {
  const inv = claudeResetInventory(normalizeClaudeResetGrants(hidden), [
    { expiresAt: '2026-10-22T00:00:00Z' },
    { expiresAt: '2026-10-01T00:00:00Z', title: 'already gone' },
  ], start);
  assert.equal(inv.credits.length, 2);
  assert.equal(inv.availableCount, 1);
  assert.deepEqual(inv.oauth, { eligible: false, reason: 'surface' });
  assert.equal(claudeResetInventory(null, null, start).oauth, null);
});

function probeHarness(account, now) {
  const tracker = new ResetTracker({ webhook, now: () => now.value });
  const manager = { accounts: [account], ensureTokenFresh: async () => {}, applyUsageData: () => {} };
  const usage = { fiveHour: { utilization: .2, resetAt: now.value + 3 * HOUR }, sevenDay: { utilization: .3, resetAt: now.value + 5 * 24 * HOUR },
    resetGrants: normalizeClaudeResetGrants(hidden) };
  const prober = new Prober(manager, { resetTracker: tracker, probeFn: async () => usage });
  return { tracker, prober };
}

test('the Claude probe feeds manual banked resets to the tracker: one expiry alert, one availability alert for a new entry', async () => {
  const now = { value: start };
  const account = { name: 'claude-main', index: 0, type: 'oauth', credential: 'test', bankedResets: [{ expiresAt: '2026-10-22T06:00:00Z', title: 'Explore Opus 5.5' }] };
  const { tracker, prober } = probeHarness(account, now);

  await prober.probeAll();
  const row = tracker.getStatus([account]).accounts[0];
  assert.equal(row.credits.availableCount, 1);
  assert.deepEqual(row.credits.oauth, { eligible: false, reason: 'surface' });
  // The baseline sends nothing for an entry that is not near expiry yet.
  assert.equal(tracker.state.outbox.length, 0);

  // Inside the last 24 hours: exactly one expiry alert, however often it probes.
  now.value = Date.parse('2026-10-21T07:00:00Z');
  await prober.probeAll();
  now.value += 10 * 60_000;
  await prober.probeAll();
  assert.equal(tracker.state.outbox.length, 1);
  assert.match(tracker.state.outbox[0].text, /claude-main: banked reset expires within 24 hours\. Explore Opus 5\.5/);

  // An entry added after the baseline is announced once.
  account.bankedResets = [...account.bankedResets, { expiresAt: '2026-11-30', title: 'Second one' }];
  now.value += 10 * 60_000;
  await prober.probeAll();
  assert.equal(tracker.state.outbox.length, 2);
  assert.match(tracker.state.outbox[1].text, /claude-main: banked reset available\. Second one\./);
});

test('a bankedResets edit on disk reaches the running account on reload, and its removal clears it', async () => {
  const config = [{ id: 'a1', name: 'claude-main', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + HOUR }];
  const am = new AccountManager(config.map(a => ({ ...a })), 0.98);
  assert.equal(am.accounts[0].bankedResets, null);

  const entry = [{ expiresAt: '2026-10-22', title: 'Explore Opus 5.5' }];
  await syncAccountsFromDisk({ accounts: [{ ...config[0], bankedResets: entry }] }, { accounts: config }, am);
  assert.deepEqual(am.accounts[0].bankedResets, entry);
  assert.deepEqual(config[0].bankedResets, entry, 'the in-memory config entry mirrors the disk edit');

  await syncAccountsFromDisk({ accounts: [{ ...config[0], bankedResets: undefined }] }, { accounts: config }, am);
  assert.equal(am.accounts[0].bankedResets, null);
  assert.equal('bankedResets' in config[0], false);
});

test('a response without a cedar_ember section keeps the grants seen before, so their return is not announced again', async () => {
  const now = { value: start };
  const account = { name: 'claude-main', index: 0, type: 'oauth', credential: 'test' };
  const { tracker, prober } = probeHarness(account, now);
  const listed = normalizeClaudeResetGrants({ eligible: true, grants: [{ label: 'Explore Opus 5.5', resets_left: 1, ends_at: '2026-11-30T00:00:00Z' }] });
  const usage = { fiveHour: { utilization: .2, resetAt: start + 3 * HOUR }, sevenDay: { utilization: .3, resetAt: start + 5 * 24 * HOUR } };
  prober.probeFn = async () => ({ ...usage, resetGrants: listed });
  await prober.probeAll();
  prober.probeFn = async () => ({ ...usage, resetGrants: null });
  now.value += 10 * 60_000;
  await prober.probeAll();
  assert.equal(tracker.getStatus([account]).accounts[0].credits.availableCount, 1, 'the grant is still held');
  prober.probeFn = async () => ({ ...usage, resetGrants: listed });
  now.value += 10 * 60_000;
  await prober.probeAll();
  assert.equal(tracker.state.outbox.length, 0, 'no false "available" alert when the section comes back');
});

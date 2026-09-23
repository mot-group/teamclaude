import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeResetGrants, manualResetCredits, claudeResetInventory } from '../src/claude-reset-grants.js';
import { normalizeUsagePayload } from '../src/oauth.js';
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

test('listed grants become available credits with id, title, type and expiry; malformed ones are skipped', () => {
  const grants = normalizeClaudeResetGrants({ eligible: true, grants: [
    { id: 'g1', title: 'Explore Opus 5.5', reset_type: 'weekly', expires_at: '2026-10-22T07:00:00Z', granted_at: 1790000000 },
    { title: 'no id' },
    null,
  ] });
  assert.equal(grants.eligible, true);
  assert.equal(grants.credits.length, 1);
  assert.deepEqual(grants.credits[0], {
    id: 'oauth:g1', status: 'available', resetType: 'weekly', title: 'Explore Opus 5.5',
    grantedAt: 1790000000_000, expiresAt: Date.parse('2026-10-22T07:00:00Z'), source: 'oauth',
  });
});

test('a manual entry with a bare date expires at the start of that day, local time; unreadable entries are skipped', () => {
  const credits = manualResetCredits([
    { expiresAt: '2026-10-22', title: 'Explore Opus 5.5' },
    { expiresAt: 'not a date' },
    { title: 'missing expiry' },
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

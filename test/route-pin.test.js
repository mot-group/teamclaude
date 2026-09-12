import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Ephemeral per-route manual pins (distinct from the keep-warm account pin in
// account-pin.test.js): a pin biases selection for a route's models while the
// pinned account is eligible, and falls back to best-available otherwise.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('a route pin biases getActiveAccount toward the pinned account for matching models', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  // Without a pin, selection lands on the default (index 0).
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');

  assert.deepEqual(am.setRoutePin('configured:bulk', 1), { ok: true });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b'); // pin wins
  // A model the route does NOT match is unaffected by the pin.
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'a');
});

test('a pinned account that is ineligible falls back to best-available', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('configured:bulk', 1);
  // b's shared 5h bucket is spent → ineligible for everything.
  am.accounts[1].quota.unified5h = 0.999;
  am.accounts[1].quota.unified5hReset = Date.now() + 3600_000;

  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a'); // fell back
});

test('setRoutePin rejects an account the route does not allow', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['a'] }], // only a
  });
  const res = am.setRoutePin('configured:bulk', 1); // b is not in the route
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not allow/);
  assert.equal(am.getRoutePin('configured:bulk'), null);
});

test('an auto fable route is pinnable by its family name', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) { acc.quota.unified7dFable = 0.1; acc.quota.unified7dFableReset = Date.now() + 3600_000; }
  assert.ok(am.getRoutes().some(r => r.name === 'fable' && r.autocreated), 'auto fable route detected');

  assert.deepEqual(am.setRoutePin('auto:fable', 1), { ok: true });
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'b');
  assert.equal(am.getRoutes().find(r => r.name === 'fable').pinned, 'b');
});

test('clearRoutePin removes the bias', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('configured:bulk', 1);
  am.clearRoutePin('configured:bulk');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');
});

test('removing an account keeps route pins pointing at the right account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('configured:bulk', 2);        // pin c
  am.removeAccount(0);              // drop a → indices shift down
  assert.equal(am.getRoutePin('configured:bulk')?.name, 'c'); // still c, now at index 1

  am.removeAccount(am.accounts.findIndex(x => x.name === 'c')); // remove the pinned account
  assert.equal(am.getRoutePin('configured:bulk'), null);       // pin dropped
});

test('reloading routes drops pins for routes that no longer exist', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('configured:bulk', 1);
  am.setRoutes([{ name: 'other', match: ['*haiku*'] }]); // 'bulk' gone
  assert.equal(am.getRoutePin('configured:bulk'), null);
});

// ── force: hold and fallback ────────────────────────────────

const H = 3600_000;
const spend = (account, at = Date.now() + H) => {
  account.quota.unified5h = 0.999;
  account.quota.unified5hReset = at;
};

function forced(whenSpent, { names = ['a', 'b'], accounts } = {}) {
  return new AccountManager(names.map(n => oauth(n)), 0.98, {
    routes: [{
      name: 'bulk', match: ['*opus*'], ...(accounts && { accounts }),
      override: { account: 'b', whenSpent, since: 1789189000000 },
    }],
  });
}

test('a config override forces the route and is re-seeded on every reload', () => {
  const am = forced('fallback');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b');
  assert.deepEqual(am.routePins.get('configured:bulk'),
    { index: 1, whenSpent: 'fallback', source: 'config', lastServed: 1 });

  // The file stops forcing → so does the runtime, without a restart.
  am.setRoutes([{ name: 'bulk', match: ['*opus*'] }]);
  assert.equal(am.getRoutePin('configured:bulk'), null);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');
});

test('hold bars every other member and yields nothing when the forced account is spent', () => {
  const am = forced('hold');
  spend(am.accounts[1]);
  assert.equal(am._routeAllows(am.accounts[0], 'claude-opus-4'), false, 'a is barred while b holds');
  assert.equal(am._routeAllows(am.accounts[1], 'claude-opus-4'), true);
  // The exhausted-fleet probe still spends its slot on the forced account —
  // that is the one account whose quota is worth re-learning. Once the slot is
  // used, selection returns nothing and the caller answers the 429.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b', 'only the forced account is probed');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4'), null, 'no account may serve a held route');
  // Other models are untouched by this route's hold.
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'a');
});

test('hold never widens membership', () => {
  // b is forced but is NOT in the route's member list, which still refuses it.
  const am = forced('hold', { accounts: ['a'] });
  assert.equal(am.routePins.get('configured:bulk'), undefined, 'the override was refused as a non-member');
  assert.equal(am._routeAllows(am.accounts[1], 'claude-opus-4'), false);
});

test('holdRetryAfterMs is the earliest known future stamp on the forced account', () => {
  const now = Date.now();
  const am = forced('hold');
  assert.equal(am.holdRetryAfterMs('claude-opus-4', now), null, 'nothing known yet');

  am.accounts[1].quota.unified7dReset = now + 5 * H;
  am.accounts[1].quota.unified5hReset = now + 2 * H;
  am.accounts[1].rateLimitedUntil = now + 3 * H;
  assert.equal(am.holdRetryAfterMs('claude-opus-4', now), 2 * H);
  am.accounts[1].rateLimitedUntil = now + H / 2;
  assert.equal(am.holdRetryAfterMs('claude-opus-4', now), H / 2);
  // A stamp already in the past says nothing about the next recheck.
  am.accounts[1].rateLimitedUntil = now - H;
  assert.equal(am.holdRetryAfterMs('claude-opus-4', now), 2 * H);
  // Only a held route gets one.
  assert.equal(am.holdRetryAfterMs('claude-sonnet-4-6', now), null);
});

test('holdRetryAfterMs reads the scoped weekly window governing the model', () => {
  const now = Date.now();
  const am = forced('hold');
  am.accounts[1].quota.scopedWeekly = { opus: { utilization: 1, resetAt: now + 6 * H } };
  assert.equal(am.holdRetryAfterMs('claude-opus-4', now), 6 * H);
});

test('fallback runs the normal walk, session affinity included', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    distributeSessions: true,
    routes: [{ name: 'bulk', match: ['*opus*'], override: { account: 'a', whenSpent: 'fallback' } }],
  });
  // The session lives on b; while a can serve, the force outranks the affinity.
  am.recordSession('s1', 1);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4', null, 's1').name, 'a');
  // a spent → the walk resumes, and the session goes back to the account whose
  // cache it built rather than to whatever the cursor names.
  spend(am.accounts[0]);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4', null, 's1').name, 'b');
});

test('fallback honours a session affinity the request has not excluded', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    distributeSessions: true,
    routes: [{ name: 'bulk', match: ['*opus*'], override: { account: 'a', whenSpent: 'fallback' } }],
  });
  am.recordSession('s1', 2); // this session's cache is on c
  // a is forced but excluded by this request (it just failed upstream), so the
  // walk runs — and it must find the session's own account, not b.
  assert.equal(am.getActiveAccount(new Set([0]), 'claude-opus-4', null, 's1').name, 'c');
});

test('returning to the forced account re-arms the ramp exactly once', () => {
  const am = forced('fallback');
  am.ramp = { enabled: true, windowMs: 60_000, floor: 1 };
  const pin = am.routePins.get('configured:bulk');

  am.getActiveAccount(null, 'claude-opus-4');
  const first = am.accounts[1].rampStartedAt;
  assert.ok(first, 'the first request onto the forced account joins the ramp');
  am.getActiveAccount(null, 'claude-opus-4');
  assert.equal(am.accounts[1].rampStartedAt, first, 'a steady stream does not restart it');

  // Served from elsewhere, then back: the return is a join like any other.
  spend(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');
  assert.equal(pin.lastServed, null);
  am.accounts[1].quota.unified5h = null;
  am.accounts[1].quota.unified5hReset = null;
  am.accounts[1].rampStartedAt = 1; // an ancient, long-closed window
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b');
  assert.notEqual(am.accounts[1].rampStartedAt, 1, 'the return joins the ramp again');
});

test('a configured route and the auto family row hold separate pins', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'fable', match: ['*opus*'] }], // named fable, matches Opus
  });
  for (const acc of am.accounts) { acc.quota.unified7dFable = 0.1; acc.quota.unified7dFableReset = Date.now() + H; }
  assert.equal(am.setRoutePin('configured:fable', 1).ok, true);

  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b');
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'a', 'the auto row is not pinned');
  const rows = am.getRoutes();
  assert.equal(rows.find(r => !r.autocreated).id, 'configured:fable');
  assert.equal(rows.find(r => r.autocreated).id, 'auto:fable');
  assert.equal(rows.find(r => r.autocreated).override, null);
});

// ── pin reconciliation and ownership ────────────────────────

test('a config override replaces a TUI pin, and other TUI pins survive a reload', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }, { name: 'side', match: ['*haiku*'] }],
  });
  am.setRoutePin('configured:bulk', 2);
  am.setRoutePin('configured:side', 1);

  am.setRoutes([
    { name: 'bulk', match: ['*opus*'], override: { account: 'a', whenSpent: 'hold' } },
    { name: 'side', match: ['*haiku*'] },
  ]);
  assert.deepEqual(am.routePins.get('configured:bulk'),
    { index: 0, whenSpent: 'hold', source: 'config', lastServed: null });
  assert.equal(am.routePins.get('configured:side').source, 'tui');

  // The TUI pin's route goes away → so does the pin.
  am.setRoutes([{ name: 'bulk', match: ['*opus*'] }]);
  assert.equal(am.getRoutePin('configured:side'), null);
});

test('clearRoutePin refuses a config override and clearAnyPin does not', () => {
  const am = forced('fallback');
  const refused = am.clearRoutePin('configured:bulk');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /dashboard/);
  assert.equal(am.getRoutePin('configured:bulk')?.name, 'b');

  assert.deepEqual(am.clearAnyPin('configured:bulk'), { ok: true, cleared: true });
  assert.equal(am.getRoutePin('configured:bulk'), null);
  assert.deepEqual(am.clearAnyPin('configured:bulk'), { ok: true, cleared: false });
});

test('setRoutePin validates membership, the id and the mode', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['a'] }],
  });
  assert.match(am.setRoutePin('configured:bulk', 1).reason, /does not allow/);
  assert.match(am.setRoutePin('configured:gone', 0).reason, /no route "gone"/);
  assert.match(am.setRoutePin('bulk', 0).reason, /not a route id/);
  assert.match(am.setRoutePin('configured:bulk', 0, { whenSpent: 'wait' }).reason, /unknown whenSpent/);
  assert.equal(am.setRoutePin('auto:fable', 1).ok, true, 'an auto row has no member list');
  assert.equal(am.setRoutePin('configured:bulk', 0, { whenSpent: 'hold' }).ok, true);
  assert.equal(am.routePins.get('configured:bulk').whenSpent, 'hold');
});

test('removing an account remaps the pin object and its ramp bookkeeping', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('configured:bulk', 2, { whenSpent: 'hold' });
  am.getActiveAccount(null, 'claude-opus-4');
  assert.equal(am.routePins.get('configured:bulk').lastServed, 2);

  am.removeAccount(0);
  assert.deepEqual(am.routePins.get('configured:bulk'),
    { index: 1, whenSpent: 'hold', source: 'tui', lastServed: 1 });
});

test('ownership claims block forcing until the last one is gone', () => {
  const am = new AccountManager([oauth('a', { models: ['claude-opus-4'] }), oauth('b')], 0.98);
  assert.equal(am.hasOwnershipClaims(), true);
  assert.deepEqual(am.getStatus().forceBlocked, { reason: 'ownership-claims' });
  am.accounts[0].models = null;
  assert.equal(am.hasOwnershipClaims(), false);
  assert.equal(am.getStatus().forceBlocked, null);
});

// ── the row a reader sees ───────────────────────────────────

const bulkRow = am => am.getRoutes().find(r => r.name === 'bulk');

test('a forced row reports the force, its state and what the file says', () => {
  const am = forced('fallback');
  const row = bulkRow(am);
  assert.equal(row.id, 'configured:bulk');
  assert.deepEqual(row.persisted, { account: 'b', whenSpent: 'fallback' });
  assert.deepEqual(row.override, {
    account: 'b', whenSpent: 'fallback', source: 'config', since: 1789189000000,
    state: 'effective', reason: null,
  });

  // Spent, with somewhere else to go: still forced, served from elsewhere.
  spend(am.accounts[1]);
  assert.equal(bulkRow(am).override.state, 'unavailable');
  assert.equal(bulkRow(am).override.reason, 'quota');
  assert.equal(bulkRow(am).target, 'a');

  // Nothing left at all.
  spend(am.accounts[0]);
  assert.equal(bulkRow(am).override.state, 'no-target');
});

test('a held row reads as holding once its account cannot serve', () => {
  const am = forced('hold');
  assert.equal(bulkRow(am).override.state, 'effective');
  spend(am.accounts[1]);
  const row = bulkRow(am);
  assert.equal(row.override.state, 'holding');
  assert.equal(row.override.reason, 'quota');
  assert.equal(row.target, null, 'nothing serves a held route whose account is spent');
});

test('persisted comes from the file even when a TUI pin has replaced the config pin', () => {
  const am = forced('fallback');
  assert.equal(am.setRoutePin('configured:bulk', 0).ok, true);
  const row = bulkRow(am);
  assert.deepEqual(row.persisted, { account: 'b', whenSpent: 'fallback' });
  assert.equal(row.override.account, 'a');
  assert.equal(row.override.source, 'tui');
  assert.equal(row.override.since, null, 'a keypress has no written history');
});

test('an unforced row carries no override', () => {
  const am = new AccountManager([oauth('a')], 0.98, { routes: [{ name: 'bulk', match: ['*opus*'] }] });
  assert.equal(bulkRow(am).override, null);
  assert.equal(bulkRow(am).persisted, null);
});

test('a held route with an unroutable advisor degrades to executor-only routing', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [
      { name: 'bulk', match: ['*opus*'], override: { account: 'b', whenSpent: 'hold' } },
      { name: 'advice', match: ['*fable*'], accounts: ['c'] },
    ],
  });
  am.accounts[2].disabled = true; // nothing can serve the advisor model
  // The advisor-constrained pass comes up empty; the executor's hold still
  // decides the request rather than releasing the route to the fleet.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4', 'claude-fable-5').name, 'b');
});

test('a row resolves its membership to account names in fleet order', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['c', '0'] }, { name: 'all', match: ['*haiku*'] }],
  });
  for (const acc of am.accounts) { acc.quota.unified7dFable = 0.1; acc.quota.unified7dFableReset = Date.now() + H; }
  const rows = am.getRoutes();
  assert.deepEqual(rows.find(r => r.name === 'bulk').members, ['a', 'c'], 'by name or index, fleet order');
  assert.deepEqual(rows.find(r => r.name === 'all').members, ['a', 'b', 'c'], 'no list means everyone');
  assert.deepEqual(rows.find(r => r.autocreated).members, ['a', 'b', 'c']);
});

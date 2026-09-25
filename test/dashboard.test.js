import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { UNAVAILABLE_TEXT } from '../src/status-renderer.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, scopedWeeklyRows, accountTokens,
  accountBadges, thresholdBadgeText,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, routeStripLines, problems, STARVED_MIN, STARVED_LIST_MAX,
  chipFor, forceDefaultAccount, expectedFor, overrideRequest, overrideOutcome, resetHistoryRows, RESET_WINDOW_BUCKETS,
  currentFor, gatingUtilization, quotaGate,
  fleetFor, resolveSwitchThreshold, resolveMaxUsage, effectiveLimit, quotaGrade, bindingLimit, QUOTA_NEAR_BAND, THRESHOLD_BUCKET_KEYS, accountQuotaGroups, capBadgeText, providerOrder, forecastWindowLabel, bucketLabel,
} from '../src/dashboard.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The page's pure logic is exported and serialized into the script, so these
// exercise the same functions the browser runs.

test('scopedWeekly names the buckets, not a hard-coded pair', () => {
  const rows = scopedWeeklyRows({
    scopedWeekly: {
      sonnet: { utilization: 0.5, resetAt: 100 },
      opus: { utilization: 0.1, resetAt: 200 },
    },
  });
  // A family upstream started metering must appear without a release.
  assert.deepEqual(rows.map(r => r.family), ['opus', 'sonnet']);
  assert.deepEqual(rows[1], { family: 'sonnet', label: 'Sonnet', utilization: 0.5, resetAt: 100 });
});

test('scopedWeekly falls back to the dedicated fields, and never doubles a family', () => {
  // A usage payload with `seven_day_sonnet` but no `limits` array leaves
  // scopedWeekly empty while the dedicated field is set — the bar must still show.
  assert.deepEqual(
    scopedWeeklyRows({ unified7dSonnet: 0.3, unified7dSonnetReset: 9 }),
    [{ family: 'sonnet', label: 'Sonnet', utilization: 0.3, resetAt: 9 }],
  );
  const both = scopedWeeklyRows({
    scopedWeekly: { sonnet: { utilization: 0.5, resetAt: 100 } },
    unified7dSonnet: 0.3,
    unified7dSonnetReset: 9,
  });
  assert.equal(both.length, 1);
  assert.equal(both[0].utilization, 0.5);
  assert.deepEqual(scopedWeeklyRows({}), []);
  assert.deepEqual(scopedWeeklyRows(null), []);
});

test('account token total includes the cache fields', () => {
  // totalInputTokens counts uncached input only; omitting the cache fields
  // understates a Claude Code account by orders of magnitude.
  assert.equal(accountTokens({
    totalInputTokens: 1, totalOutputTokens: 2,
    totalCacheReadTokens: 100, totalCacheCreationTokens: 10,
  }), 113);
  assert.equal(accountTokens({}), 0);
  assert.equal(accountTokens(null), 0);
});

test('account metadata and session state are separate badges', () => {
  const badges = accountBadges({
    name: 'corp', provider: 'codex', type: 'oauth', priority: -2,
    status: 'active', sessions: 1, knownSessions: 3,
  }, 'legacy', { anthropic: 'personal', codex: 'corp' });
  assert.deepEqual(badges, [
    { cls: 'provider codex', text: 'Codex' },
    { cls: 'meta', text: 'oauth' },
    { cls: 'meta priority', text: 'prio -2' },
    { cls: 'current', text: 'current' },
    { cls: 'active', text: 'active' },
    { cls: 'sessions', text: '1 recent' },
    { cls: 'sessions known', text: '3 known' },
  ]);
});

// ── per-account switch threshold (#409) ───────────────────────

test('thresholdBadgeText is silent with no override, or one that matches the fleet', () => {
  assert.equal(thresholdBadgeText(null, 0.98, null), '');
  assert.equal(thresholdBadgeText(undefined, 0.98, null), '');
  assert.equal(thresholdBadgeText(0.98, 0.98, null), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.98 }, 0.98, null), '');
  // A hand-edited array is the #425 hazard class — refused, not spread into
  // numeric bucket keys.
  assert.equal(thresholdBadgeText([0.5], 0.98, null), '');
});

test('thresholdBadgeText names a bare-number override "at", and a table by bucket', () => {
  assert.equal(thresholdBadgeText(1.0, 0.98, null), 'switch at 100%');
  assert.equal(thresholdBadgeText({ unified7dFable: 0.8 }, 0.98, null), 'switch fable 80%');
  assert.equal(
    thresholdBadgeText({ unified7d: 0.9, unified7dFable: 0.8 }, 0.98, null),
    'switch 7d 90%, fable 80%',
  );
  // A per-bucket fleet table, not just a bare fleet number: the account's
  // unified7d entry is compared against the fleet's OWN unified7d, not its
  // default — an account that merely matches the fleet's per-bucket override
  // must stay silent on that bucket.
  assert.equal(thresholdBadgeText({ unified7d: 0.9 }, 0.98, { default: 0.98, unified7d: 0.9 }), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.85 }, 0.98, { default: 0.98, unified7d: 0.9 }), 'switch 7d 85%');
});

test('thresholdBadgeText names a bucket the account default moves off the fleet table', () => {
  // The defaults agree, so the old default-to-default comparison said nothing,
  // yet this account's weekly wall really is 98% where the fleet's is 85%.
  const fleetTable = { default: 0.98, unified7d: 0.85 };
  assert.equal(thresholdBadgeText(0.98, 0.98, fleetTable), 'switch 7d 98%');
  assert.equal(thresholdBadgeText({ default: 0.98 }, 0.98, fleetTable), 'switch 7d 98%');
  // An account entry for that bucket answers for it, equal to the fleet's or not.
  assert.equal(thresholdBadgeText({ default: 0.98, unified7d: 0.85 }, 0.98, fleetTable), '');
  // A differing default already covers every unlisted bucket.
  assert.equal(thresholdBadgeText(1.0, 0.98, fleetTable), 'switch at 100%');
});

test('accountBadges adds the threshold badge only when it differs from the fleet', () => {
  const withFleet = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 1.0 }, null, null, null, 0.98, null);
  assert.deepEqual(withFleet[withFleet.length - 1], { cls: 'meta threshold', text: 'switch at 100%' });

  const matching = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, null);
  assert.ok(!matching.some(b => b.cls.includes('threshold')), 'an override equal to the fleet stays silent');

  // No `switchThreshold` on the account at all (the common case, and the
  // shape the pre-#409 unit test above still exercises): no badge, whatever
  // the fleet args are, fleet omitted included — never a crash.
  const noOverride = accountBadges({ name: 'a', type: 'oauth' }, null, null);
  assert.ok(!noOverride.some(b => b.cls.includes('threshold')));
});

// The shape the server emits: a row is one CONVERSATION, keyed by the pin key
// routing uses, with the session it belongs to and the conversation's digest
// beside it as separate labels.
const SESSIONS = {
  items: [
    {
      id: 's-old/conv-old-0123456789abc', session: 's-old', conversation: 'conv-old-0123456789abc',
      client: 'bob', dimensions: { project: 'p2' }, active: false,
      requests: 2, lastSeen: 200, pins: { unified7d: 1 },
      tokens: { unified7d: { cacheRead: 5, cacheCreation: 1, input: 2, output: 1, context: 8 } },
    },
    {
      id: 's-new/conv-new-0123456789abc', session: 's-new', conversation: 'conv-new-0123456789abc',
      client: 'alice', dimensions: { project: 'p1' }, active: true,
      requests: 1, lastSeen: 100, pins: { unified7d: 0, unified7dFable: 1 },
      tokens: {
        unified7d: { cacheRead: 900, cacheCreation: 50, input: 10, output: 5, context: 960 },
        unified7dFable: { cacheRead: 0, cacheCreation: 0, input: 4, output: 2, context: 4 },
      },
    },
  ],
};

test('a conversation row totals what the responses reported, cache included', () => {
  const rows = sessionRows(SESSIONS);
  const row = rows.find(r => r.session === 's-new');
  // input+output alone would say 21 for a conversation that actually cost 971.
  assert.equal(row.input + row.output, 21);
  assert.equal(row.total, 971);
  assert.equal(row.cacheRead, 900);
  // Summed across every weekly bucket the conversation touched.
  assert.equal(row.context, 964);
  // A conversation spending two model families is served by two accounts at
  // once, which is why this is a pin map and not one index.
  assert.equal(row.accounts, '0, 1');
  assert.equal(row.client, 'alice');
  assert.equal(row.project, 'p1');
});

test('a fan-out is one row per conversation, under the one session that owns them', () => {
  // The rows of one client session are identical but for the conversation, so
  // the session alone cannot tell them apart — and the key that can is a
  // composite nobody recognises, so it is not what the table shows.
  const rows = sessionRows({
    items: [
      { id: 'sess-7/aaaaaaaaaaaaaaaaaaaaaa', session: 'sess-7', conversation: 'aaaaaaaaaaaaaaaaaaaaaa', client: 'alice', pins: {}, tokens: {} },
      { id: 'sess-7/bbbbbbbbbbbbbbbbbbbbbb', session: 'sess-7', conversation: 'bbbbbbbbbbbbbbbbbbbbbb', client: 'alice', pins: {}, tokens: {} },
    ],
  });
  assert.deepEqual(rows.map(r => r.session), ['sess-7', 'sess-7']);
  // Eight characters of the digest: enough to separate siblings, narrow enough
  // for a column beside the session.
  assert.deepEqual(rows.map(r => r.conversation), ['aaaaaaaa', 'bbbbbbbb']);
});

test('session rows tolerate a payload with nothing in it', () => {
  assert.deepEqual(sessionRows({}), []);
  assert.deepEqual(sessionRows(null), []);
  // A record no request ever labelled (touch() alone) names no session, and
  // falls back to the key it is filed under rather than rendering blank.
  const [bare] = sessionRows({ items: [{ id: 'x' }] });
  assert.deepEqual(
    { id: bare.id, session: bare.session, conversation: bare.conversation, client: bare.client, project: bare.project, total: bare.total, accounts: bare.accounts },
    { id: 'x', session: 'x', conversation: '', client: '', project: '', total: 0, accounts: '' },
  );
});

test('filters narrow by project and client, and combine', () => {
  const rows = sessionRows(SESSIONS);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1' }).map(r => r.session), ['s-new']);
  assert.deepEqual(filterSessionRows(rows, { client: 'bob' }).map(r => r.session), ['s-old']);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1', client: 'bob' }), []);
  // An empty filter is "All", not a match against the empty string.
  assert.equal(filterSessionRows(rows, { project: '', client: '' }).length, 2);
  assert.equal(filterSessionRows(rows, {}).length, 2);
});

test('sorting handles both text and number columns, and does not mutate', () => {
  const rows = sessionRows(SESSIONS);
  const before = rows.map(r => r.session);
  assert.deepEqual(sortRows(rows, 'total', 'desc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'total', 'asc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(sortRows(rows, 'client', 'asc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'client', 'desc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(rows.map(r => r.session), before, 'the caller\'s array is untouched');
  assert.deepEqual(sortRows(null, 'total', 'desc'), []);
});

test('filter options are unique, sorted, and drop the unlabelled', () => {
  assert.deepEqual(uniqSorted(['b', 'a', '', 'a', null, undefined]), ['a', 'b']);
  assert.deepEqual(uniqSorted([]), []);
  assert.deepEqual(uniqSorted(null), []);
});

test('switchOutcome separates the choice being recorded from traffic following it', () => {
  assert.deepEqual(switchOutcome({ ok: true, account: 'b', eligible: true }), { kind: 'ok', text: 'Starting account recorded: b. Normal routing still applies.' });
  // A spent or disabled target is still switched to (that is the TUI's behaviour),
  // but saying "done" would hide that rotation skips it on the very next request.
  assert.deepEqual(
    switchOutcome({ ok: true, account: 'b', eligible: false, reason: 'disabled by operator' }),
    { kind: 'warn', text: 'Starting account recorded: b. Rotation will not use it: disabled by operator' },
  );
  assert.deepEqual(switchOutcome({ ok: false, error: 'no such account "x"' }), { kind: 'error', text: 'Selection failed: no such account "x"' });
  assert.deepEqual(switchOutcome(null), { kind: 'error', text: 'Selection failed' });
});

test('the switch button\'s request passes the same-origin gate and moves the current account', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const origin = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(`${origin}/teamclaude/status`, { headers: { 'x-api-key': 'secret' } })).json();
  try {
    assert.equal((await status()).currentAccount, 'a');

    // The request the page builds, plus the two headers a browser adds to a
    // same-origin fetch. This proves the CSRF gate, not the key: the test runs
    // on loopback, which the key gate exempts, so the key here is inert. Key
    // acceptance is covered in control-csrf.test.js; the gate is what the
    // button depends on, and it runs regardless of loopback.
    const r = switchRequest('b', 'secret');
    const ok = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, account: 'b', eligible: true });
    assert.equal((await status()).currentAccount, 'b');

    // The same request from another site is refused — a page the operator
    // happens to visit cannot drive the button.
    const evil = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error, /cross-origin/);
    assert.equal((await status()).currentAccount, 'b', 'unchanged');
  } finally {
    proxy.close();
  }
});

test('the dashboard exposes reload and one-shot probe controls', () => {
  const html = renderDashboardHtml();
  assert.match(html, /id="reload"/);
  assert.match(html, /id="probe"/);
  assert.match(html, /\/teamclaude\/reload/);
  assert.match(html, /\/teamclaude\/probe/);
});

test('the probe control invokes the server hook', async () => {
  let calls = 0;
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => { calls++; },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls, 1);
  } finally {
    proxy.close();
  }
});

// The shape /teamclaude/status reports per route: the server's own target for
// the family, and every account with whether it could serve it.
const ROUTED = {
  currentAccount: 'a',
  routes: [{
    name: 'fable', match: ['*fable*'], autocreated: true, pinned: null, target: 'b',
    accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }, { name: 'c', eligible: true }],
  }],
};

test('dashboard payload identifies both provider cursors without one false global current', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'oauth', provider: 'codex', accountId: 'acct', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

  const status = am.getStatus();
  assert.deepEqual(status.currentAccounts, { anthropic: 'claude', codex: 'codex' });
  const html = renderDashboardHtml();
  assert.match(html, /currentAccounts/);
  assert.match(html, /providerLabel/);
});

test('mixed-provider routing reports one default row per provider', () => {
  const rows = routeRows({
    currentAccount: 'codex',
    currentAccounts: { anthropic: 'claude', codex: 'codex' },
    defaultTargets: { anthropic: 'claude', codex: 'codex' },
    accounts: [
      { name: 'claude', provider: 'anthropic', unavailable: null },
      { name: 'codex', provider: 'codex', unavailable: null },
    ],
    routes: [{
      name: 'fable', provider: 'anthropic', match: ['*fable*'], target: 'claude',
      accounts: [{ name: 'claude', eligible: true }],
    }],
  });
  assert.deepEqual(
    rows.map(r => ({ label: r.label, provider: r.provider, target: r.target })),
    [
      { label: 'Fable', provider: 'anthropic', target: 'claude' },
      { label: 'Claude default', provider: 'anthropic', target: 'claude' },
      { label: 'Codex default', provider: 'codex', target: 'codex' },
    ],
  );
});

test('provider routing previews keep the per-provider default rows', () => {
  const rows = routeRows({
    currentAccounts: { anthropic: 'claude', codex: 'codex' },
    defaultTargets: { anthropic: 'claude', codex: 'codex' },
    providerRouting: [],
    routes: [{
      name: 'fast', match: ['fast-*'], members: ['claude', 'codex'], previews: [{
        provider: 'anthropic', label: 'fast-*', model: 'fast-1', target: 'claude',
        accounts: [{ name: 'claude', eligible: true }],
      }],
    }],
  });
  assert.deepEqual(rows.map(row => row.label), ['Claude / fast', 'Claude default', 'Codex default']);
});

test('route rows say where each family goes, why, and where everything else goes', () => {
  const rows = routeRows(ROUTED);
  assert.equal(rows.length, 2);
  const [fable, rest] = rows;
  // A family diverted away from the current account shows the server's target,
  // not a re-derivation from quota bars, and names the accounts that cannot
  // take it — that is the reason the family is elsewhere.
  assert.deepEqual(
    { label: fable.label, match: fable.match, target: fable.target, eligible: fable.eligible, ineligible: fable.ineligible },
    { label: 'Fable', match: '*fable*', target: 'b', eligible: ['b', 'c'], ineligible: ['a'] },
  );
  assert.equal(fable.autocreated, true);
  // The default row is the current account: everything without a route lands there.
  assert.deepEqual({ label: rest.label, target: rest.target, match: rest.match }, { label: 'Everything else', target: 'a', match: '' });
});

test('a pinned route carries its pin, and says when routing is not honouring it', () => {
  const honoured = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'c' }] })[0];
  assert.deepEqual({ pinned: honoured.pinned, target: honoured.target, mismatch: honoured.pinMismatch }, { pinned: 'c', target: 'c', mismatch: false });
  // The server skips a pin whose account cannot serve the family; "b · pinned"
  // would read as b being the pin. The row must carry both names.
  const skipped = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'b' }] })[0];
  assert.deepEqual({ pinned: skipped.pinned, target: skipped.target, mismatch: skipped.pinMismatch }, { pinned: 'c', target: 'b', mismatch: true });
});

test('the default row is the server\'s defaultTarget, and says why when it is not the current account', () => {
  const blocked = { ...ROUTED, defaultTarget: 'b', accounts: [{ name: 'a', unavailable: 'throttled' }, { name: 'b', unavailable: null }] };
  const row = routeRows(blocked)[1];
  assert.equal(row.kind, 'default');
  assert.equal(row.target, 'b', 'not the current account');
  assert.equal(row.current, 'a');
  assert.equal(row.currentUnavailable, 'throttled');
  // Without defaultTarget (an older server) the row falls back to the current account.
  assert.equal(routeRows(ROUTED)[1].target, 'a');
});

test('a route whose every glob is blocked has no reachable target', () => {
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*fable*'] })[0].blocked, true);
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*opus*'] })[0].blocked, false);
  assert.equal(routeRows(ROUTED)[0].blocked, false);
  const empty = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], target: null, accounts: [] }] })[0];
  assert.deepEqual({ target: empty.target, eligible: empty.eligible, ineligible: empty.ineligible }, { target: null, eligible: [], ineligible: [] });
});

test('route rows read the shape a real AccountManager reports', () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const H = 3600_000;
  Object.assign(am.accounts[0].quota, { unified7d: 0.3, unified7dReset: Date.now() + 4 * H, unified7dFable: 0.99, unified7dFableReset: Date.now() + 4 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.1, unified7dReset: Date.now() + 90 * H, unified7dFable: 0.1, unified7dFableReset: Date.now() + 90 * H });
  const rows = routeRows(am.getStatus());
  const fable = rows.find(r => r.name === 'fable');
  assert.ok(fable, 'the server autocreates a Fable route once an account meters it');
  assert.deepEqual({ target: fable.target, ineligible: fable.ineligible }, { target: 'b', ineligible: ['a'] });
  assert.deepEqual(
    rows.filter(row => row.kind === 'default').map(row => ({ label: row.label, target: row.target })),
    [{ label: 'Claude default', target: 'a' }],
    'provider status has one provider-specific fallback row',
  );
  am.setDisabled(1, true);
  const after = routeRows(am.getStatus()).find(row => row.name === 'fable');
  assert.equal(after.target, null, 'unavailable previews do not fall back to the global cursor');
});

test('a fleet with no routes renders no section', () => {
  // Without a metered family there is nothing to route: the summary line
  // already names the current account, so no redundant one-row table.
  assert.deepEqual(routeRows({ currentAccount: 'a', routes: [] }), []);
  assert.deepEqual(routeRows({ currentAccount: 'a' }), []);
  assert.deepEqual(routeRows(null), []);
});

// A configured route with an override, in the shape the endpoint and getRoutes
// agree on: `override` is the effective runtime pin, `persisted` is what the
// config file says, and the two can disagree while a TUI pin is in memory.
const OVERRIDDEN = {
  providerRouting: [],
  accounts: [
    { name: 'a', quota: { unified7d: 0.4, unified7dReset: 2000 } },
    { name: 'b', quota: { unified7d: 0.1, unified7dReset: 1000 } },
    { name: 'c', quota: {} },
  ],
  routes: [{
    name: 'codex-default', match: ['gpt-*', '*codex*'], autocreated: false,
    id: 'configured:codex-default',
    override: { account: 'a', whenSpent: 'fallback', source: 'config', since: 5, state: 'effective', reason: null },
    persisted: { account: 'a', whenSpent: 'fallback' },
    // The route's resolved membership: an empty config list means every
    // account, and c is one the codex preview leaves out.
    members: ['a', 'b', 'c'],
    accounts: [{ name: 'a', eligible: true }, { name: 'b', eligible: true }],
    previews: [{
      provider: 'codex', model: 'gpt-', label: 'gpt-*', target: 'a',
      accounts: [{ name: 'a', eligible: true }, { name: 'b', eligible: true }],
    }],
  }],
};
const forcedRow = (override, extra = {}) => routeRows({
  ...OVERRIDDEN,
  routes: [{ ...OVERRIDDEN.routes[0], override: { account: 'a', source: 'config', ...override }, ...extra }],
})[0];

test('a route row carries its identity, its live override and what the config says', () => {
  const [row] = routeRows(OVERRIDDEN);
  assert.equal(row.id, 'configured:codex-default');
  assert.deepEqual(row.persisted, { account: 'a', whenSpent: 'fallback' });
  assert.equal(row.override.state, 'effective');
  // The Force dialog offers the route's members, and the 409 baseline is built
  // from the same list, so the server's resolved membership has to reach the
  // row rather than the preview's provider-filtered accounts.
  assert.deepEqual(row.members, ['a', 'b', 'c']);
  assert.deepEqual(row.globs, ['gpt-*', '*codex*']);
  // A server that does not resolve membership for us falls back to the first
  // preview's accounts, which is all an older status payload carries.
  const noMembers = { ...OVERRIDDEN.routes[0] };
  delete noMembers.members;
  assert.deepEqual(routeRows({ ...OVERRIDDEN, routes: [noMembers] })[0].members, ['a', 'b']);

  // A server that does not report them yet (the fields are WP1's) leaves the
  // row usable and unforced rather than rendering a half-built control.
  const [plain] = routeRows(ROUTED);
  assert.deepEqual({ id: plain.id, override: plain.override, persisted: plain.persisted }, { id: null, override: null, persisted: null });
  assert.equal(chipFor(plain), null);
});

test('the chip says what the override is actually doing, not just that one exists', () => {
  assert.deepEqual(chipFor(forcedRow({ whenSpent: 'fallback', state: 'effective' })),
    { kind: 'accent', text: 'forced · falls back when spent' });
  assert.deepEqual(chipFor(forcedRow({ whenSpent: 'hold', state: 'effective' })),
    { kind: 'accent', text: 'forced · held' });
  // Traffic has left the forced account: the row has to name where it went, or
  // "forced to a" reads as a claim about where requests are landing.
  assert.deepEqual(chipFor(forcedRow({ whenSpent: 'fallback', state: 'unavailable', reason: 'over its weekly threshold' })),
    { kind: 'warn', text: 'forced to a · a is over its weekly threshold · serving from a' });
  assert.deepEqual(chipFor(forcedRow({ whenSpent: 'hold', state: 'holding', reason: 'over its weekly threshold' })),
    { kind: 'bad', text: 'held on a · a is over its weekly threshold · requests get 429' });
  assert.deepEqual(chipFor(forcedRow({ whenSpent: 'fallback', state: 'no-target' })),
    { kind: 'bad', text: 'forced to a · nothing can serve right now' });
  // A TUI pin is memory only, and the reader cannot otherwise tell.
  assert.equal(chipFor(forcedRow({ whenSpent: 'hold', state: 'effective', source: 'tui' })).text,
    'forced · held · from the TUI, until restart');
  assert.equal(chipFor({}), null);
  assert.equal(chipFor(null), null);
  // Names are operator-supplied and reach the chip untouched; the page puts
  // them through textContent, so nothing here escapes or mangles them.
  const hostile = '<img src=x onerror=alert(1)>';
  assert.match(chipFor(forcedRow({ account: hostile, state: 'no-target' })).text, /<img src=x onerror=alert\(1\)>/);
});

test('the dialog opens on the member whose weekly window comes back first', () => {
  const row = routeRows(OVERRIDDEN)[0];
  assert.equal(forceDefaultAccount(row, OVERRIDDEN.accounts), 'b');
  // An unrestricted route offers every account, c included, even though the
  // codex preview lists only the two that can serve its sample.
  assert.deepEqual(row.members, ['a', 'b', 'c']);
  // An unreported reset is not an early one: it sorts behind every known reset.
  assert.equal(forceDefaultAccount({ members: ['c', 'a'] }, OVERRIDDEN.accounts), 'a');
  assert.equal(forceDefaultAccount({ members: ['c'] }, OVERRIDDEN.accounts), 'c');
  assert.equal(forceDefaultAccount({ members: [] }, OVERRIDDEN.accounts), null);
  assert.equal(forceDefaultAccount(null, null), null);
  // Members arrive as {name, eligible} on a getRoutes row and as names on a
  // page row; both are the same list.
  assert.equal(forceDefaultAccount({ members: [{ name: 'a' }, { name: 'b' }] }, OVERRIDDEN.accounts), 'b');
});

test('the baseline sent with a Force is the route definition, canonically', () => {
  // Membership travels as the resolved names the endpoint compares against,
  // not the config list: "3" and an omitted list both mean accounts by name.
  assert.deepEqual(expectedFor(routeRows(OVERRIDDEN)[0]), {
    match: ['gpt-*', '*codex*'],
    accounts: ['a', 'b', 'c'],
    persisted: { account: 'a', whenSpent: 'fallback' },
  });
  // The 409 reply hands back a server row, whose match is already an array and
  // whose accounts are objects. `Use current` builds the next baseline from it.
  assert.deepEqual(expectedFor(OVERRIDDEN.routes[0]), {
    match: ['gpt-*', '*codex*'],
    accounts: ['a', 'b', 'c'],
    persisted: { account: 'a', whenSpent: 'fallback' },
  });
  // Without members, the row's account names still stand in.
  assert.deepEqual(expectedFor({ globs: ['gpt-*'], accounts: [{ name: 'a' }, { name: 'b' }] }).accounts, ['a', 'b']);
  // An unforced route sends persisted: null, which is what "I saw no override"
  // has to say. Omitting the field would read as "I did not look".
  assert.deepEqual(expectedFor({ globs: ['*fable*'], accounts: [], persisted: null }), { match: ['*fable*'], accounts: [], persisted: null });
  assert.deepEqual(expectedFor(null), { match: [], accounts: [], persisted: null });
});

test('the override request is the same POST shape the endpoint documents', () => {
  const { url, init } = overrideRequest({ route: 'codex-default', expected: { match: ['gpt-*'], accounts: [], persisted: null }, account: 'a', whenSpent: 'hold' }, 'secret');
  assert.equal(url, '/teamclaude/routes/override');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'x-api-key': 'secret', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), {
    route: 'codex-default', expected: { match: ['gpt-*'], accounts: [], persisted: null }, account: 'a', whenSpent: 'hold',
  });
  // The LAN dashboard build sends no key of its own; the cookie carries it.
  assert.equal(overrideRequest({ route: 'r', clear: true }, '').init.headers['x-api-key'], '');
  assert.deepEqual(JSON.parse(overrideRequest({ route: 'r', clear: true }).init.body), { route: 'r', clear: true });
});

test('the override outcome separates the config write from the running router', () => {
  const row = { override: { account: 'a', whenSpent: 'fallback' } };
  assert.deepEqual(overrideOutcome({ ok: true, row, persisted: true, applied: true, warnings: [] }),
    { kind: 'ok', row, text: 'Forced to a, falling back when it is spent.' });
  assert.match(overrideOutcome({ ok: true, row: { override: { account: 'a', whenSpent: 'hold' } }, applied: true }).text, /held on it/);
  assert.match(overrideOutcome({ ok: true, row: { override: null }, applied: true }).text, /Force cleared/);
  assert.equal(overrideOutcome({ ok: true, row, applied: true, warnings: ['dropped an unknown bucket'] }).text,
    'Forced to a, falling back when it is spent. dropped an unknown bucket');
  // Written but not applied: the next reload picks it up while the live fleet
  // still routes the old way, which a bare "done" would hide.
  const half = overrideOutcome({ ok: true, row, persisted: true, applied: false });
  assert.equal(half.kind, 'warn');
  assert.match(half.text, /did not reload/);

  assert.deepEqual(overrideOutcome({ ok: false, errors: [{ field: 'account', message: 'not a member of this route' }] }),
    { kind: 'error', row: null, text: 'Nothing changed: not a member of this route' });
  assert.match(overrideOutcome({ ok: false, error: 'no such route' }).text, /Nothing changed: no such route/);
  const conflict = overrideOutcome({ ok: false, error: 'changed elsewhere', row: OVERRIDDEN.routes[0] });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.row, OVERRIDDEN.routes[0], 'the current row drives Use current');
  const failed = overrideOutcome({ ok: false, persisted: true, applied: false, error: 'reload failed; see the proxy log' });
  assert.deepEqual({ kind: failed.kind, text: failed.text }, { kind: 'warn', text: 'Saved to the config, but not applied: reload failed; see the proxy log' });
  assert.deepEqual(overrideOutcome(null), { kind: 'error', row: null, text: 'Nothing changed: no reason given' });
});

// Built from a REAL getStatus() rather than a hand-written object: a previous
// version of this banner was validated against a payload the server can never
// emit, and the impossible fixture hid a false positive.
function fleetStatus(mutate) {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  mutate?.(am);
  return am.getStatus({ sessionDetail: true });
}
/**
 * Drive a conversation to `n` consecutive no-answer outcomes on a real tracker.
 * `id` is the pin key; `labels` carries the session and conversation names the
 * request path attaches to it, which most cases here do not need.
 */
function starve(am, id, n, client = 'alice', labels = null) {
  for (let i = 0; i < n; i++) {
    am.beginSession(id, { client, dimensions: {}, ...labels });
    am.endSession(id, false);
  }
}

test('a starving session is named, and a working one is not', () => {
  const named = problems(fleetStatus(am => starve(am, 'deadbeef1234', STARVED_MIN)));
  assert.equal(named.length, 1);
  assert.equal(named[0].kind, 'starved-session');
  assert.equal(named[0].severity, 'bad');
  assert.match(named[0].text, /alice's session deadbeef/);
  assert.match(named[0].text, new RegExp(`${STARVED_MIN} requests in a row`));

  // One usable answer clears the streak — the session is working again.
  assert.deepEqual(problems(fleetStatus(am => {
    starve(am, 'deadbeef1234', STARVED_MIN);
    am.beginSession('deadbeef1234'); am.endSession('deadbeef1234', true);
  })), []);
  // Literals, not STARVED_MIN: written in terms of the constant, these passed
  // with the threshold set to 1 (fires on a single failure) and to 20 (never
  // fires). The value is part of the behaviour, so the test has to name it.
  assert.deepEqual(problems(fleetStatus(am => starve(am, 'deadbeef1234', 4))), [], 'four in a row is a wobble');
  assert.equal(problems(fleetStatus(am => starve(am, 'deadbeef1234', 5))).length, 1, 'five is an alarm');
  // A brand-new session, and a fleet doing nothing.
  assert.deepEqual(problems(fleetStatus(am => am.beginSession('fresh1234', { client: 'bob' }))), []);
  assert.deepEqual(problems(fleetStatus()), []);
});

test('a starving line names the session and the conversation, never the key', () => {
  // A fan-out starves as a group, so lines carrying only the session would read
  // as the same line repeated; the pin key that does separate them is a
  // composite an operator has never seen and cannot look up.
  const out = problems(fleetStatus(am => starve(am, 'deadbeef1234/AbCdEfGhIjKlMnOpQrStUv', STARVED_MIN, 'alice',
    { sessionId: 'deadbeef1234', conversation: 'AbCdEfGhIjKlMnOpQrStUv' })));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /alice's session deadbeef, conversation AbCdEfGh, has had/);
  assert.doesNotMatch(out[0].text, /\//);
});

test('a session that starved and then went quiet stops being reported', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', 9);
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1, 'reported while it is trying');
  // Past the active window: the row survives in items[] with its streak intact,
  // and only `active` keeps it out of the banner — deleting that filter passed
  // every other test in this file.
  const rec = am.sessionTracker.sessions.get('deadbeef1234');
  rec.lastSeen -= 5 * 60 * 1000;
  rec.inFlight = 0;
  const detailed = am.getStatus({ sessionDetail: true });
  assert.equal(detailed.sessions.items[0].starved, 9, 'the streak is still on the record');
  assert.deepEqual(problems(detailed), [], 'but a session that stopped trying is not starving');
  assert.deepEqual(problems(am.getStatus()), [], 'and the aggregate has cleared too');
});

test('many starving sessions are capped, worst first, with the rest counted', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const depth = { aaaaaaaa1111: 5, bbbbbbbb2222: 9, cccccccc3333: 6, dddddddd4444: 7, eeeeeeee5555: 8 };
  for (const [id, n] of Object.entries(depth)) starve(am, id, n, id.slice(0, 3));
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, STARVED_LIST_MAX + 1, 'capped, plus one summary line');
  // Worst first — items[] arrives sorted by recency, which is a different order.
  assert.match(out[0].text, /bbbbbbbb/);
  assert.match(out[1].text, /eeeeeeee/);
  assert.match(out[2].text, /dddddddd/);
  assert.equal(out[3].kind, 'starved-more');
  assert.match(out[3].text, new RegExp(`and ${5 - STARVED_LIST_MAX} more`));
});

test('when the whole fleet is stalled the banner says so instead of blaming the session', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  am.accounts[0].quota.unified5h = 0.99;              // over the switch threshold
  starve(am, 'deadbeef1234', 5);
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /every account is over its quota threshold/);
  assert.doesNotMatch(out[0].text, /it is failing, not idle/);
});

test('without sessionDetail the banner still fires, unnamed', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', STARVED_MIN);
  const hidden = am.getStatus();               // sessionDetail off — no items[]
  assert.equal('items' in hidden.sessions, false);
  const out = problems(hidden);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'starved-session');
  assert.match(out[0].text, /proxy.sessionDetail/);
  // And it is not doubled when both the row and the aggregate are available.
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1);
});

test('only the account states that need a person are reported', () => {
  // These clear themselves — rotation and back-off working.
  // `status = 'exhausted'` is never assigned anywhere in src/, so a fixture that
  // sets it proves nothing. These four are all reachable.
  for (const quiet of [
    am => am.markRateLimited(0, 60),
    am => am.markEntitlementDenied(0),
    am => { am.accounts[0].maxUsage = 0.5; am.accounts[0].quota.unified5h = 0.9; },
    am => { am.accounts[0].quota.unifiedStatus = 'rejected'; am.accounts[0].quota.unifiedStatusSeenAt = Date.now(); },
  ]) assert.deepEqual(problems(fleetStatus(quiet)), [], 'self-clearing state must stay silent');

  // These do not.
  const broken = problems(fleetStatus(am => { am.accounts[0].status = 'error'; }));
  assert.deepEqual(broken.map(p => p.kind), ['account']);
  assert.match(broken[0].text, /re-login/);
  const off = problems(fleetStatus(am => am.setDisabled(0, true)));
  assert.deepEqual(off.map(p => p.kind), ['account']);
  assert.match(off[0].text, /disabled/);
});

test('overage spend is not a banner line', () => {
  // usedMinor is month-to-date, so once overage is switched on this would be lit
  // for most of the month. The account card and `teamclaude status` carry it,
  // with the amount, which the banner did not.
  assert.deepEqual(problems(fleetStatus(am => { am.accounts[0].quota.spend = { enabled: true, usedMinor: 250 }; })), []);
});

test('the serialized helpers run in the page\'s own scope, not just parse', () => {
  // Parsing and grepping both pass for a helper that closes over a module
  // constant the page never ships — it would ReferenceError at first render.
  // Evaluate ONLY the serialized bundle and call into it.
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return problems;`)();
  const payload = { sessions: { items: [{ id: 'deadbeef1234', client: 'alice', active: true, starved: 9, requests: 9, pins: {}, tokens: {} }] } };
  assert.deepEqual(isolated(payload), problems(payload), 'the page runs what the tests exercise');
});

// The threshold badge specifically: accountBadges calls thresholdBadgeText by
// NAME, not by reference, so if the two ever land on different sides of the
// `bundle` slice (or thresholdBadgeText is dropped from SHARED_HELPERS while
// accountBadges keeps calling it) this is a page-breaking ReferenceError that
// grepping the source would not catch — only running the bundle does.
test('accountBadges calls thresholdBadgeText inside the same serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: 1.0 };
  assert.deepEqual(isolated(account, null, null, null, 0.98, null), accountBadges(account, null, null, null, 0.98, null));
});

// The bare number above never reaches the bucket tables: only a TABLE-form
// override reads THRESHOLD_BUCKET_KEYS and THRESHOLD_BUCKET_LABELS, and those
// are module constants the page does not see unless SHARED_CONSTS writes them
// in. Imported, the helper finds them in module scope and passes; in the page
// it threw a ReferenceError from render() and blanked the accounts pane.
test('a table-form override renders its badge inside the serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: { unified7d: 0.9, unified7dFable: 0.8 } };
  const badges = isolated(account, null, null, null, 0.98, null);
  assert.deepEqual(badges[badges.length - 1], { cls: 'meta threshold', text: 'switch 7d 90%, fable 80%' });
  // The inherited-bucket path reads the same two tables.
  const moved = isolated({ name: 'b', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, { default: 0.98, unified7d: 0.85 });
  assert.deepEqual(moved[moved.length - 1], { cls: 'meta threshold', text: 'switch 7d 98%' });
});

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, routeRows, problems,
    chipFor, forceDefaultAccount, expectedFor, overrideRequest, overrideOutcome,
    fleetFor, resolveSwitchThreshold, resolveMaxUsage, effectiveLimit, quotaGrade, bindingLimit, capBadgeText, providerOrder, routeStripLines, forecastWindowLabel, bucketLabel]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script), 'inline script must parse');
});

// Run the page's whole inline script against a stub DOM, a stub localStorage and
// a fetch the test answers by hand. Elements absorb any method call, so render()
// runs without a real DOM; only the style and text the startup path sets are read.
function bootPage({ storedKey = null, dom = null } = {}) {
  const els = new Map();
  const stubEl = () => {
    const target = { style: {}, value: '', textContent: '', className: '', disabled: false };
    return new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => stubEl()) });
  };
  const byId = dom ? dom.getElementById : id => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); };
  const store = new Map(storedKey ? [['teamclaude-dashboard-key', storedKey]] : []);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const requests = [];
  const fetch = (url, init) => new Promise(resolve => requests.push({ url, init, resolve }));
  const classList = { add() {}, remove() {} };
  const document = dom || {
    body: { classList },
    getElementById: byId,
    createElement: () => stubEl(),
    querySelectorAll: () => [],
  };
  const window = { addEventListener() {} };
  const location = { hash: '' };
  const history = {};
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  new Function('window', 'document', 'localStorage', 'fetch', 'setInterval', 'clearInterval', 'AbortSignal', 'Intl', 'history', 'location', script)(
    window, document, localStorage, fetch, () => 1, () => {}, AbortSignal, Intl, history, location);
  const answer = async (status, body = {}) => {
    requests.shift().resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await new Promise(r => setImmediate(r));
  };
  return { byId, store, requests, answer };
}

test('the page polls status before asking for a key, so a key-exempt browser is never prompted', async () => {
  const page = bootPage();
  assert.equal(page.requests.length, 1, 'polls on load with no stored key');
  assert.equal(page.requests[0].url, '/teamclaude/status');
  assert.equal(page.requests[0].init.headers['x-api-key'], '');
  assert.notEqual(page.byId('keybox').style.display, 'block', 'no prompt before the server answers');

  await page.answer(200, { accounts: [] });
  assert.notEqual(page.byId('keybox').style.display, 'block');
  assert.equal(page.byId('app').style.display, '');
});

for (const status of [401, 403]) {
  test(`a ${status} on the status poll brings the key prompt up and drops the stored key`, async () => {
    const page = bootPage({ storedKey: 'tc-stale' });
    assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-stale');
    await page.answer(status);
    assert.equal(page.byId('keybox').style.display, 'block');
    assert.equal(page.byId('app').style.display, 'none');
    assert.equal(page.store.size, 0);
  });
}

test('a first poll that fails shows its error instead of a blank page', async () => {
  const page = bootPage();
  await page.answer(500);
  assert.equal(page.byId('err').style.display, 'block');
  assert.match(page.byId('err').textContent, /status 500/);
  assert.equal(page.byId('app').style.display, '');
});

test('dashboard page is self-contained: no external resources', () => {
  const html = renderDashboardHtml();
  assert.match(html, /^<!doctype html>/);
  // The CSP story for a page that holds the proxy key in localStorage depends
  // on nothing external ever loading — no CDN scripts, styles, or fonts.
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /href\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import/i);
  // The data fetch targets the gated status endpoint, same origin.
  assert.match(html, /fetch\('\/teamclaude\/status'/);
  // Every field the page renders is operator or OAuth derived, and route names
  // and account names now reach the routing table and the Force dialog. The CSP
  // admits this one script by hash, so an injected tag would not run, but the
  // page must not be the thing that builds one either.
  assert.doesNotMatch(html.slice(html.indexOf('<script>')), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // No inline handlers: CSP has no 'unsafe-inline' for scripts, so an onclick=
  // attribute would be silently dead rather than obviously broken.
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i);
});

test('GET /teamclaude/dashboard serves HTML without a key; other methods are a local 404', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /TeamClaude/);

    // The page keeps the proxy key in localStorage, so it ships with a policy
    // that lets nothing load from anywhere and admits only its own script —
    // by hash, so a script that is not byte-for-byte this one does not run.
    const csp = page.headers.get('content-security-policy');
    assert.ok(csp, 'the dashboard must carry a Content-Security-Policy');
    assert.equal(csp, dashboardCsp(html));
    assert.match(csp, /(^|; )default-src 'none'(;|$)/);
    assert.match(csp, /(^|; )connect-src 'self'(;|$)/);
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, '\\$&')}'`));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    // The asset route is GET + exact path only — a POST to the same path must
    // NOT hit the dashboard handler. It used to flow on to the forwarder and
    // reach the upstream under a fleet credential; an unclaimed path under the
    // proxy's own prefix is now answered here (#420).
    const post = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`, { method: 'POST' });
    assert.equal(post.status, 404);
    assert.match((await post.json()).error, /unknown teamclaude control route/);
    assert.equal(upstreamHits, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('quota display reverses spent and left without turning unknown values into capacity', async () => {
  const { quotaDisplay } = await import('../src/dashboard.js');
  for (const [ratio, spent, left] of [[0, 0, 100], [0.81, 81, 19], [1, 100, 0], [1.2, 100, 0], [-0.1, 0, 100], [0.005, 1, 99], [0.015, 2, 98], [0.996, 99, 1]]) {
    assert.equal(quotaDisplay(ratio, 'spent'), spent);
    assert.equal(quotaDisplay(ratio, 'left'), left);
  }
  for (const missing of [undefined, null, NaN, Infinity, '0.5']) {
    assert.equal(quotaDisplay(missing, 'spent'), null);
    assert.equal(quotaDisplay(missing, 'left'), null);
  }
});

test('comparison groups preserve every model limit and independent reset', async () => {
  const { accountQuotaGroups } = await import('../src/dashboard.js');
  const groups = accountQuotaGroups({ quota: {
    unified7d: 0.2, unified7dReset: 100,
    unified5h: 0.1, unified5hReset: 200,
    scopedWeekly: { sonnet: { utilization: 0.4, resetAt: 300 } },
    unified7dFable: 1, unified7dFableReset: 400,
    codexModelBuckets: { spark: { name: 'Spark', utilization: 0.3, resetAt: 500 } },
  } });
  // `bucket` is the switchThreshold/maxUsage key each row grades against;
  // label, ratio, resetAt and order are what the four page callers read.
  assert.deepEqual(groups.shared, [{ label: 'Weekly', ratio: 0.2, resetAt: 100, bucket: 'unified7d' }]);
  assert.deepEqual(groups.session, [{ label: '5-hour', ratio: 0.1, resetAt: 200, bucket: 'unified5h' }]);
  assert.deepEqual(groups.models, [
    { label: 'Fable weekly', ratio: 1, resetAt: 400, bucket: 'unified7dFable' },
    { label: 'Sonnet weekly', ratio: 0.4, resetAt: 300, bucket: 'unified7dSonnet' },
    { label: 'Spark weekly', ratio: 0.3, resetAt: 500, bucket: null },
  ]);
  assert.equal(accountQuotaGroups({ quota: { tokensLimit: 100, tokensRemaining: 25 } }).shared[0].bucket, 'tokens');
  assert.deepEqual(accountQuotaGroups({ quota: { unified7d: 0.1, tokensLimit: 10, tokensRemaining: 5, requestsLimit: 40, requestsRemaining: 10, resetsAt: 7 } }).shared.map(r => [r.label, r.ratio, r.bucket, r.resetAt]),
    [['Weekly', 0.1, 'unified7d', undefined], ['Tokens', 0.5, 'tokens', 7], ['Requests', 0.75, 'requests', 7]]);
  assert.equal(accountQuotaGroups({ quota: { requestsLimit: 0, requestsRemaining: 0 } }).shared[0].ratio, null);
  assert.equal(accountQuotaGroups({ quota: { requestsLimit: 10 } }).shared[0].ratio, null);
  // A family upstream starts metering that the router has no key for is informational.
  assert.equal(accountQuotaGroups({ quota: { scopedWeekly: { opus: { utilization: 0.1 } } } }).models[0].bucket, null);
  assert.deepEqual(accountQuotaGroups(), { shared: [], session: [], models: [] });
  assert.deepEqual(accountQuotaGroups({}), { shared: [], session: [], models: [] });
  assert.equal(accountQuotaGroups({ quota: { tokensLimit: 0, tokensRemaining: 0 } }).shared[0].ratio, null);
  assert.equal(accountQuotaGroups({ quota: { tokensLimit: 100, tokensRemaining: 25 } }).shared[0].ratio, 0.75);
});

// The grade, limit and binding-limit helpers (FR 4, 5, 9, 10). The fixture at
// artifacts/e2e-pm/dashboard-redesign/ux/status-fixture.json has the fleet at
// { default: 0.98, unified7dFable: 1 } and maxUsage null on every account.
const FLEET = { threshold: 0.98, table: { default: 0.98, unified7dFable: 1 } };
const fixtureAlex = { name: 'alex@personal.dev', provider: 'anthropic', quota: {
  unified5h: 0.01, unified5hReset: 10, unified7d: 0.59, unified7dReset: 20,
  unified7dFable: 0.95, unified7dFableReset: 30, scopedWeekly: { fable: { utilization: 0.95, resetAt: 30 } },
} };

test('quotaGrade: four grades, band edge inclusive, at-limit is at, ratio 1 is spent', () => {
  assert.equal(QUOTA_NEAR_BAND, 0.15);
  assert.equal(quotaGrade(0.23, 0.98), 'ok');
  assert.equal(quotaGrade(0.83, 0.98), 'near');
  assert.equal(quotaGrade(0.829, 0.98), 'ok');
  assert.equal(quotaGrade(0.98, 0.98), 'at');
  assert.equal(quotaGrade(0.979, 0.98), 'near');
  assert.equal(quotaGrade(1, 0.98), 'spent');
  assert.equal(quotaGrade(1.2, 0.98), 'spent');
  assert.equal(quotaGrade(0.999, 1), 'near');
  assert.equal(quotaGrade(1, 1), 'spent');
  for (const missing of [null, undefined, NaN, '0.5']) assert.equal(quotaGrade(missing, 0.98), null);
  // Fixture values (FR 5).
  assert.equal(quotaGrade(0.95, 1.0, QUOTA_NEAR_BAND), 'near');
  assert.equal(quotaGrade(0.91, 0.98, QUOTA_NEAR_BAND), 'near');
  assert.equal(quotaGrade(0.23, 0.98, QUOTA_NEAR_BAND), 'ok');
  // An explicit band is honoured.
  assert.equal(quotaGrade(0.9, 0.98, 0.05), 'ok');
  assert.equal(quotaGrade(0.93, 0.98, 0.05), 'near');
});

test('effectiveLimit: the cap wins only when it is below the threshold', () => {
  assert.deepEqual(effectiveLimit({ maxUsage: 0.6 }, 'unified7d', 0.98, null), { limit: 0.6, kind: 'cap', threshold: 0.98, cap: 0.6 });
  assert.deepEqual(effectiveLimit({ maxUsage: 0.99 }, 'unified7d', 0.98, null), { limit: 0.98, kind: 'threshold', threshold: 0.98, cap: 0.99 });
  assert.deepEqual(effectiveLimit({ maxUsage: null }, 'unified7d', 0.98, null), { limit: 0.98, kind: 'threshold', threshold: 0.98, cap: null });
  assert.deepEqual(effectiveLimit({}, 'unified7d', 0.98, null), { limit: 0.98, kind: 'threshold', threshold: 0.98, cap: null });
  // Table form resolves per bucket, `default` covering the rest.
  const table = { maxUsage: { unified7dFable: 0.5, default: 0.9 } };
  assert.deepEqual(effectiveLimit(table, 'unified7dFable', FLEET.threshold, FLEET.table), { limit: 0.5, kind: 'cap', threshold: 1, cap: 0.5 });
  assert.deepEqual(effectiveLimit(table, 'unified7d', FLEET.threshold, FLEET.table), { limit: 0.9, kind: 'cap', threshold: 0.98, cap: 0.9 });
  // A cap equal to the threshold is not "below" it: the threshold names the limit.
  assert.equal(effectiveLimit({ maxUsage: 0.98 }, 'unified7d', 0.98, null).kind, 'threshold');
  // FR 5: maxUsage 0.6 and weekly 0.62 grades `at` even though the threshold is 0.98.
  assert.equal(quotaGrade(0.62, effectiveLimit({ maxUsage: 0.6 }, 'unified7d', 0.98, null).limit), 'at');
  assert.equal(resolveMaxUsage({ default: 'x' }, 'unified7d'), null);
  assert.equal(resolveMaxUsage(Infinity, 'unified7d'), null);
});

test('switch-threshold precedence: account entry > account default > fleet bucket > fleet default > 0.98', () => {
  const bucket = 'unified7dFable';
  const at = (account, threshold = FLEET.threshold, table = FLEET.table) => effectiveLimit(account, bucket, threshold, table).threshold;
  assert.equal(at({ switchThreshold: { unified7dFable: 0.7, default: 0.8 } }), 0.7);
  assert.equal(at({ switchThreshold: { default: 0.8 } }), 0.8);
  assert.equal(at({ switchThreshold: 0.75 }), 0.75);
  assert.equal(at({}), 1);                 // the fixture's fleet unified7dFable: 1
  assert.equal(at({}, 0.98, { default: 0.9 }), 0.9);
  assert.equal(at({}, 0.95, null), 0.95);
  assert.equal(effectiveLimit({}, bucket, undefined, undefined).threshold, 0.98);
  // The fleet entry for a bucket outranks the fleet default, but never the account's own default.
  assert.equal(fleetFor('unified7dFable', 0.98, FLEET.table), 1);
  assert.equal(fleetFor('unified7d', 0.98, FLEET.table), 0.98);
  assert.equal(resolveSwitchThreshold({ default: 0.8 }, bucket, 1), 0.8);
  // An array or garbage account value falls through to the fleet, as in model.js.
  assert.equal(resolveSwitchThreshold([0.9], bucket, 1), 1);
  assert.equal(resolveSwitchThreshold({ unified7dFable: 'high' }, bucket, 1), 1);
  // Per-model Codex buckets grade against the account's default limit.
  assert.equal(effectiveLimit({ switchThreshold: { default: 0.9 } }, 'default', FLEET.threshold, FLEET.table).limit, 0.9);
  assert.equal(effectiveLimit({}, 'default', FLEET.threshold, FLEET.table).limit, 0.98);
});

test('bindingLimit picks the least headroom among gating buckets, never a per-model row', () => {
  assert.deepEqual(bindingLimit(fixtureAlex, FLEET.threshold, FLEET.table), {
    bucket: 'unified7dFable', label: 'Fable weekly', ratio: 0.95, limit: 1, limitKind: 'threshold',
    headroom: 1 - 0.95, grade: 'near', via: null, resetAt: 30,
  });
  // A Codex account with only per-model buckets reported binds on the shared weekly bucket.
  const codex = { name: 'codex-secondary', provider: 'codex', quota: {
    unified7d: 0.91, unified7dReset: 5, codexModelBuckets: { spark: { name: 'Spark', utilization: 0.99, resetAt: 6 } },
  } };
  const codexBinding = bindingLimit(codex, FLEET.threshold, FLEET.table);
  assert.equal(codexBinding.bucket, 'unified7d');
  assert.equal(codexBinding.grade, 'near');
  assert.equal(bindingLimit({ quota: { codexModelBuckets: { spark: { utilization: 1 } } } }, 0.98, null), null);
  // Tie on headroom: the earlier THRESHOLD_BUCKET_KEYS entry wins (5h before 7d, both ahead of Fable).
  assert.deepEqual(THRESHOLD_BUCKET_KEYS.slice(0, 4), ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable']);
  assert.equal(bindingLimit({ quota: { unified7d: 0.5, unified5h: 0.5 } }, 0.98, null).bucket, 'unified5h');
  assert.equal(bindingLimit({ quota: { unified7d: 0.5, unified7dFable: 0.5, unified7dSonnet: 0.5 } }, 0.98, null).bucket, 'unified7d');
  // Nothing gating reported: null, not a zero-ratio row.
  assert.equal(bindingLimit({}, 0.98, null), null);
  assert.equal(bindingLimit({ quota: { unified7d: null, tokensLimit: 0, tokensRemaining: 0 } }, 0.98, null), null);
  assert.equal(bindingLimit(null, 0.98, null), null);
  // Headroom is measured against the effective limit, so a capped bucket can bind below a fuller one.
  const capped = bindingLimit({ maxUsage: { unified7d: 0.6 }, quota: { unified7d: 0.55, unified5h: 0.9 } }, 0.98, null);
  assert.equal(capped.bucket, 'unified7d');
  assert.equal(capped.limitKind, 'cap');
  assert.equal(capped.grade, 'near');
});

test('an account the server reports as capped or out of quota binds at grade at or spent', () => {
  // maxUsage is null on every fixture account, so both cap shapes are built by hand.
  const bare = { name: 'c', unavailable: 'capped', maxUsage: 0.6, quota: { unified7d: 0.62, unified5h: 0.1 } };
  const table = { name: 't', unavailable: 'capped', maxUsage: { unified7dFable: 0.6, default: 0.95 }, quota: { unified7d: 0.3, unified7dFable: 0.61 } };
  const quota = { name: 'q', unavailable: 'quota', quota: { unified7d: 1, unified5h: 0.2 } };
  for (const account of [bare, table, quota]) {
    const b = bindingLimit(account, FLEET.threshold, FLEET.table);
    assert.ok(b.grade === 'at' || b.grade === 'spent', `${account.name} binds at ${b.grade}`);
  }
  assert.deepEqual([bindingLimit(bare, 0.98, null).bucket, bindingLimit(bare, 0.98, null).limitKind], ['unified7d', 'cap']);
  assert.deepEqual([bindingLimit(table, 0.98, null).bucket, bindingLimit(table, 0.98, null).limit], ['unified7dFable', 0.6]);
  assert.equal(bindingLimit(quota, 0.98, null).grade, 'spent');
  // A requests-only account: the router gates on `requests` (capExceeded in
  // account-manager.js), so the page must find a binding limit there too.
  const reqCapped = { name: 'r', unavailable: 'capped', maxUsage: { requests: 0.5 }, quota: { requestsLimit: 100, requestsRemaining: 45, resetsAt: 9 } };
  assert.deepEqual(bindingLimit(reqCapped, 0.98, null), {
    bucket: 'requests', label: 'Requests', ratio: 0.55, limit: 0.5, limitKind: 'cap', headroom: 0.5 - 0.55, grade: 'at', via: null, resetAt: 9,
  });
  const reqSpent = { name: 's', unavailable: 'quota', quota: { requestsLimit: 100, requestsRemaining: 0 } };
  assert.equal(bindingLimit(reqSpent, 0.98, null).grade, 'spent');
  assert.equal(bindingLimit({ quota: { requestsLimit: 0, requestsRemaining: 0 } }, 0.98, null), null);
});

test('a family gates on the higher of its own weekly and the shared one, as the router does (#175)', () => {
  assert.equal(gatingUtilization({ unified7d: 0.9, unified7dFable: 0.2 }, 'unified7dFable'), 0.9);
  assert.equal(gatingUtilization({ unified7d: 0.3, unified7dFable: 0.5 }, 'unified7dFable'), 0.5);
  assert.equal(gatingUtilization({ unified7d: 0.4, unified7dFable: 0.9 }, 'unified7d'), 0.4);
  assert.equal(gatingUtilization({ unified7d: null, unified7dFable: 0.2 }, 'unified7dFable'), 0.2);
  assert.equal(gatingUtilization({ unified7d: 0.7 }, 'unified7dSonnet'), 0.7);
  assert.equal(gatingUtilization({}, 'unified7dFable'), null);
  assert.equal(gatingUtilization(null, 'unified7d'), null);

  // Family threshold 0.8, shared 1.0: the shared weekly at 0.9 bars Fable at 0.2.
  const account = { switchThreshold: { unified7dFable: 0.8, unified7d: 1 }, quota: { unified7d: 0.9, unified7dFable: 0.2, unified7dFableReset: 4 } };
  const fable = accountQuotaGroups(account).models[0];
  assert.deepEqual(quotaGate(account, fable, 0.98, null), { limit: 0.8, kind: 'threshold', ratio: 0.9, headroom: 0.8 - 0.9, grade: 'at', via: 0.9 });
  const b = bindingLimit(account, 0.98, null);
  assert.deepEqual([b.bucket, b.label, b.ratio, b.grade, b.via, b.limit], ['unified7dFable', 'Fable weekly', 0.2, 'at', 0.9, 0.8]);
  // The shared row itself grades on its own reading, with nothing to explain.
  assert.deepEqual([quotaGate(account, accountQuotaGroups(account).shared[0], 0.98, null).grade, quotaGate(account, accountQuotaGroups(account).shared[0], 0.98, null).via], ['near', null]);

  // A family cap compares the family reading alone (capExceeded), so it can still bind.
  const capped = { maxUsage: { unified7dFable: 0.3 }, quota: { unified7d: 0.5, unified7dFable: 0.25 } };
  assert.deepEqual(quotaGate(capped, accountQuotaGroups(capped).models[0], 0.98, null), { limit: 0.3, kind: 'cap', ratio: 0.25, headroom: 0.3 - 0.25, grade: 'near', via: null });

  // A scoped family with no key gates on max(shared, scoped) against the shared threshold, and binds when it is tighter.
  const opus = { quota: { unified7d: 0.5, scopedWeekly: { opus: { utilization: 0.97 } } } };
  const ob = bindingLimit(opus, 0.98, null);
  assert.deepEqual([ob.bucket, ob.label, ob.grade, ob.via], ['unified7d', 'Opus weekly', 'near', null]);
  // Tied with the Weekly row it gates under, the Weekly row keeps the binding.
  const tied = { quota: { unified7d: 0.6, scopedWeekly: { opus: { utilization: 0.1 } } } };
  assert.equal(bindingLimit(tied, 0.98, null).label, 'Weekly');
  assert.equal(quotaGate(tied, accountQuotaGroups(tied).models[0], 0.98, null).via, 0.6);
});

test('fixture grades are unchanged by the governing-weekly gate', () => {
  // Quotas copied from the fixture (FLEET above); none has the shared weekly above its family.
  const work = { quota: { unified5h: 0, unified7d: 0.23, unified7dFable: 0.25, scopedWeekly: { fable: { utilization: 0.25 } } } };
  const secondary = { provider: 'codex', quota: { unified7d: 0.91, codexModelBuckets: {} } };
  /** @param {any} a */
  const grades = a => { const g = accountQuotaGroups(a); return g.shared.concat(g.session, g.models).map(r => [r.label, quotaGate(a, r, FLEET.threshold, FLEET.table).grade, quotaGate(a, r, FLEET.threshold, FLEET.table).via]); };
  assert.deepEqual(grades(fixtureAlex), [['Weekly', 'ok', null], ['5-hour', 'ok', null], ['Fable weekly', 'near', null]]);
  assert.deepEqual(grades(work), [['Weekly', 'ok', null], ['5-hour', 'ok', null], ['Fable weekly', 'ok', null]]);
  assert.deepEqual(grades(secondary), [['Weekly', 'near', null]]);
});

test('currentAccounts is authoritative; the global currentAccount only answers without it', () => {
  assert.equal(currentFor({ currentAccounts: { anthropic: 'a' }, currentAccount: 'a' }, 'codex'), null);
  assert.equal(currentFor({ currentAccounts: { anthropic: 'a' }, currentAccount: 'a' }, 'anthropic'), 'a');
  assert.equal(currentFor({ currentAccount: 'a' }, 'codex'), 'a');
  assert.equal(currentFor(null, 'codex'), null);
  const status = {
    currentAccount: 'a', currentAccounts: { anthropic: 'a' },
    accounts: [{ name: 'a', provider: 'anthropic' }],
    defaultTargets: { anthropic: 'a', codex: null },
    providerRouting: [{ provider: 'anthropic', models: [] }, { provider: 'codex', models: [] }],
  };
  const lines = routeStripLines(status);
  const codex = lines.find(l => l.provider === 'codex');
  assert.ok(codex, 'codex line rendered');
  assert.ok(!codex.why.some(w => /^Current:/.test(w.text)), JSON.stringify(codex.why));
  // Legacy server: one global cursor, no map.
  const legacy = { currentAccount: 'a', accounts: [{ name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic' }],
    defaultTargets: { anthropic: 'b' }, providerRouting: [{ provider: 'anthropic', models: [] }] };
  assert.ok(routeStripLines(legacy)[0].why.some(w => /^Current: a/.test(w.text)));
});

test('requests takes part in least-headroom selection and is last in the tie-break', () => {
  assert.equal(THRESHOLD_BUCKET_KEYS[THRESHOLD_BUCKET_KEYS.length - 1], 'requests');
  // Less headroom than the weekly bucket: requests binds.
  assert.equal(bindingLimit({ quota: { unified7d: 0.5, requestsLimit: 10, requestsRemaining: 1 } }, 0.98, null).bucket, 'requests');
  // More headroom: weekly binds.
  assert.equal(bindingLimit({ quota: { unified7d: 0.9, requestsLimit: 10, requestsRemaining: 5 } }, 0.98, null).bucket, 'unified7d');
  // Exact tie with tokens (same ratio, same limit): tokens is earlier in THRESHOLD_BUCKET_KEYS.
  assert.equal(bindingLimit({ quota: { tokensLimit: 10, tokensRemaining: 5, requestsLimit: 10, requestsRemaining: 5 } }, 0.98, null).bucket, 'tokens');
  assert.equal(bindingLimit({ quota: { unified5h: 0.5, requestsLimit: 10, requestsRemaining: 5 } }, 0.98, null).bucket, 'unified5h');
  // A per-bucket cap on requests lowers its limit, and so its headroom.
  const b = bindingLimit({ maxUsage: { requests: 0.6 }, quota: { unified7d: 0.5, requestsLimit: 10, requestsRemaining: 5 } }, 0.98, null);
  assert.deepEqual([b.bucket, b.limitKind, b.grade], ['requests', 'cap', 'near']);
});

test('the grade helpers run inside the serialized bundle with fixture data', () => {
  // Each helper reads QUOTA_NEAR_BAND / THRESHOLD_BUCKET_KEYS, which only reach
  // the page through SHARED_CONSTS; a ReferenceError here is one at first render.
  const html = renderDashboardHtml();
  assert.match(html, /var QUOTA_NEAR_BAND = 0\.15;/);
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const page = new Function(`${bundle}; return { fleetFor, resolveSwitchThreshold, resolveMaxUsage, effectiveLimit, quotaGrade, bindingLimit, accountQuotaGroups };`)();
  assert.equal(page.quotaGrade(0.95, 1), 'near');
  assert.equal(page.fleetFor('unified7dFable', FLEET.threshold, FLEET.table), 1);
  assert.equal(page.resolveSwitchThreshold({ default: 0.8 }, 'unified7d', 0.98), 0.8);
  assert.equal(page.resolveMaxUsage({ default: 0.6 }, 'unified7d'), 0.6);
  assert.deepEqual(page.effectiveLimit({ maxUsage: 0.6 }, 'unified7d', 0.98, null), effectiveLimit({ maxUsage: 0.6 }, 'unified7d', 0.98, null));
  assert.deepEqual(page.bindingLimit(fixtureAlex, FLEET.threshold, FLEET.table), bindingLimit(fixtureAlex, FLEET.threshold, FLEET.table));
  assert.deepEqual(page.accountQuotaGroups(fixtureAlex), accountQuotaGroups(fixtureAlex));
});

test('the palette tokens are defined once in :root', () => {
  const html = renderDashboardHtml();
  const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
  for (const [token, hex] of [
    ['--claude', '#e8956a'], ['--claude-soft', '#2a1d16'], ['--codex', '#3fbfd0'], ['--codex-soft', '#12242a'], ['--other', '#a0abba'],
    ['--grade-ok', '#9ad46e'], ['--grade-ok-ink', '#b9e394'], ['--grade-ok-soft', '#1c2a19'],
    ['--grade-near', '#f2d060'], ['--grade-near-ink', '#f5db85'], ['--grade-near-soft', '#2e2814'],
    ['--grade-at', '#e8506a'], ['--grade-at-ink', '#ff9aae'], ['--grade-at-soft', '#33181e'],
    ['--grade-spent', '#e8506a'], ['--track', '#262d39'], ['--panel-2', '#1b2029'],
  ]) {
    assert.ok(root.includes(`${token}:${hex};`), `${token} missing from :root`);
    assert.equal(html.split(`${token}:`).length, 2, `${token} defined more than once`);
  }
  // One inline script block: the CSP hashes exactly that one.
  assert.equal(html.split('<script').length, 2);
});

test('session activity copy distinguishes no observations from unavailable tracking', async () => {
  const { sessionActivityText } = await import('../src/dashboard.js');
  assert.equal(sessionActivityText({ active: 0 }), 'No recent Claude session IDs observed');
  assert.equal(sessionActivityText({ active: 1 }), '1 recent Claude session ID');
  assert.equal(sessionActivityText({ active: 3 }), '3 recent Claude session IDs');
  assert.equal(sessionActivityText(), 'Session tracking unavailable');
  assert.equal(sessionActivityText({}), 'Session tracking unavailable');
});

test('reset history rows date scheduled rolls by the window and early resets by the confirming probe', () => {
  const w = { type: 'restarted-window', before: { utilization: 0.19, at: 100, resetAt: 150 }, after: { label: '5-hour', utilization: 0.02, at: 200, resetAt: 900 } };
  const rows = resetHistoryRows([
    { account: 'a', timing: 'scheduled', windows: [w] },
    { account: 'b', timing: 'early', windows: [{ ...w, type: 'quota-refill' }, w] },
    { account: 'c', timing: 'uncertain', windows: [w] },
  ]);
  // Newest first (T4, RT 2); equal times keep their event order.
  assert.deepEqual(rows.map(r => [r.account, r.when, r.what, r.kind]), [
    ['b', 200, 'Reset early, quota refilled', 'warn'],
    ['b', 200, 'Reset early, window restarted', 'warn'],
    ['c', 200, 'Reset, timing unclear', 'dim'],
    ['a', 150, 'Rolled over on schedule', ''],
  ]);
  assert.deepEqual([rows[3].before, rows[3].after, rows[3].window, rows[3].observed, rows[3].resetAt], [19, 2, '5-hour', [100, 200], [150, 900]]);
  assert.deepEqual(resetHistoryRows(undefined), []);
  const html = renderDashboardHtml();
  assert.match(html, /id="resetEvents" class="reset-table"/);
  assert.match(html, /function resetHistoryRows/);
});

// ---- T2: the account table, graded bars, binding line, badges, account dialog ----

// A tree the page can render into: children, class, attributes, style,
// listeners and a small selector engine (compound selectors, descendant
// combinator, comma lists). Nothing lays out. Elements looked up by id are
// created on demand as detached roots, like the stub above; an unmatched
// document.querySelector hands back a throwaway node so the renderers this
// task does not touch keep going.
function fakeDom() {
  let focused = null;
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.parentNode = null; this.value = ''; this.open = false; this.disabled = false; this.hidden = false; }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }
    get classList() { const n = this, list = () => n.className.split(/\s+/).filter(Boolean); return { contains: c => list().includes(c), add: c => { if (!list().includes(c)) n.className = list().concat(c).join(' '); }, remove: c => { n.className = list().filter(x => x !== c).join(' '); } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    replaceChildren() { this.children = []; }
    get textContent() { return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
    set textContent(v) { this.children = v == null || v === '' ? [] : [String(v)]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type) { (this.listeners[type] || []).forEach(fn => fn.call(this, { type, key: '' })); }
    click() { this.dispatch('click'); }
    focus() { focused = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
    matches(compound) {
      return compound.split(/(?=[.#[])/).every(part => {
        if (part[0] === '.') return this.className.split(/\s+/).includes(part.slice(1));
        if (part[0] === '#') return this.attrs.id === part.slice(1);
        if (part[0] === '[') { const m = /^\[([\w-]+)(?:="?([^\]"]*)"?)?\]$/.exec(part); return m[2] == null ? m[1] in this.attrs : this.attrs[m[1]] === m[2]; }
        return this.tagName === part.toUpperCase();
      });
    }
    querySelectorAll(selector) {
      const out = [];
      for (const n of this.walk()) {
        if (selector.split(',').some(sel => {
          const parts = sel.trim().split(/\s+/);
          if (!n.matches(parts[parts.length - 1])) return false;
          let i = parts.length - 2, a = n.parentNode;
          while (i >= 0 && a) { if (a.matches(parts[i])) i--; a = a.parentNode; }
          return i < 0;
        })) out.push(n);
      }
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  const root = new Node('html');
  const body = new Node('body'); root.appendChild(body);
  const byId = new Map();
  return {
    body,
    createElement: tag => new Node(tag),
    getElementById: id => { if (!byId.has(id)) { const n = new Node('div'); n.attrs.id = id; root.appendChild(n); byId.set(id, n); } return byId.get(id); },
    querySelectorAll: sel => root.querySelectorAll(sel),
    querySelector: sel => root.querySelector(sel) || new Node('div'),
    contains: () => true,
    get focused() { return focused; },
  };
}

// The sanitized fixture's four accounts (artifacts/e2e-pm/dashboard-redesign/
// ux/status-fixture.json), reset times moved relative to now so the countdown
// wording does not rot.
function fixtureStatus() {
  const day = 86400e3, now = Date.now();
  const acct = (name, provider, quota, extra = {}) => ({ name, provider, type: 'oauth', status: 'active', priority: 0, unavailable: null, disabled: false, maxUsage: null, switchThreshold: null, quota, usage: {}, ...extra });
  return {
    switchThreshold: 0.98, switchThresholds: { default: 0.98, unified7dFable: 1 },
    currentAccounts: { anthropic: 'alex@personal.dev', codex: 'codex-primary' },
    defaultTargets: { anthropic: 'alex@personal.dev', codex: 'codex-primary' },
    probe: { enabled: true, intervalSeconds: 600, accounts: [] },
    accounts: [
      acct('alex@personal.dev', 'anthropic', { unified5h: 0.01, unified5hReset: now + 5 * 3600e3, unified7d: 0.59, unified7dReset: now + 3.6 * day, unified7dFable: 0.95, unified7dFableReset: now + 3.6 * day, scopedWeekly: { fable: { utilization: 0.95, resetAt: now + 3.6 * day } } }),
      acct('alex@work.co', 'anthropic', { unified5h: 0, unified7d: 0.23, unified7dReset: now + 4.6 * day, unified7dFable: 0.25, unified7dFableReset: now + 4.6 * day, scopedWeekly: { fable: { utilization: 0.25, resetAt: now + 4.6 * day } } }),
      acct('codex-primary', 'codex', { unified7d: 0.72, unified7dReset: now + 1.4 * day, codexModelBuckets: {} }),
      acct('codex-secondary', 'codex', { unified7d: 0.91, unified7dReset: now + 1.4 * day, codexModelBuckets: {} }),
    ],
  };
}

// Boot the page against the fake DOM and answer its first poll. A render error
// lands in #err (poll's catch), so it is asserted away here rather than hidden.
async function renderPage(status = fixtureStatus()) {
  const dom = fakeDom();
  const page = bootPage({ dom });
  await page.answer(200, status);
  assert.notEqual(dom.getElementById('err').style.display, 'block', dom.getElementById('err').textContent);
  const rowFor = name => dom.querySelectorAll('tr.account-row').find(r => r.querySelector('.account-name').textContent === name);
  const quotas = node => node.querySelectorAll('.quota').map(q => ({ label: q.querySelector('.lbl').textContent, marked: q.querySelector('.lbl').matches('.binding-mark'), grade: q.getAttribute('data-grade'), bar: q.querySelector('.bar'), val: q.querySelector('.val') }));
  return { ...page, dom, rowFor, quotas, refresh: async (nextStatus, code = 200) => { dom.getElementById('refresh').click(); await page.answer(code, nextStatus); } };
}

test('capBadgeText names a bare cap, a table by bucket, and nothing for no cap', () => {
  assert.equal(capBadgeText(0.6), 'cap 60%');
  assert.equal(capBadgeText({ unified7d: 0.6, unified7dFable: 0.5 }), 'cap 7d 60%, fable 50%');
  assert.equal(capBadgeText({ default: 0.9, junk: 0.1 }), 'cap 90%');
  for (const none of [null, undefined, NaN, [], {}, { unified7d: 'x' }, 'text']) assert.equal(capBadgeText(none), '');
});

test('T2: rows group by provider under a tinted heading, Claude first, every row and heading tinted by data-provider', async () => {
  const { dom } = await renderPage();
  const order = dom.querySelectorAll('#accounts tr').filter(tr => tr.className).map(tr => tr.className + ':' + tr.getAttribute('data-provider'));
  assert.deepEqual(order, ['provider-heading:anthropic', 'account-row:anthropic', 'account-row:anthropic', 'provider-heading:codex', 'account-row:codex', 'account-row:codex']);
  const headings = dom.querySelectorAll('tr.provider-heading');
  assert.deepEqual(headings.map(h => h.textContent), ['Claude · 2 accounts', 'Codex · 2 accounts']);
  assert.deepEqual(headings.map(h => h.querySelector('b').textContent), ['Claude', 'Codex']);
  // Text beside the tint on a mixed fleet: the provider badge.
  assert.deepEqual(dom.querySelectorAll('tr.account-row .badge.provider').map(b => b.className + '=' + b.textContent), ['badge provider anthropic=Claude', 'badge provider anthropic=Claude', 'badge provider codex=Codex', 'badge provider codex=Codex']);
  // The page string carries both attributes; the CSS tints by them, never inline.
  const html = renderDashboardHtml();
  assert.ok(html.includes('data-grade') && html.includes('data-provider'));
  assert.doesNotMatch(html, /Within reported limits/);
});

test('T2: Codex stays second behind Claude ahead of an alphabetically earlier provider; no provider groups last', async () => {
  const s = fixtureStatus();
  s.accounts.push({ ...s.accounts[3], name: 'az-1', provider: 'azure' }, { ...s.accounts[3], name: 'nobody', provider: null });
  s.defaultTargets = { codex: 'codex-primary', azure: 'az-1', anthropic: 'alex@personal.dev' };
  s.currentAccounts = { azure: 'az-1', codex: 'codex-primary', anthropic: 'alex@personal.dev' };
  const { dom } = await renderPage(s);
  assert.deepEqual(dom.querySelectorAll('tr.provider-heading').map(h => h.getAttribute('data-provider') + ':' + h.textContent),
    ['anthropic:Claude · 2 accounts', 'codex:Codex · 2 accounts', 'azure:azure · 1 account', 'unknown:Unknown · 1 account']);
  // The same comparator orders routeRows' default rows and the current-account line.
  assert.deepEqual(['codex', 'azure', 'zeta', 'anthropic', '', 'bravo'].sort(providerOrder), ['anthropic', 'codex', 'azure', 'bravo', 'zeta', '']);
  assert.deepEqual(routeRows({ routes: [{ name: 'r', accounts: [] }], defaultTargets: s.defaultTargets }).filter(r => r.kind === 'default').map(r => r.provider), ['anthropic', 'codex', 'azure']);
  // The current-account line is gone (T3); the Overview strip carries the order now,
  // whatever order the server lists providers in.
  const listed = { accounts: s.accounts, currentAccounts: s.currentAccounts, providerRouting: ['azure', 'codex', 'anthropic'].map(provider => ({ provider, models: [{ label: 'm', model: 'm', target: s.currentAccounts[provider] }] })) };
  assert.deepEqual(routeStripLines(listed).map(l => l.provider), ['anthropic', 'codex', 'azure']);
});

test('T2: every bar is graded via the effective limit, marks the tick at it, and says so to a screen reader', async () => {
  const { dom, rowFor, quotas } = await renderPage();
  const bars = dom.querySelectorAll('#accounts .bar');
  assert.equal(bars.length, 8);
  for (const bar of bars) {
    assert.ok(['ok', 'near', 'at', 'spent'].includes(bar.getAttribute('data-grade')), 'bar has a grade');
    assert.equal(bar.querySelector('i').className, bar.getAttribute('data-grade'), 'fill class is the grade');
    assert.equal(bar.getAttribute('role'), 'meter');
    assert.match(bar.querySelector('b').style.left, /^(98|100)%$/, 'tick at the effective limit');
  }
  const alex = quotas(rowFor('alex@personal.dev'));
  assert.deepEqual(alex.map(q => [q.label, q.grade, q.marked, q.bar.querySelector('b').style.left]), [['Weekly', 'ok', false, '98%'], ['5-hour', 'ok', false, '98%'], ['Fable weekly', 'near', true, '100%']]);
  assert.match(alex[2].bar.getAttribute('aria-valuetext'), /^95% spent, near, switch at 100%, resets in 3\.\dd$/);
  assert.equal(alex[2].bar.getAttribute('aria-valuenow'), '95');
  assert.equal(alex[2].val.textContent, '95% spentnear');
  assert.equal(alex[2].val.querySelector('.g').textContent, 'near');
  assert.equal(quotas(rowFor('codex-secondary'))[0].grade, 'near');
  assert.equal(quotas(rowFor('alex@work.co'))[0].grade, 'ok');
  for (const q of dom.querySelectorAll('#accounts .quota')) assert.ok(q.querySelector('.val').textContent.endsWith(q.getAttribute('data-grade')), 'value line ends with the grade word');
});

test('T2: a cap below the threshold binds: red cap tick, fill past it, `at` short of full, per-model rows graded but never marked', async () => {
  const s = fixtureStatus();
  const now = Date.now();
  s.accounts[2].maxUsage = 0.6; s.accounts[2].unavailable = 'capped'; s.accounts[2].quota.unified7d = 0.62;
  s.accounts[2].quota.codexModelBuckets = { spark: { name: 'Spark', utilization: 0.4, resetAt: now + 86400e3 } };
  const { rowFor, quotas } = await renderPage(s);
  const row = rowFor('codex-primary');
  const q = quotas(row);
  assert.deepEqual(q.map(x => [x.label, x.grade, x.marked, x.bar.getAttribute('data-grade'), x.bar.querySelector('b').className, x.bar.querySelector('b').style.left, x.bar.querySelector('i').style.width]),
    [['Weekly', 'at', true, 'at', 'cap', '60%', '62%'], ['Spark weekly', 'ok', false, 'ok', 'cap', '60%', '40%']]);
  assert.match(q[0].bar.getAttribute('aria-valuetext'), /^62% spent, at, cap 60%, resets in /);
  const binding = row.querySelector('.binding');
  assert.equal(binding.getAttribute('data-grade'), 'at');
  assert.match(binding.querySelector('.sub2').textContent, /^cap 60% · resets in /);
  // The status badge is the router's own verdict, worded by UNAVAILABLE_TEXT, in the `at` red.
  assert.deepEqual(row.querySelectorAll('.badges .badge').map(b => [b.className, b.textContent]),
    [['badge at', UNAVAILABLE_TEXT.capped], ['badge current', 'current'], ['badge provider codex', 'Codex'], ['badge meta cap', 'cap 60%']]);
});

test('T2: each row has exactly one binding line naming the bucket, percentage, grade, limit kind and countdown; the marked label is that bucket only', async () => {
  const { dom, rowFor } = await renderPage();
  for (const row of dom.querySelectorAll('tr.account-row')) {
    assert.equal(row.querySelectorAll('.binding').length, 1);
    assert.equal(row.querySelectorAll('.lbl.binding-mark').length, 1);
    assert.equal(row.querySelector('.binding .dot').getAttribute('aria-hidden'), 'true');
  }
  const alex = rowFor('alex@personal.dev').querySelector('.binding');
  assert.equal(alex.getAttribute('data-grade'), 'near');
  assert.equal(alex.children[1].textContent, 'Fable weekly 95% spent · near');
  assert.equal(alex.querySelector('b').textContent, 'Fable weekly');
  assert.equal(alex.querySelector('.g').textContent, 'near');
  assert.match(alex.querySelector('.sub2').textContent, /^switch at 100% · resets in 3\.\dd$/);
  assert.equal(rowFor('alex@personal.dev').querySelector('.lbl.binding-mark').textContent, 'Fable weekly');
  assert.equal(rowFor('alex@work.co').querySelector('.lbl.binding-mark').textContent, 'Weekly');
  assert.equal(rowFor('codex-secondary').querySelector('.binding').children[1].textContent, 'Weekly 91% spent · near');
});

test('T2: the Left toggle changes numbers and fill widths but no grade, and persists under the same key', async () => {
  const { dom, store } = await renderPage();
  const grades = () => dom.querySelectorAll('[data-grade]').map(e => e.getAttribute('data-grade')).join();
  const vals = () => dom.querySelectorAll('.quota .val').map(v => v.textContent).join('|');
  const widths = () => dom.querySelectorAll('.bar i').map(i => i.style.width).join();
  const [g, v, w] = [grades(), vals(), widths()];
  assert.equal(dom.getElementById('quotaSpent').getAttribute('aria-pressed'), 'true');
  dom.getElementById('quotaLeft').click();
  assert.equal(grades(), g);
  assert.notEqual(vals(), v); assert.notEqual(widths(), w);
  assert.equal(store.get('teamclaude-quota-display'), 'left');
  assert.equal(dom.getElementById('quotaLeft').getAttribute('aria-pressed'), 'true');
  assert.match(dom.querySelector('tr.account-row .binding').children[1].textContent, /^Fable weekly 5% left · near$/);
  assert.match(dom.querySelector('tr.account-row .bar').getAttribute('aria-valuetext'), /^59% spent, ok/, 'aria text stays on the spent ratio');
});

test('T2: an unreported ratio renders "Not reported" and no bar; no gating bucket reads "No quota reported"', async () => {
  const s = fixtureStatus();
  s.accounts = [{ ...s.accounts[0], name: 'blank', quota: { unified7d: null, tokensLimit: 10, tokensRemaining: null } }];
  const { rowFor } = await renderPage(s);
  const row = rowFor('blank');
  assert.equal(row.querySelectorAll('.bar').length, 0);
  assert.deepEqual(row.querySelectorAll('.quota-unknown').map(e => e.textContent), ['Not reported', 'No window reported', 'No window reported']);
  assert.equal(row.querySelector('.quota .lbl').textContent, 'Tokens');
  assert.equal(row.querySelectorAll('.binding').length, 1);
  assert.equal(row.querySelector('.binding').getAttribute('data-grade'), 'none');
  assert.equal(row.querySelector('.binding').textContent, 'No quota reported');
  assert.equal(row.querySelectorAll('.badges .badge').length, 0, 'no status badge for an account with nothing to report');
});

test('T2: healthy rows carry no status badge; current and threshold-override badges stay; only trouble gets a graded badge', async () => {
  const s = fixtureStatus();
  s.accounts[1].switchThreshold = 0.9;
  s.accounts.push({ ...s.accounts[1], name: 'spent', quota: { unified7d: 1, unified7dReset: Date.now() + 1000 } },
    { ...s.accounts[1], name: 'login', status: 'error', unavailable: 'error' },
    { ...s.accounts[1], name: 'hold', status: 'throttled' },
    { ...s.accounts[1], name: 'off', disabled: true });
  const { rowFor } = await renderPage(s);
  const badges = name => rowFor(name).querySelectorAll('.badges .badge').map(b => [b.className, b.textContent]);
  assert.deepEqual(badges('alex@personal.dev'), [['badge current', 'current'], ['badge provider anthropic', 'Claude']]);
  assert.deepEqual(badges('alex@work.co'), [['badge provider anthropic', 'Claude'], ['badge meta threshold', 'switch at 90%']]);
  assert.deepEqual(badges('codex-secondary'), [['badge provider codex', 'Codex']]);
  assert.deepEqual(badges('spent')[0], ['badge spent', 'Weekly exhausted']);
  assert.deepEqual(badges('login')[0], ['badge at', UNAVAILABLE_TEXT.error]);
  assert.deepEqual(badges('hold')[0], ['badge near', 'Rate limited']);
  assert.deepEqual(badges('off')[0], ['badge error', 'Disabled']);
  assert.equal(rowFor('spent').querySelector('.bar').getAttribute('data-grade'), 'spent');
});

test('T2: a single-provider fleet drops the provider badge but keeps the tint on rows and the heading', async () => {
  const s = fixtureStatus();
  s.accounts = s.accounts.filter(a => a.provider === 'anthropic');
  const { dom } = await renderPage(s);
  assert.equal(dom.querySelectorAll('.badge.provider').length, 0);
  assert.deepEqual(dom.querySelectorAll('tr.account-row').map(r => r.getAttribute('data-provider')), ['anthropic', 'anthropic']);
  assert.deepEqual(dom.querySelectorAll('tr.provider-heading').map(r => r.getAttribute('data-provider') + ':' + r.textContent), ['anthropic:Claude · 2 accounts']);
});

test('T2: the account dialog carries the provider, the binding line above the bars, the same grades as the row, and its stale and gone lines', async () => {
  const page = await renderPage();
  const { dom, rowFor, quotas } = page;
  rowFor('alex@personal.dev').querySelector('button.act').click();
  const dialog = dom.getElementById('accountDialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('data-provider'), 'anthropic');
  assert.equal(dom.getElementById('accountDialogTitle').textContent, 'alex@personal.dev');
  const details = dom.getElementById('accountDetails');
  assert.deepEqual(details.children.map(c => c.className.split(' ')[0]).slice(0, 4), ['badges', 'binding', 'usage', 'quota']);
  assert.equal(details.querySelector('.binding').children[1].textContent, 'Fable weekly 95% spent · near');
  assert.deepEqual(quotas(details).map(q => [q.label, q.grade, q.marked]), quotas(rowFor('alex@personal.dev')).map(q => [q.label, q.grade, q.marked]));
  assert.equal(details.querySelectorAll('.badge').length, 2);
  // A failed poll while the dialog is open adds the stale line and keeps everything else.
  await page.refresh({}, 500);
  assert.equal(details.querySelector('p.warnt').textContent, 'Connection lost. These quota values may be stale.');
  assert.equal(details.querySelector('p.warnt').getAttribute('role'), 'status');
  assert.equal(dom.getElementById('accountManual').disabled, true);
  // The account leaving the status swaps the body for the existing line and drops the tint.
  await page.refresh({ ...fixtureStatus(), accounts: [] });
  assert.equal(details.textContent, 'This account is no longer in the latest status.');
  assert.equal(dialog.getAttribute('data-provider'), null);
});

test('T2: the capped account dialog says cap 60% on its binding line and its bar wears the cap tick', async () => {
  const s = fixtureStatus();
  s.accounts[2].maxUsage = 0.6; s.accounts[2].unavailable = 'capped'; s.accounts[2].quota.unified7d = 0.62;
  const { dom, rowFor } = await renderPage(s);
  rowFor('codex-primary').querySelector('button.act').click();
  const dialog = dom.getElementById('accountDialog');
  assert.equal(dialog.getAttribute('data-provider'), 'codex');
  assert.match(dom.getElementById('accountDetails').querySelector('.binding').textContent, /cap 60%/);
  assert.ok(dom.getElementById('accountDetails').querySelector('.bar b.cap'));
  assert.equal(dom.getElementById('accountDetails').querySelector('.bar').getAttribute('data-grade'), 'at');
});

test('T2: search keeps its id and its empty copy', async () => {
  const { dom } = await renderPage();
  const search = dom.getElementById('accountSearch');
  search.value = 'zzz'; search.dispatch('input');
  assert.equal(dom.getElementById('accountCount').textContent, '0 of 4 accounts');
  assert.equal(dom.getElementById('accounts').textContent, 'No matching accounts.');
  search.value = 'codex'; search.dispatch('input');
  assert.equal(dom.getElementById('accountCount').textContent, '2 of 4 accounts');
  assert.deepEqual(dom.querySelectorAll('tr.provider-heading').map(h => h.getAttribute('data-provider')), ['codex']);
});

// ---- T3: Overview routing strip, Routing split, inline Force, problems tint, dialogs ----

// fixtureStatus plus the fixture's providerRouting and routes: Claude models all
// land on alex@personal.dev with no route; Codex's configured codex-default is
// forced to codex-secondary (two samples) and Fable has an autocreated route.
function routedStatus() {
  const s = fixtureStatus();
  const both = names => names.map(name => ({ name, eligible: true }));
  const claude = both(['alex@personal.dev', 'alex@work.co']), codex = both(['codex-primary', 'codex-secondary']);
  const model = (provider, label, m, accounts, extra = {}) => ({ provider, label, model: m, blocked: false, route: null, pinned: null, target: accounts[0].name, accounts, ...extra });
  const codexRoute = { route: 'codex-default', pinned: 'codex-secondary', target: 'codex-secondary' };
  s.providerRouting = [
    { provider: 'anthropic', label: 'Claude', models: ['Opus', 'Sonnet', 'Haiku', 'Fable'].map(l => model('anthropic', l, 'claude-' + l.toLowerCase(), claude)) },
    { provider: 'codex', label: 'Codex', models: [model('codex', 'General', 'gpt-6-astra', codex, codexRoute), model('codex', 'gpt-*', 'gpt-', codex, codexRoute), model('codex', '*codex*', 'codex', codex, codexRoute)] },
  ];
  s.routes = [
    { name: 'codex-default', match: ['gpt-*', '*codex*'], autocreated: false, id: 'configured:codex-default', provider: 'codex', pinned: 'codex-secondary',
      previews: [model('codex', 'gpt-*', 'gpt-', codex, codexRoute), model('codex', '*codex*', 'codex', codex, codexRoute)],
      members: ['codex-primary', 'codex-secondary'], accounts: codex, target: 'codex-secondary',
      override: { account: 'codex-secondary', whenSpent: 'fallback', source: 'config', since: 1, state: 'effective', reason: null },
      persisted: { account: 'codex-secondary', whenSpent: 'fallback' } },
    { name: 'fable', match: ['*fable*'], autocreated: true, id: 'auto:fable', provider: 'anthropic', pinned: null,
      previews: [model('anthropic', '*fable*', 'claude-fable-5', claude)], members: ['alex@personal.dev', 'alex@work.co'], accounts: claude, target: 'alex@personal.dev' },
  ];
  s.forceBlocked = false;
  return s;
}

const stripText = lines => lines.map(l => ({ provider: l.provider, headline: l.headline, tag: l.tag, why: l.why.map(w => w.text) }));

test('T3: the strip has one line per provider with the fixture headlines, tag and why lines', async () => {
  assert.deepEqual(stripText(routeStripLines(routedStatus())), [
    { provider: 'anthropic', headline: 'alex@personal.dev', tag: null, why: ['Also the current account'] },
    { provider: 'codex', headline: 'codex-secondary', tag: 'forced', why: ['Default target: codex-primary', 'Current: codex-primary'] },
  ]);
  const { dom } = await renderPage(routedStatus());
  const lines = dom.getElementById('routeStripLines').querySelectorAll('.strip-line');
  assert.deepEqual(lines.map(l => l.getAttribute('data-provider')), ['anthropic', 'codex']);
  assert.deepEqual(lines.map(l => l.querySelector('.strip-provider').textContent), ['Claude2 accounts', 'Codex2 accounts']);
  assert.equal(lines[0].querySelector('.strip-target').textContent, 'alex@personal.dev');
  assert.equal(lines[1].querySelector('.strip-target').textContent, 'codex-secondaryforced');
  assert.equal(lines[1].querySelector('.strip-target .badge').textContent, 'forced');
  assert.deepEqual(lines[0].querySelectorAll('.strip-why').map(w => w.textContent), ['Also the current account']);
  assert.deepEqual(lines[1].querySelectorAll('.strip-why').map(w => w.textContent), ['Default target: codex-primary', 'Current: codex-primary']);
  assert.ok(lines.every(l => !l.querySelector('.strip-target').matches('.warnt')), 'a resolved headline is not in near ink');
});

test('T3: the strip carries the is-blocked and outranks sentences the default rows used to', () => {
  const capped = routedStatus();
  capped.defaultTargets.codex = 'codex-secondary';
  capped.accounts[2].unavailable = 'capped';
  const codex = routeStripLines(capped)[1];
  assert.deepEqual(codex.why.map(w => w.text), ['Current: codex-primary · current account codex-primary is blocked: ' + UNAVAILABLE_TEXT.capped]);
  assert.equal(codex.why[0].warn, true);
  const outranked = routedStatus();
  outranked.defaultTargets.codex = 'codex-secondary';
  assert.deepEqual(routeStripLines(outranked)[1].why.map(w => w.text), ['Current: codex-primary · codex-secondary outranks the current account codex-primary']);
  // A null default (nothing can serve) still explains a blocked current account; outranks needs a name.
  const nothing = { currentAccounts: { anthropic: 'a' }, defaultTargets: { anthropic: null },
    accounts: [{ name: 'a', provider: 'anthropic', unavailable: 'capped' }],
    providerRouting: [{ provider: 'anthropic', models: [{ label: 'm', model: 'm', target: null }] }],
    routes: [{ name: 'r', match: ['m*'], members: ['a'], previews: [{ provider: 'anthropic', label: 'm*', model: 'm', target: null, accounts: [] }] }] };
  assert.equal(routeRows(nothing).find(r => r.kind === 'default').target, null, 'the default row exists with no target');
  assert.deepEqual(routeStripLines(nothing)[0].why, [{ text: 'Current: a · current account a is blocked: ' + UNAVAILABLE_TEXT.capped, warn: true }]);
  nothing.accounts[0].unavailable = null;
  assert.deepEqual(routeStripLines(nothing)[0].why, [{ text: 'Current: a', warn: false }]);
});

test('T3: a split, partial or pinned-only provider and an empty fleet', async () => {
  const split = routedStatus();
  split.providerRouting[0].models[3].target = 'alex@work.co';
  split.providerRouting[1].models[0].target = null;
  split.providerRouting[1].models[0].route = null;
  split.providerRouting[1].models[0].pinned = null;
  split.routes[0].override = null;
  const [claude, codex] = routeStripLines(split);
  assert.deepEqual([claude.headline, claude.resolved, codex.headline, codex.resolved, codex.tag], ['Multiple targets', false, 'Partially available', false, null]);
  assert.deepEqual(codex.groups.map(g => g.tag), [null, 'pinned'], 'the pinned tag sits on the group it applies to');
  const { dom } = await renderPage(split);
  assert.ok(dom.getElementById('routeStripLines').querySelectorAll('.strip-target').every(t => t.matches('.warnt')), 'summary headlines render in near ink');
  const empty = await renderPage({ accounts: [] });
  assert.equal(empty.dom.getElementById('routeStripLines').textContent, 'No accounts configured on the proxy.');
  // A real empty fleet still sends providerRouting entries; the strip must not turn them into lines.
  const real = new AccountManager([], 0.98).getStatus();
  assert.ok(real.providerRouting.length > 0, 'the server reports provider entries for an empty fleet');
  const served = await renderPage(real);
  assert.equal(served.dom.getElementById('routeStripLines').textContent, 'No accounts configured on the proxy.');
  assert.equal(served.dom.getElementById('routeStripLines').querySelectorAll('.strip-line').length, 0);
});

const groupText = line => line.groups.map(g => g.labels + ' → ' + g.target + (g.tag ? ' [' + g.tag + ']' : ''));

test('P8: a split strip line names which families went where', async () => {
  // The exhausted fixture: Fable weekly is spent on both Claude accounts.
  const exhausted = routedStatus();
  exhausted.providerRouting[0].models[3].target = null;
  const [claude, codex] = routeStripLines(exhausted);
  assert.equal(claude.headline, 'Partially available');
  assert.deepEqual(groupText(claude), ['Opus, Sonnet, Haiku → alex@personal.dev', 'Fable → no eligible account']);
  assert.deepEqual(claude.groups.map(g => g.missing), [false, true]);
  assert.deepEqual([codex.headline, codex.tag, codex.groups], ['codex-secondary', 'forced', []], 'a single target keeps one headline and no sub-lines');
  const { dom } = await renderPage(exhausted);
  const [line, single] = dom.getElementById('routeStripLines').querySelectorAll('.strip-line');
  const subs = line.querySelectorAll('.strip-group');
  assert.deepEqual(subs.map(g => g.textContent), ['Opus, Sonnet, Haiku → alex@personal.dev', 'Fable → no eligible account']);
  assert.ok(subs[1].querySelector('span').matches('.badt') && !subs[0].querySelector('span').matches('.badt'), 'only the missing target is in at-grade ink');
  assert.equal(line.querySelector('.strip-target').textContent, 'Partially available');
  assert.equal(single.querySelectorAll('.strip-group').length, 0);
  assert.equal(single.querySelector('.strip-target').textContent, 'codex-secondaryforced');

  const two = routedStatus();
  two.providerRouting[0].models[3].target = 'alex@work.co';
  assert.deepEqual(groupText(routeStripLines(two)[0]), ['Opus, Sonnet, Haiku → alex@personal.dev', 'Fable → alex@work.co']);
  assert.equal(routeStripLines(two)[0].headline, 'Multiple targets');

  const blocked = routedStatus();
  Object.assign(blocked.providerRouting[0].models[3], { target: null, blocked: true });
  assert.deepEqual(groupText(routeStripLines(blocked)[0]), ['Opus, Sonnet, Haiku → alex@personal.dev', 'Fable → blocked by policy']);

  const forced = routedStatus();
  forced.providerRouting[1].models[0].target = 'codex-primary';
  assert.deepEqual(groupText(routeStripLines(forced)[1]), ['General → codex-primary [forced]', 'gpt-*, *codex* → codex-secondary [forced]']);
});

test('T3: Overview owns the strip, Routing owns the cards and the table, and #currentAccounts is gone', async () => {
  const html = renderDashboardHtml();
  const overview = html.slice(html.indexOf('<section aria-labelledby="routeStripTitle"'), html.indexOf('<section id="accountSection"'));
  assert.match(overview, /class="route-strip" data-section="overview"/);
  assert.match(overview, /id="manualSelection"/);
  assert.doesNotMatch(overview, /providerRouting|id="routes"|provider-card/);
  const routing = html.slice(html.indexOf('<section data-section="routing"'), html.indexOf('<section data-section="resets"'));
  assert.match(routing, /<section aria-labelledby="modelRoutingTitle" id="modelRouting" class="route-panel" data-section="routing">/);
  assert.match(routing, /id="modelRouting"[\s\S]*id="routingManualSelection"[\s\S]*id="providerRouting"[\s\S]*id="routes"[\s\S]*id="forceBlocked"/);
  assert.doesNotMatch(html, /data-section="overview routing"|id="currentAccounts"|getElementById\('currentAccounts'\)/);
  const { dom } = await renderPage(routedStatus());
  const cards = dom.getElementById('providerRouting').querySelectorAll('.provider-card');
  assert.deepEqual(cards.map(c => c.getAttribute('data-provider') + ':' + c.querySelector('h3 b').textContent), ['anthropic:Claude', 'codex:Codex']);
  assert.match(cards[0].querySelector('h3').textContent, /^Claude · Opus, Sonnet, Haiku, Fable$/);
});

test('T3: the routes table has three columns, only configured and autocreated route rows, and inline Force controls on each route\'s first row', async () => {
  const { dom } = await renderPage(routedStatus());
  const table = dom.getElementById('routes');
  assert.deepEqual(table.querySelectorAll('th').map(th => th.textContent), ['Route / sample', 'Target preview', 'Can serve sample']);
  const rows = table.querySelectorAll('tbody tr');
  assert.equal(rows.length, 3, 'two codex-default samples and fable; no default rows');
  assert.doesNotMatch(table.textContent, /no route of its own|outranks|Claude default|Codex default/);
  assert.deepEqual(rows.map(r => r.getAttribute('data-provider')), ['codex', 'codex', 'anthropic']);
  rows.forEach(r => assert.match(r.querySelectorAll('td')[1].textContent, r.getAttribute('data-provider') === 'codex' ? /Codex/ : /Claude/));
  assert.deepEqual(rows.map(r => r.querySelectorAll('td').map(td => td.getAttribute('data-label'))), Array(3).fill(['Route', 'Target', 'Can serve']));
  const actions = rows[0].querySelectorAll('td')[1].querySelector('.route-actions');
  assert.ok(actions, 'the forced route\'s first row carries the controls in its target cell');
  assert.match(actions.querySelector('.chip').textContent, /forced/);
  assert.deepEqual(actions.querySelectorAll('button').map(b => [b.textContent, b.getAttribute('aria-label')]),
    [['Change…', 'Change the forced account for route codex-default'], ['Clear force', 'Clear force on route codex-default']]);
  assert.equal(rows[1].querySelector('.route-actions'), null, 'second sample of the same route');
  assert.equal(rows[1].querySelector('.chip-line').textContent, 'forced · falls back when spent', 'but it still says the route is forced, on its own line with no leading separator');
  assert.equal(rows[2].querySelector('.route-actions'), null, 'autocreated route');
  const unforced = routedStatus(); unforced.routes[0].override = null; unforced.routes[0].persisted = null;
  const plain = (await renderPage(unforced)).dom.getElementById('routes').querySelector('.route-actions');
  assert.deepEqual(plain.querySelectorAll('button').map(b => [b.textContent, b.getAttribute('aria-label')]), [['Force…', 'Force route codex-default']]);
});

test('T3: Clear force confirms in the same cell with focus on Clear; Keep puts the buttons and focus back; forceBlocked disables Force', async () => {
  const { dom } = await renderPage(routedStatus());
  const cell = () => dom.getElementById('routes').querySelector('tbody tr').querySelectorAll('td')[1];
  cell().querySelectorAll('.route-actions button')[1].click();
  const confirm = cell().querySelector('.route-actions');
  assert.equal(confirm.textContent, 'Clear force on codex-default?ClearKeep');
  assert.equal(dom.focused, confirm.querySelectorAll('button')[0]);
  confirm.querySelectorAll('button')[1].click();
  const restored = cell().querySelectorAll('.route-actions button');
  assert.deepEqual(restored.map(b => b.textContent), ['Change…', 'Clear force']);
  assert.equal(dom.focused, restored[1]);
  const blocked = routedStatus(); blocked.forceBlocked = true; blocked.routes[0].override = null;
  const b = await renderPage(blocked);
  assert.equal(b.dom.getElementById('routes').querySelector('.route-actions button').disabled, true);
  assert.equal(b.dom.getElementById('forceBlocked').hidden, false);
  assert.match(b.dom.getElementById('forceBlocked').textContent, /Forcing is off/);
});

test('T3: switch and force dialog options lead with the provider, the select takes the chosen tint, and #switchHelp names the binding limit', async () => {
  const { dom } = await renderPage(routedStatus());
  dom.getElementById('manualSelection').click();
  const select = dom.getElementById('switchAccount');
  assert.deepEqual(select.querySelectorAll('option').slice(1).map(o => o.textContent),
    ['Claude · alex@personal.dev', 'Claude · alex@work.co', 'Codex · codex-primary', 'Codex · codex-secondary']);
  assert.equal(select.getAttribute('data-provider'), null, 'neutral until an account is chosen');
  select.value = 'codex-secondary'; select.dispatch('change');
  assert.equal(select.getAttribute('data-provider'), 'codex');
  assert.match(dom.getElementById('switchHelp').textContent, /Binding limit: Weekly 91% spent · near, switch at 98%\./);
  select.value = 'alex@personal.dev'; select.dispatch('change');
  assert.equal(select.getAttribute('data-provider'), 'anthropic');
  assert.match(dom.getElementById('switchHelp').textContent, /Binding limit: Fable weekly 95% spent · near/);
  dom.getElementById('routingManualSelection').click();
  assert.equal(dom.getElementById('switchDialog').open, true, 'Manual selection is reachable from Routing too');
  dom.getElementById('routes').querySelector('.route-actions button').click();
  const force = dom.getElementById('forceAccount');
  assert.equal(dom.getElementById('forceDialog').open, true);
  assert.ok(force.querySelectorAll('option').every(o => /^Codex · codex-(primary|secondary) · weekly /.test(o.textContent)));
  assert.equal(force.value, 'codex-secondary');
  assert.equal(force.getAttribute('data-provider'), 'codex');
  for (const id of ['forceAccount', 'forceFallback', 'forceHold', 'forceHelp', 'forceResult', 'forceUseCurrent', 'applyForce', 'switchAccount', 'switchHelp', 'switchResult', 'applySwitch']) {
    assert.match(renderDashboardHtml(), new RegExp(`id="${id}"`));
  }
});

test('T3: an account problem leads with its provider and wears its tint; a session problem stays neutral', async () => {
  const s = routedStatus();
  s.accounts[1].unavailable = 'error';
  s.sessions = { starvedMax: STARVED_MIN };
  const { dom } = await renderPage(s);
  const lines = dom.getElementById('problems').children;
  assert.equal(lines.length, 2);
  const session = lines.find(l => l.getAttribute('data-provider') == null);
  const account = lines.find(l => l.getAttribute('data-provider') != null);
  assert.match(session.textContent, /^A conversation has had/);
  assert.equal(account.getAttribute('data-provider'), 'anthropic');
  assert.equal(account.querySelector('.pv').textContent, 'Claude');
  assert.equal(account.textContent, 'Claude · Account alex@work.co needs a re-login.');
  assert.deepEqual(problems(s).filter(p => p.kind === 'account').map(p => [p.provider, p.account]), [['anthropic', 'alex@work.co']]);
});

test('T3: switch and force dialog options keep the reason the router may skip an account', async () => {
  const s = routedStatus();
  s.accounts[2].unavailable = 'capped';
  s.accounts[1].disabled = true;
  const { dom } = await renderPage(s);
  dom.getElementById('manualSelection').click();
  assert.deepEqual(dom.getElementById('switchAccount').querySelectorAll('option').slice(1).map(o => o.textContent),
    ['Claude · alex@personal.dev', 'Claude · alex@work.co · disabled', 'Codex · codex-primary · ' + UNAVAILABLE_TEXT.capped, 'Codex · codex-secondary']);
  dom.getElementById('routes').querySelector('.route-actions button').click();
  const force = dom.getElementById('forceAccount').querySelectorAll('option').map(o => o.textContent);
  assert.match(force[0], new RegExp('^Codex · codex-primary · weekly .* · ' + UNAVAILABLE_TEXT.capped.replace(/[()]/g, '\\$&') + '$'));
  assert.doesNotMatch(force[1], /usage cap/);
});

// ---- T4: Resets view ----

// n reset events, one window each, at shuffled times an hour apart. Every third
// is early and every fifth unclear, so each row style shows up.
function resetEvents(n) {
  const base = Date.now() - 100 * 3600e3;
  const order = Array.from({ length: n }, (_, i) => (i * 7) % n);
  return order.map(i => {
    const timing = i % 3 === 0 ? 'early' : i % 5 === 0 ? 'uncertain' : 'scheduled';
    const at = base + i * 3600e3;
    return {
      account: i % 2 ? 'codex-primary' : 'alex@personal.dev', provider: i % 2 ? 'codex' : 'anthropic', timing,
      windows: [{ key: 'sevenDay', type: 'restarted-window', before: { label: 'Weekly', utilization: 0.4, at: at - 600e3, resetAt: at }, after: { label: 'Weekly', utilization: 0.01, at, resetAt: at + 7 * 86400e3 } }],
    };
  });
}

function resetStatus(events = resetEvents(25), accounts) {
  const s = fixtureStatus();
  const now = Date.now();
  s.probe.resets = {
    startedAt: now - 30 * 86400e3, notifications: { enabled: false }, events,
    accounts: accounts || [
      { name: 'alex@personal.dev', provider: 'anthropic', totals: { scheduled: 32, early: 1, uncertain: 0 }, lastObservedAt: now - 60e3,
        windows: { sevenDay: { label: 'Weekly', utilization: 0.6, resetAt: now + 3.6 * 86400e3 }, sevenDayFable: { label: 'Fable weekly', utilization: 0.95, resetAt: now + 3.6 * 86400e3 }, fiveHour: { label: '5-hour', utilization: 0.1, resetAt: now + 3600e3 } },
        pending: [{ before: { utilization: 0.5 }, after: { label: 'Weekly', utilization: 0.02 } }],
        credits: { availableCount: 0, credits: [], oauth: { eligible: false, reason: 'surface' }, observedAt: now - 60e3 } },
      { name: 'codex-primary', provider: 'codex', totals: { scheduled: 4, early: 0, uncertain: 2 }, lastObservedAt: now - 60e3,
        windows: { sevenDay: { label: 'Weekly', utilization: 0.72, resetAt: now + 1.4 * 86400e3 } }, pending: [],
        credits: { availableCount: 1, credits: [{ status: 'available', title: 'Rate limit reset', expiresAt: now + 5 * 86400e3 }], observedAt: now - 60e3 } },
    ],
  };
  return s;
}

const whatCell = tr => tr.querySelectorAll('td').find(td => td.getAttribute('data-label') === 'What happened');

test('T4: the window-to-bucket map names the four watched limits', () => {
  assert.deepEqual(RESET_WINDOW_BUCKETS, { sevenDay: 'unified7d', fiveHour: 'unified5h', sevenDayFable: 'unified7dFable', sevenDaySonnet: 'unified7dSonnet' });
  for (const bucket of Object.values(RESET_WINDOW_BUCKETS)) assert.ok(THRESHOLD_BUCKET_KEYS.includes(bucket), bucket);
  const html = renderDashboardHtml();
  assert.match(html, /var RESET_WINDOW_BUCKETS = \{/);
  assert.match(html, /var RESET_HISTORY_DEFAULT = 20;\s*var resetHistoryExpanded = false;/);
  assert.match(html, /<table id="resetEvents" class="reset-table"><\/table><div id="resetReveal"><\/div>/);
});

test('T4: the history opens on the newest 20 of 25 rows; the reveal shows all in the same order and survives a re-render', async () => {
  const events = resetEvents(25);
  const sorted = resetHistoryRows(events);
  const { dom, refresh } = await renderPage(resetStatus(events));
  const bodyRows = () => dom.getElementById('resetEvents').querySelectorAll('tbody tr');
  const times = () => bodyRows().map(tr => tr.querySelector('td').children[0]);
  assert.equal(bodyRows().length, 20);
  const all = sorted.map(r => new Date(r.when).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  assert.deepEqual(times(), all.slice(0, 20));
  assert.ok(sorted.every((r, i) => i === 0 || sorted[i - 1].when >= r.when), 'time-descending');
  const button = () => dom.getElementById('resetReveal').querySelector('#resetShowAll');
  assert.equal(button().textContent, 'Show all 25 rows');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.equal(button().getAttribute('aria-controls'), 'resetEvents');
  const opened = button();
  opened.click();
  assert.equal(button(), opened, 'the same button, so focus stays on it');
  assert.equal(bodyRows().length, 25);
  assert.deepEqual(times(), all);
  assert.equal(button().textContent, 'Show the latest 20');
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  await refresh(resetStatus(events));
  assert.equal(bodyRows().length, 25, 'the poll re-render keeps the expanded state');
  assert.equal(button(), opened, 'a poll re-render does not detach the focused button');
  assert.equal(button().textContent, 'Show the latest 20');
  button().click();
  assert.equal(bodyRows().length, 20);
  assert.equal(button().textContent, 'Show all 25 rows');
});

test('T4: 20 rows or fewer have no reveal; none reads "No resets seen yet."; a truncated feed keeps the 500 note', async () => {
  let page = await renderPage(resetStatus(resetEvents(20)));
  assert.equal(page.dom.getElementById('resetEvents').querySelectorAll('tbody tr').length, 20);
  assert.equal(page.dom.querySelectorAll('#resetShowAll').length, 0);
  page = await renderPage(resetStatus([]));
  assert.equal(page.dom.getElementById('resetEvents').querySelector('tbody').textContent, 'No resets seen yet.');
  assert.equal(page.dom.querySelectorAll('#resetShowAll').length, 0);
  page = await renderPage(resetStatus(resetEvents(500)));
  assert.equal(page.dom.getElementById('resetEvents').querySelectorAll('tbody tr').length, 20);
  assert.match(page.dom.getElementById('resetHistoryNote').textContent, /Showing the latest 500 events/);
  assert.equal(page.dom.getElementById('resetReveal').querySelector('#resetShowAll').textContent, 'Show all 500 rows');
});

test('T4: history rows carry the provider and its label; early is warnt, unclear dim, scheduled neither', async () => {
  const { dom } = await renderPage(resetStatus(resetEvents(12)));
  const rows = dom.getElementById('resetEvents').querySelectorAll('tbody tr');
  for (const tr of rows) {
    const provider = tr.getAttribute('data-provider');
    const account = tr.querySelector('td[data-label="Account"]');
    assert.equal(account.textContent, (provider === 'codex' ? 'codex-primary · Codex' : 'alex@personal.dev · Claude'));
    assert.equal(account.querySelector('.pv').textContent, provider === 'codex' ? 'Codex' : 'Claude');
    const what = whatCell(tr);
    const expected = /early/.test(what.textContent) ? 'warnt' : /unclear/.test(what.textContent) ? 'dim' : '';
    assert.equal(what.className, expected, what.textContent);
  }
  assert.deepEqual(new Set(rows.map(tr => whatCell(tr).className)), new Set(['warnt', 'dim', '']));
  const html = renderDashboardHtml();
  assert.match(html, /#resetsSection \.warnt \{ color:var\(--grade-near-ink\); \}/);
  assert.match(html, /\.reset-table tr\[data-provider="anthropic"\] td:first-child \{ border-left-color:var\(--claude\); \}/);
});

test('T4: each card has the rail, badge, one totals line, a graded mini bar per window, banked and last-probe lines', async () => {
  const { dom } = await renderPage(resetStatus());
  const cards = dom.getElementById('resetAccounts').querySelectorAll('.card');
  assert.deepEqual(cards.map(c => c.getAttribute('data-provider')), ['anthropic', 'codex']);
  assert.deepEqual(cards.map(c => c.querySelector('.card-head .badge.provider').textContent), ['Claude', 'Codex']);
  assert.deepEqual(cards.map(c => c.querySelector('.totals').textContent), ['32 on schedule · 1 early · 0 unclear', '4 on schedule · 0 early · 2 unclear']);
  assert.equal(cards[0].querySelector('.totals .early b').textContent, '1', 'a non-zero early count is marked for near ink');
  assert.equal(cards[1].querySelectorAll('.totals .early').length, 0);
  // Fable weekly grades against its own 100% fleet threshold, the rest at 98%.
  const minis = cards[0].querySelectorAll('.mini');
  assert.deepEqual(minis.map(m => [m.querySelector('.lbl').textContent, m.querySelector('.bar').getAttribute('data-grade'), m.querySelector('.bar b').style.left]),
    [['Weekly', 'ok', '98%'], ['Fable weekly', 'near', '100%'], ['5-hour', 'ok', '98%']]);
  assert.equal(minis[1].querySelector('.bar').getAttribute('role'), 'meter');
  assert.match(minis[1].querySelector('.bar').getAttribute('aria-valuetext'), /^95% spent, near, switch at 100%, resets in 3\.6d$/);
  assert.match(minis[1].querySelector('.num').textContent, /^95% spent · 3\.6d$/);
  assert.equal(cards[1].querySelectorAll('.mini').length, 1);
  const lines = c => c.querySelectorAll('p').map(p => p.textContent);
  assert.deepEqual(lines(cards[0]).slice(1), [
    'Possible early reset on Weekly, 50% → 2% spent, waiting for the next probe.',
    'Banked resets: 0 available, checked 1m ago',
    'Not listed to the proxy by Anthropic; add them under bankedResets in the config.',
    'Last probed 1m ago',
  ]);
  assert.equal(cards[0].querySelectorAll('p.warnt').length, 1, 'the pending early reset is a near-ink line');
  assert.match(lines(cards[1])[2], /^Rate limit reset · expires /);
  // One fact per line: no card paragraph runs to a second sentence.
  for (const text of cards.flatMap(lines)) assert.doesNotMatch(text, /\.\s+\S/, text);
});

test('T4: no cards waits for the first probe; a cap binds the mini bar tick', async () => {
  let page = await renderPage(resetStatus([], []));
  assert.equal(page.dom.getElementById('resetAccounts').textContent, 'Waiting for the first successful quota probe.');
  const s = resetStatus();
  s.accounts[2].maxUsage = 0.6;
  page = await renderPage(s);
  const bar = page.dom.getElementById('resetAccounts').querySelectorAll('.card')[1].querySelector('.mini .bar');
  assert.equal(bar.getAttribute('data-grade'), 'at');
  assert.equal(bar.querySelector('b').className, 'cap');
  assert.equal(bar.querySelector('b').style.left, '60%');
  const html = renderDashboardHtml();
  assert.match(html, /\.mini \{ grid-template-columns:90px minmax\(0,1fr\) 96px; \}/);
});

test('T4: a Claude and a Codex account with the same name grade their cards against their own limits', async () => {
  const now = Date.now();
  const s = resetStatus([], [
    { name: 'shared', provider: 'anthropic', totals: {}, windows: { sevenDay: { label: 'Weekly', utilization: 0.7, resetAt: now + 86400e3 } }, pending: [], lastObservedAt: now },
    { name: 'shared', provider: 'codex', totals: {}, windows: { sevenDay: { label: 'Weekly', utilization: 0.7, resetAt: now + 86400e3 } }, pending: [], lastObservedAt: now },
  ]);
  s.accounts[0] = { ...s.accounts[0], name: 'shared', switchThreshold: 0.8 };
  s.accounts[2] = { ...s.accounts[2], name: 'shared', maxUsage: 0.6 };
  const { dom } = await renderPage(s);
  const bars = dom.getElementById('resetAccounts').querySelectorAll('.card').map(c => c.querySelector('.mini .bar'));
  assert.deepEqual(bars.map(b => [b.getAttribute('data-grade'), b.querySelector('b').style.left, b.querySelector('b').className]),
    [['near', '80%', ''], ['at', '60%', 'cap']]);
});

// ---- T5: Forecast, Activity and Diagnostics ----

// The fixture's forecast windows: two thin Claude accounts, one Codex row with a
// projection and one without.
function forecastStatus() {
  const s = fixtureStatus();
  const now = Date.now(), week = 604800000;
  const win = (bucket, durationMs, extra = {}) => ({ bucket, durationMs, status: 'Insufficient history', ratePerHour: null, limitAt: null, resetAt: now + 3.6 * 86400e3, utilization: 0.6, ...extra });
  const claude = name => ({ name, provider: 'anthropic', disabled: false, models: [], windows: [
    win('shared:fiveHour', 18000000, { status: 'No active window', resetAt: null, utilization: 0 }),
    win('shared:sevenDay', week), win('family:breakdown', null, { resetAt: null, utilization: null }), win('family:fable', week, { utilization: 0.95 }),
  ] });
  s.forecast = {
    status: 'Experimental account forecasts', observedThrough: now - 60e3,
    coverage: { subscriptionCount: 4, exclusions: [], remoteConsumption: 'Included in provider quota changes; attribution unknown', adviceReason: 'No acceptable alternatives configured' },
    accounts: [claude('alex@personal.dev'), claude('alex@work.co'),
      { name: 'codex-primary', provider: 'codex', disabled: false, models: [], windows: [win('shared:primary_window', week, { status: 'Recent-rate scenario', ratePerHour: 0.0167, limitAt: now + 16 * 3600e3, utilization: 0.72 })] },
      { name: 'codex-secondary', provider: 'codex', disabled: false, models: [], windows: [win('shared:primary_window', week, { status: 'Usage change below measurement resolution', utilization: 0.91 })] }],
    recommendations: [],
  };
  return s;
}

test('T5: forecast window labels are sentence case with the family capitalized', () => {
  assert.equal(forecastWindowLabel('shared:fiveHour', 18000000), 'Shared five-hour window');
  assert.equal(forecastWindowLabel('shared:sevenDay', 604800000), 'Shared weekly window');
  assert.equal(forecastWindowLabel('shared:primary_window', 604800000), 'Shared weekly window');
  assert.equal(forecastWindowLabel('shared:other'), 'Shared quota window');
  assert.equal(forecastWindowLabel('family:fable', 604800000), 'Fable weekly window');
  assert.equal(forecastWindowLabel('family:breakdown', null), 'Breakdown weekly window');
  assert.equal(forecastWindowLabel('family:sonnet'), 'Sonnet weekly window');
  assert.equal(forecastWindowLabel('model:gpt-5'), 'Model gpt-5');
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  assert.equal(new Function(`${bundle}; return forecastWindowLabel;`)()('family:fable', 604800000), 'Fable weekly window');
});

test('T5: forecast cards carry the provider rail and badge; thin evidence is dim, numbers mono; ids and copy stay', async () => {
  const { dom } = await renderPage(forecastStatus());
  const cards = dom.getElementById('forecastAccounts').querySelectorAll('section.card');
  assert.deepEqual(cards.map(c => c.getAttribute('data-provider')), ['anthropic', 'anthropic', 'codex', 'codex']);
  assert.deepEqual(cards.map(c => c.querySelector('.card-head h3').textContent), ['alex@personal.dev', 'alex@work.co', 'codex-primary', 'codex-secondary']);
  assert.deepEqual(cards.map(c => c.querySelector('.card-head .badge.provider').textContent), ['Claude', 'Claude', 'Codex', 'Codex']);
  const rows = cards.flatMap(c => c.querySelectorAll('tr').slice(1));
  const labels = rows.map(r => r.querySelector('td').textContent);
  assert.deepEqual(labels.slice(0, 4), ['Shared five-hour window', 'Shared weekly window', 'Breakdown weekly window', 'Fable weekly window']);
  for (const label of labels) assert.match(label, /^(Shared|Fable|Sonnet|Breakdown) /);
  const cells = rows.flatMap(r => r.querySelectorAll('td'));
  const thin = cells.filter(td => td.textContent === 'Not enough evidence');
  assert.equal(thin.length, 9);
  assert.ok(thin.every(td => td.className === 'dim'));
  assert.ok(cells.filter(td => td.textContent === 'Unknown').every(td => td.className === 'dim'));
  const horizon = dom.getElementById('forecastHorizon');
  horizon.value = '24';
  horizon.dispatch('change');
  const codex = dom.getElementById('forecastAccounts').querySelectorAll('section.card')[2].querySelectorAll('tr')[1].querySelectorAll('td');
  assert.deepEqual(codex.slice(1, 3).map(td => [td.textContent, td.className]), [['72.0%', 'mono'], ['1.67 percentage points', 'mono']]);
  assert.match(codex[3].textContent, /, in 16\.0 hours$/);
  assert.equal(codex[3].className, '', 'a real projection is not dimmed');
  assert.match(dom.getElementById('forecastSummary').textContent, /^Experimental account forecasts · Target /);
  assert.equal(dom.getElementById('forecastAdvice').textContent, 'No acceptable alternatives configured');
  const html = renderDashboardHtml();
  for (const id of ['forecastHorizon', 'forecastSummary', 'forecastCoverage', 'forecastAssumptions', 'forecastAdvice']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /#forecastAccounts td\.dim \{ color:var\(--dim\); \}/);
  assert.match(html, /\.card \{ [^}]*overflow-x:auto; \}/, 'forecast tables scroll inside their card');
});

test('T5: with forecast null no cards render and the summary keeps the disabled copy', async () => {
  const s = forecastStatus();
  s.forecast = null;
  const { dom } = await renderPage(s);
  assert.equal(dom.getElementById('forecastAccounts').querySelectorAll('.card').length, 0);
  assert.match(dom.getElementById('forecastSummary').textContent, /^Forecast history is disabled · Target /);
  assert.equal(dom.getElementById('forecastAdvice').textContent, 'No supported model alternatives yet.');
});

test('T5: the empty chart says it fills while the page is open; bars and metrics use the dim and mono roles', async () => {
  const { dom } = await renderPage();
  const chart = dom.getElementById('history');
  assert.equal(chart.className, 'history empty-chart');
  assert.equal(chart.textContent, 'No samples yet');
  assert.equal(dom.getElementById('historyLabel').textContent, 'This chart fills while the page is open and resets on reload.');
  const html = renderDashboardHtml();
  assert.match(html, /<p class="history-label" id="historyLabel">This chart fills while the page is open and resets on reload\.<\/p>/);
  assert.match(html, /\.history i \{ flex:1; background:var\(--dim\);/);
  assert.match(html, /\.metric strong \{ [^}]*font-family:var\(--mono\); font-variant-numeric:tabular-nums;/);
  // The chart card and the token card are the two halves of one .split, same height.
  assert.match(html, /<div class="split"><section><h2>Request activity<\/h2><div class="card">.*?<\/section><section><h2>Token accounting<\/h2><div class="card" id="tokens"><\/div><\/section><\/div>/);
  assert.match(html, /\.split>section>\.card \{ flex:1; \}/);
});

test('T5: a second poll fills the chart with dim bars and drops the empty state', async () => {
  const s = fixtureStatus();
  s.server = { startedAt: 1 };
  s.accounts[0].usage = { totalRequests: 10 };
  const { dom, refresh } = await renderPage(s);
  const next = fixtureStatus();
  next.server = { startedAt: 1 };
  next.accounts[0].usage = { totalRequests: 16 };
  await refresh(next);
  const chart = dom.getElementById('history');
  assert.equal(chart.className, 'history');
  assert.equal(chart.querySelectorAll('i').length, 1);
  assert.match(dom.getElementById('historyLabel').textContent, /^6 requests over \d+s · /);
});

test('T5: sessions keep sort headers and filters; the clients empty copy is unchanged', async () => {
  const s = fixtureStatus();
  s.sessions = { active: 1, known: 1, items: [{ id: 'deadbeef1234', client: 'alice', active: true, requests: 3, pins: {}, tokens: {} }] };
  s.clients = {};
  const { dom } = await renderPage(s);
  const heads = dom.getElementById('sessions').querySelectorAll('th');
  assert.ok(heads.length > 0);
  assert.ok(heads.every(th => th.getAttribute('aria-sort') != null));
  assert.equal(dom.getElementById('clients').textContent, 'No client-attributed usage yet. Requests using the shared proxy key are unattributed.');
  const html = renderDashboardHtml();
  assert.match(html, /<select id="fProject"><\/select>/);
  assert.match(html, /<select id="fClient"><\/select>/);
});

test('T5: the switch threshold line lists per-bucket fleet overrides only when there are any', async () => {
  let { dom } = await renderPage();
  const threshold = d => d.getElementById('routingInfo').querySelectorAll('dd')[0].textContent;
  assert.equal(threshold(dom), '98% · per bucket: Fable weekly 100%');
  assert.doesNotMatch(dom.getElementById('routingInfo').textContent, /unified7dFable/, 'no raw bucket keys');
  const s = fixtureStatus();
  s.switchThresholds = {};
  ({ dom } = await renderPage(s));
  assert.equal(threshold(dom), '98%');
  s.switchThresholds = { default: 0.98, unified5h: 0.9, unified7d: 0.95, tokens: 0.8, mystery: 0.5 };
  ({ dom } = await renderPage(s));
  assert.equal(threshold(dom), '98% · per bucket: 5-hour 90%, Weekly 95%, Tokens 80%, mystery 50%');
  s.switchThresholds = { default: 0.9 };
  ({ dom } = await renderPage(s));
  assert.equal(threshold(dom), '98%', 'the default key is not a per-bucket override');
});

test('T5: job rows carry the provider and its label; a probe error is at-ink; same-name accounts get their own row', async () => {
  const s = fixtureStatus();
  s.probe.accounts = s.accounts.map(a => ({ name: a.name, status: 'ok', lastProbedAt: new Date().toISOString(), durationMs: 300, error: null }));
  s.probe.accounts[3] = { ...s.probe.accounts[3], status: 'error', durationMs: null, error: 'HTTP 401' };
  let { dom } = await renderPage(s);
  const rows = () => dom.getElementById('jobs').querySelectorAll('tr').slice(1);
  assert.deepEqual(rows().map(r => r.getAttribute('data-provider')), ['anthropic', 'anthropic', 'codex', 'codex']);
  assert.deepEqual(rows().map(r => r.querySelector('td').textContent), ['alex@personal.dev · Claude', 'alex@work.co · Claude', 'codex-primary · Codex', 'codex-secondary · Codex']);
  assert.deepEqual(rows().map(r => r.querySelector('.pv').textContent), ['Claude', 'Claude', 'Codex', 'Codex']);
  const err = rows()[3].querySelectorAll('td');
  assert.deepEqual([err[1].textContent, err[1].className, err[4].textContent, err[4].className], ['error', 'badt', 'HTTP 401', 'badt']);
  assert.deepEqual([rows()[0].querySelectorAll('td')[4].textContent, rows()[0].querySelectorAll('td')[4].className], ['300 ms', 'mono']);
  assert.match(renderDashboardHtml(), /#jobs \.badt \{ color:var\(--grade-at-ink\); \}/);
  // A Claude and a Codex account named alike: each row reads its own probe entry.
  s.accounts[2] = { ...s.accounts[2], name: 'shared' };
  s.accounts[0] = { ...s.accounts[0], name: 'shared' };
  s.probe.accounts[0] = { ...s.probe.accounts[0], name: 'shared', durationMs: 111 };
  s.probe.accounts[2] = { ...s.probe.accounts[2], name: 'shared', durationMs: 222 };
  ({ dom } = await renderPage(s));
  assert.deepEqual([rows()[0].querySelectorAll('td')[4].textContent, rows()[2].querySelectorAll('td')[4].textContent], ['111 ms', '222 ms']);
});

test('T5: bucketLabel names each bucket the way its quota row does; unknown keys pass through', () => {
  assert.deepEqual(THRESHOLD_BUCKET_KEYS.map(bucketLabel), ['5-hour', 'Weekly', 'Sonnet weekly', 'Fable weekly', 'Tokens', 'Requests']);
  assert.equal(bucketLabel('mystery'), 'mystery');
  assert.equal(bucketLabel('toString'), 'toString');
  // Same words as the bars: every graded row's label is bucketLabel(its bucket).
  const groups = accountQuotaGroups({ quota: { unified7d: 0.1, unified5h: 0.1, unified7dFable: 0.1, unified7dSonnet: 0.1, tokensLimit: 10, tokensRemaining: 5, requestsLimit: 10, requestsRemaining: 5 } });
  const rows = groups.shared.concat(groups.session, groups.models).filter(r => r.bucket);
  assert.equal(rows.length, 6);
  for (const r of rows) assert.equal(r.label, bucketLabel(r.bucket));
});

// The served CSS as { selector, body } rules, media queries flattened.
function cssRules(html) {
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
}
const rootTokens = html => Object.fromEntries([...cssRules(html).find(r => r.selector === ':root').body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2].toLowerCase()]));

test('T6: the palette tokens are all in :root, and provider and grade tokens never cross slots', () => {
  const html = renderDashboardHtml();
  const tokens = rootTokens(html);
  const palette = { bg: '#0d1015', panel: '#151920', 'panel-2': '#1b2029', line: '#2a313d', text: '#f0f2f7', dim: '#a0abba', accent: '#b5c7ff',
    claude: '#e8956a', 'claude-soft': '#2a1d16', codex: '#3fbfd0', 'codex-soft': '#12242a', other: '#a0abba',
    'grade-ok': '#9ad46e', 'grade-ok-ink': '#b9e394', 'grade-ok-soft': '#1c2a19', 'grade-near': '#f2d060', 'grade-near-ink': '#f5db85', 'grade-near-soft': '#2e2814',
    'grade-at': '#e8506a', 'grade-at-ink': '#ff9aae', 'grade-at-soft': '#33181e', 'grade-spent': '#e8506a', track: '#262d39' };
  for (const [name, hex] of Object.entries(palette)) assert.equal(tokens[name], hex, '--' + name);
  const rules = cssRules(html);
  for (const r of rules.filter(r => r.selector.includes('[data-provider'))) assert.doesNotMatch(r.body, /--grade-/, r.selector);
  for (const r of rules.filter(r => r.selector.includes('[data-grade'))) assert.doesNotMatch(r.body, /--claude|--codex/, r.selector);
  // The legacy status colors are gone; status text uses the grade inks.
  assert.doesNotMatch(html, /--ok:|--warn:|--bad:|#c0cfff|#c2d0f6|#e0e8ff/);
});

test('T6: FR 33 contrast of the shipped :root values: text 4.5:1, fills and borders 3:1 on every surface', () => {
  const t = rootTokens(renderDashboardHtml());
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const surfaces = ['bg', 'panel', 'panel-2', 'track', 'claude-soft', 'codex-soft', 'grade-ok-soft', 'grade-near-soft', 'grade-at-soft'].map(k => t[k]).concat('#171c24');
  const text = ['text', 'dim', 'accent', 'claude', 'codex', 'grade-ok-ink', 'grade-near-ink', 'grade-at-ink'];
  const fills = ['grade-ok', 'grade-near', 'grade-at', 'grade-spent'];
  for (const [names, min] of [[text, 4.5], [fills, 3]]) for (const n of names) for (const s of surfaces) assert.ok(ratio(t[n], s) >= min, `--${n} on ${s}: ${ratio(t[n], s).toFixed(2)}`);
});

test('T6: chrome markup keeps its ids and roles; the nav wraps into chips at 900 px; the login mark carries both tints', () => {
  const html = renderDashboardHtml();
  assert.equal(html.split('<script>').length, 2, 'one script block');
  for (const id of ['keybox', 'key', 'go', 'loginError', 'loginHelp', 'keyLabel', 'app', 'err', 'refresh', 'reload', 'probe', 'logout', 'foot', 'connection']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<div id="keybox">\s*<i class="brand-mark" aria-hidden="true"><\/i>/);
  assert.match(html, /\.brand-mark \{[^}]*linear-gradient\(135deg,var\(--claude\) 0 50%,var\(--codex\) 50% 100%\)/);
  assert.match(html, /<p id="loginError" role="alert">/);
  assert.match(html, /#loginError \{ color:var\(--grade-at-ink\);/);
  assert.match(html, /<div id="err" role="alert">/);
  assert.match(html, /<p class="stale-note" role="status">/);
  assert.match(html, /id="connection" role="status"/);
  assert.match(html, /nav a\[aria-current\] \{ color:var\(--text\); background:var\(--panel-2\); border-left-color:var\(--text\);/);
  const mobile = html.slice(html.indexOf('@media(max-width:900px)'), html.indexOf('@media(max-width:650px)'));
  assert.match(mobile, /#app \{ grid-template-columns:minmax\(0,1fr\); grid-template-rows:auto 1fr; \}/);
  assert.match(mobile, /nav \{ flex-direction:row; flex-wrap:wrap;/);
  assert.doesNotMatch(mobile, /nowrap|overflow:auto/);
  assert.match(html, /\.live\.on::before \{ background:var\(--grade-ok\); \}/);
  assert.match(html, /\.stale \.live::before \{ background:var\(--grade-at\); \}/);
});

test('T6: a failed poll marks the page stale, disables the write controls but not Refresh, reddens the dot; the next good poll clears it', async () => {
  const page = await renderPage(routedStatus());
  const { dom } = page;
  const controls = ['reload', 'probe', 'manualSelection', 'routingManualSelection'];
  const routeButtons = () => dom.getElementById('routes').querySelectorAll('button');
  assert.equal(dom.body.classList.contains('stale'), false);
  assert.equal(dom.getElementById('connection').className, 'live on');
  assert.ok(routeButtons().length > 0 && routeButtons().every(b => !b.disabled));
  await page.refresh({}, 500);
  assert.equal(dom.body.classList.contains('stale'), true);
  assert.equal(dom.getElementById('connection').textContent, 'Disconnected');
  assert.equal(dom.getElementById('connection').className, 'live');
  for (const id of controls) assert.equal(dom.getElementById(id).disabled, true, id);
  // Refresh only polls, so it stays the operator's manual retry.
  assert.equal(dom.getElementById('refresh').disabled, false);
  assert.ok(routeButtons().every(b => b.disabled), 'Force and Clear follow connected');
  // Identity survives: rows keep data-provider while the bars go gray.
  assert.ok(dom.querySelectorAll('tr.account-row').every(r => r.getAttribute('data-provider')));
  await page.refresh(routedStatus());
  assert.equal(dom.body.classList.contains('stale'), false);
  assert.equal(dom.getElementById('connection').className, 'live on');
  for (const id of ['refresh', 'reload', 'manualSelection', 'routingManualSelection']) assert.equal(dom.getElementById(id).disabled, false, id);
  assert.ok(routeButtons().every(b => !b.disabled));
  // A Clear confirmation open when the poll fails: its Clear button goes disabled too.
  const clearCell = () => dom.getElementById('routes').querySelector('tbody tr').querySelectorAll('td')[1];
  clearCell().querySelectorAll('.route-actions button')[1].click();
  assert.equal(clearCell().querySelector('.route-actions').textContent, 'Clear force on codex-default?ClearKeep');
  assert.equal(clearCell().querySelectorAll('.route-actions button')[0].disabled, false);
  await page.refresh({}, 500);
  const confirm = clearCell().querySelectorAll('.route-actions button');
  assert.deepEqual(confirm.map(b => [b.textContent, b.disabled]), [['Clear', true], ['Keep', false]]);
});

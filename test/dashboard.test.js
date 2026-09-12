import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, scopedWeeklyRows, accountTokens,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, problems, STARVED_MIN, STARVED_LIST_MAX,
  chipFor, forceDefaultAccount, expectedFor, overrideRequest, overrideOutcome, resetHistoryRows,
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

const SESSIONS = {
  items: [
    {
      id: 's-old', client: 'bob', dimensions: { project: 'p2' }, active: false,
      requests: 2, lastSeen: 200, pins: { unified7d: 1 },
      tokens: { unified7d: { cacheRead: 5, cacheCreation: 1, input: 2, output: 1, context: 8 } },
    },
    {
      id: 's-new', client: 'alice', dimensions: { project: 'p1' }, active: true,
      requests: 1, lastSeen: 100, pins: { unified7d: 0, unified7dFable: 1 },
      tokens: {
        unified7d: { cacheRead: 900, cacheCreation: 50, input: 10, output: 5, context: 960 },
        unified7dFable: { cacheRead: 0, cacheCreation: 0, input: 4, output: 2, context: 4 },
      },
    },
  ],
};

test('a session row totals what the responses reported, cache included', () => {
  const rows = sessionRows(SESSIONS);
  const row = rows.find(r => r.id === 's-new');
  // input+output alone would say 21 for a session that actually cost 971.
  assert.equal(row.input + row.output, 21);
  assert.equal(row.total, 971);
  assert.equal(row.cacheRead, 900);
  // Summed across every weekly bucket the session touched.
  assert.equal(row.context, 964);
  // A session spending two model families is served by two accounts at once,
  // which is why this is a pin map and not one index.
  assert.equal(row.accounts, '0, 1');
  assert.equal(row.client, 'alice');
  assert.equal(row.project, 'p1');
});

test('session rows tolerate a payload with nothing in it', () => {
  assert.deepEqual(sessionRows({}), []);
  assert.deepEqual(sessionRows(null), []);
  const [bare] = sessionRows({ items: [{ id: 'x' }] });
  assert.deepEqual(
    { id: bare.id, client: bare.client, project: bare.project, total: bare.total, accounts: bare.accounts },
    { id: 'x', client: '', project: '', total: 0, accounts: '' },
  );
});

test('filters narrow by project and client, and combine', () => {
  const rows = sessionRows(SESSIONS);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1' }).map(r => r.id), ['s-new']);
  assert.deepEqual(filterSessionRows(rows, { client: 'bob' }).map(r => r.id), ['s-old']);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1', client: 'bob' }), []);
  // An empty filter is "All", not a match against the empty string.
  assert.equal(filterSessionRows(rows, { project: '', client: '' }).length, 2);
  assert.equal(filterSessionRows(rows, {}).length, 2);
});

test('sorting handles both text and number columns, and does not mutate', () => {
  const rows = sessionRows(SESSIONS);
  const before = rows.map(r => r.id);
  assert.deepEqual(sortRows(rows, 'total', 'desc').map(r => r.id), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'total', 'asc').map(r => r.id), ['s-old', 's-new']);
  assert.deepEqual(sortRows(rows, 'client', 'asc').map(r => r.id), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'client', 'desc').map(r => r.id), ['s-old', 's-new']);
  assert.deepEqual(rows.map(r => r.id), before, 'the caller\'s array is untouched');
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

// The shape /teamclaude/status reports per route: the server's own target for
// the family, and every account with whether it could serve it.
const ROUTED = {
  currentAccount: 'a',
  routes: [{
    name: 'fable', match: ['*fable*'], autocreated: true, pinned: null, target: 'b',
    accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }, { name: 'c', eligible: true }],
  }],
};

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
  assert.equal(rows.some(row => row.kind === 'default'), false, 'provider status has no universal fallback row');
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
/** Drive a session to `n` consecutive no-answer outcomes on a real tracker. */
function starve(am, id, n, client = 'alice') {
  for (let i = 0; i < n; i++) {
    am.beginSession(id, { client, dimensions: {} });
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

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, routeRows, problems,
    chipFor, forceDefaultAccount, expectedFor, overrideRequest, overrideOutcome]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script), 'inline script must parse');
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

test('GET /teamclaude/dashboard serves HTML without a key; other methods take the normal path', async () => {
  const upstream = http.createServer((req, res) => {
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
    // NOT hit the dashboard handler but flow down the normal (gated, then
    // proxied) pipeline like any other request. Loopback is key-exempt, so
    // over a real socket the observable is that it reaches the upstream.
    const post = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`, { method: 'POST' });
    assert.deepEqual(await post.json(), { upstream: true });
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
  assert.deepEqual(groups.shared, [{ label: 'Weekly', ratio: 0.2, resetAt: 100 }]);
  assert.deepEqual(groups.session, [{ label: '5-hour', ratio: 0.1, resetAt: 200 }]);
  assert.deepEqual(groups.models, [
    { label: 'Fable weekly', ratio: 1, resetAt: 400 },
    { label: 'Sonnet weekly', ratio: 0.4, resetAt: 300 },
    { label: 'Spark weekly', ratio: 0.3, resetAt: 500 },
  ]);
  assert.deepEqual(accountQuotaGroups(), { shared: [], session: [], models: [] });
  assert.deepEqual(accountQuotaGroups({}), { shared: [], session: [], models: [] });
  assert.equal(accountQuotaGroups({ quota: { tokensLimit: 0, tokensRemaining: 0 } }).shared[0].ratio, null);
  assert.equal(accountQuotaGroups({ quota: { tokensLimit: 100, tokensRemaining: 25 } }).shared[0].ratio, 0.75);
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
  assert.deepEqual(rows.map(r => [r.account, r.when, r.what, r.kind]), [
    ['a', 150, 'Rolled over on schedule', ''],
    ['b', 200, 'Reset early, quota refilled', 'warn'],
    ['b', 200, 'Reset early, window restarted', 'warn'],
    ['c', 200, 'Reset, timing unclear', 'dim'],
  ]);
  assert.deepEqual([rows[0].before, rows[0].after, rows[0].window, rows[0].observed, rows[0].resetAt], [19, 2, '5-hour', [100, 200], [150, 900]]);
  assert.deepEqual(resetHistoryRows(undefined), []);
  const html = renderDashboardHtml();
  assert.match(html, /id="resetEvents" class="reset-table"/);
  assert.match(html, /function resetHistoryRows/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const H = 3600_000;
const NOW = 1_789_000_000_000;
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5';
const FABLE = 'claude-fable-5-1';
const oauth = name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + H });

function confirm(am, index, utilization = 0.99, resetAt = Date.now() + 100 * H) {
  am.applyUsageData(index, { sevenDayFable: { utilization, resetAt } });
}

function fleet(opts = {}, count = 2) {
  const am = new AccountManager(Array.from({ length: count }, (_, i) => oauth(`a${i}`)), 0.98,
    { preferFableDepletedAccounts: true, ...opts });
  for (const a of am.accounts) {
    Object.assign(a.quota, { unified5h: 0.1, unified5hReset: Date.now() + H,
      unified7d: 0.1, unified7dReset: Date.now() + (a.index ? 100 : 2) * H });
    a.probing = false;
    confirm(am, a.index, a.index === 1 ? 0.99 : 0.1);
  }
  return am;
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
}

for (const distribution of [false, true, 'adaptive']) {
  test(`recognized families prefer depletion ahead of expiry and load, distribution ${distribution}`, t => {
    clock(t);
    const am = fleet({ distributeSessions: distribution, expiryRouting: { enabled: true, preempt: true } });
    for (let i = 0; i < 5; i++) am.recordSession(`busy-${i}`, 1, OPUS);
    for (const model of [OPUS, SONNET, HAIKU, 'opus', 'sonnet', 'haiku']) {
      assert.equal(am.getActiveAccount(null, model, null, `new-${model}`).index, 1);
      assert.equal(am.previewRouteIndex(model), 1);
    }
    assert.equal(am.getActiveAccount(null, FABLE, null, 'fable').index, 0);
    assert.equal(am.currentIndex, 0);
    assert.equal(am.getStatus().fableDepletionRouting.models[0].reason, 'fable-depleted');
  });
}

test('numeric priorities, route restrictions and manual route pins win', t => {
  clock(t);
  const am = fleet();
  am.accounts[1].priority = 1;
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().fableDepletionRouting.models[0].reason, 'numeric-priority');
  am.accounts[1].priority = 0;
  am.setRoutes([{ name: 'opus', match: '*opus*', accounts: ['a0'] }]);
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().fableDepletionRouting.models[0].reason, 'route-restriction');
  am.setRoutes([{ name: 'opus', match: '*opus*', accounts: ['a0', 'a1'] }]);
  am.routePins.set('opus', 0);
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().fableDepletionRouting.models[0].reason, 'manual-route-pin');
});

for (const mutation of [
  a => { a.quota.unified5h = 0.99; },
  a => { a.quota.unified7d = 0.99; },
  a => { a.disabled = true; },
  a => { a.status = 'error'; },
  a => { a.maxUsage = 0.05; },
]) {
  test(`preferred account must remain eligible: ${mutation}`, t => {
    clock(t);
    const am = fleet();
    mutation(am.accounts[1]);
    assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  });
}

test('Sonnet cutoff skips the preferred account for Sonnet only', t => {
  clock(t);
  const am = fleet();
  am.applyUsageData(1, { sevenDaySonnet: { utilization: 0.99, resetAt: NOW + H } });
  assert.equal(am.getActiveAccount(null, SONNET).index, 0);
  assert.equal(am.getActiveAccount(null, OPUS).index, 1);
});

test('uses exactly the configured actual Fable cutoff, unaffected by route bucket overrides', t => {
  clock(t);
  const am = fleet();
  am.switchThreshold = { default: 0.98, unified7dFable: 0.8 };
  for (const [used, expected] of [[0.799, 0], [0.8, 1], [1.1, 1]]) {
    confirm(am, 1, used);
    assert.equal(am.getActiveAccount(null, OPUS).index, expected);
  }
  confirm(am, 1, 0.1);
  am.setRoutes([{ name: 'fable', match: '*fable*', bucket: 'unified5h' }]);
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
});

test('depletion follows quota state and ranks multiple preferred candidates normally', t => {
  clock(t);
  const am = fleet({ distributeSessions: true }, 3);
  confirm(am, 2);
  am.recordSession('busy', 1, OPUS);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'new').index, 2);
  confirm(am, 0);
  confirm(am, 1, 0.1);
  confirm(am, 2, 0.1);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'another').index, 0);
  for (const a of am.accounts) a.disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS), null);
});

for (const [name, mutation] of [
  ['null', q => { q.unified7dFable = null; }],
  ['NaN', q => { q.unified7dFable = NaN; }],
  ['infinite', q => { q.unified7dFable = Infinity; }],
  ['negative', q => { q.unified7dFable = -1; }],
  ['future observation', q => { q.unified7dFableSeenAt = NOW + 1; }],
  ['invalid observation', q => { q.unified7dFableSeenAt = NaN; }],
  ['missing observation', q => { q.unified7dFableSeenAt = null; }],
  ['missing reset', q => { q.unified7dFableReset = null; }],
  ['invalid reset', q => { q.unified7dFableReset = Infinity; }],
  ['passed reset', q => { q.unified7dFableReset = NOW; }],
  ['stale', q => { q.unified7dFableSeenAt = NOW - 30 * 60_000; }],
]) {
  test(`${name} reading never grants preference`, t => {
    clock(t);
    const am = fleet();
    mutation(am.accounts[1].quota);
    assert.equal(am.getActiveAccount(null, OPUS).index, 0);
    assert.notEqual(am.getStatus().accounts[1].fableEvidence, 'confirmed');
    confirm(am, 1);
    assert.equal(am.getActiveAccount(null, OPUS).index, 1);
  });
}

test('restore, legacy synthesis, incomplete and failed probes cannot confirm a reading', t => {
  clock(t);
  const am = fleet();
  const saved = am.exportQuotaState();
  am.restoreQuotaState(saved);
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().accounts[1].fableEvidence, 'unconfirmed');
  am.applyUsageData(1, { error: 'failed', sevenDayFable: { utilization: 1, resetAt: NOW + H } });
  am.applyUsageData(1, { fiveHour: { utilization: 0.2 } });
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  confirm(am, 1);
  am.accounts[1].quota.unified7dFableReset = NOW;
  am.sweepExpiredQuotas();
  Object.assign(am.accounts[1].quota, { unified7dFable: 1, unified7dFableReset: NOW + H });
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().accounts[1].fableEvidence, 'unconfirmed');
  confirm(am, 1);
  am.applyUsageData(1, { scopedWeeklyListed: true, scopedWeekly: {} });
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().accounts[1].fableEvidence, 'unknown');
});

test('live headers confirm only valid readings and startup objects cannot inherit provenance', t => {
  clock(t);
  const am = fleet();
  const fresh = new AccountManager(am.accounts, 0.98, { preferFableDepletedAccounts: true });
  fresh.restoreQuotaState(am.exportQuotaState());
  assert.equal(fresh.getActiveAccount(null, OPUS).index, 0);
  fresh.updateQuota(1, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.99',
    'anthropic-ratelimit-unified-7d_oi-reset': String((NOW + H) / 1000),
  });
  assert.equal(fresh.getActiveAccount(null, OPUS).index, 1);
  fresh.updateQuota(1, { 'anthropic-ratelimit-unified-7d_oi-utilization': 'Infinity' });
  assert.equal(fresh.getActiveAccount(null, OPUS).index, 0);
});

test('config-only account reload retains live evidence and toggling off restores selection', async t => {
  clock(t);
  const am = fleet();
  const config = { accounts: [oauth('a0'), oauth('a1')] };
  await syncAccountsFromDisk(JSON.parse(JSON.stringify(config)), config, am);
  assert.equal(am.getStatus().accounts[1].fableEvidence, 'confirmed');
  assert.equal(am.getActiveAccount(null, OPUS).index, 1);
  am.preferFableDepletedAccounts = false;
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  assert.equal(am.getStatus().fableDepletionRouting.models[0].reason, 'policy-disabled');
  for (const value of [undefined, false, 'true']) {
    const off = fleet({ preferFableDepletedAccounts: value });
    assert.equal(off.getActiveAccount(null, OPUS).index, 0);
  }
});

test('unknown models, other providers and API accounts acquire no preference', t => {
  clock(t);
  const am = fleet();
  for (const model of [null, '', 'claude-future', 'gpt-5']) assert.equal(am.getActiveAccount(null, model).index, 0);
  am.accounts[1].type = 'apikey';
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  am.accounts[1].type = 'oauth';
  am.accounts[1].provider = 'codex';
  assert.equal(am.getActiveAccount(null, OPUS).index, 0);
  am.accounts[0].provider = 'codex';
  assert.equal(am.getActiveAccount(null, OPUS, null, null, 'codex').index, 0);
  am.accounts[0].provider = 'anthropic';
  am.accounts[1].provider = 'anthropic';
  am.accounts[0].type = 'apikey';
  assert.equal(am.getActiveAccount(null, OPUS).index, 1, 'preferred subscriptions can outrank equal-priority API accounts');
});

for (const distributeSessions of [false, true]) {
  test(`advisor requirements and explicit executor degradation, distribution ${distributeSessions}`, t => {
    clock(t);
    const am = fleet({ distributeSessions });
    assert.equal(am.getActiveAccount(null, OPUS, FABLE, 's').index, 0);
    assert.equal(am.getActiveAccount(null, FABLE, OPUS, 's').index, 0);
    am.accounts[0].disabled = true;
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    assert.equal(am.getActiveAccount(null, OPUS, FABLE, 's').index, 1);
    assert.ok(lines.some(line => /routing by request model only/.test(line)));
  });
}

for (const draining of [false, true]) {
  test(`session policy releases join one ramp and preserve Fable pins, draining ${draining}`, t => {
    clock(t);
    const am = fleet({ distributeSessions: true });
    for (let i = 0; i < 10; i++) {
      am.recordSession(`s${i}`, 0, OPUS);
      am.recordSession(`s${i}`, 0, FABLE);
    }
    if (draining) am.setDistributeSessions(false);
    for (let i = 0; i < 10; i++) {
      const sid = `s${i}`;
      assert.equal(am.getActiveAccount(null, OPUS, null, sid).index, 1);
      am.recordSession(sid, 1, OPUS);
      assert.equal(am.accounts[1].rampStartedAt, NOW);
      assert.equal(am.getActiveAccount(null, FABLE, null, sid).index, 0);
      t.mock.timers.tick(100);
    }
    assert.equal(am.currentIndex, 0);
    confirm(am, 1, 0.1);
    assert.equal(am.getActiveAccount(null, OPUS, null, 's0').index, 1, 'equal-tier pin stays after recovery');
  });
}

test('multiple policy cursors divert once each without repeated ramp resets or rollover exclusions', t => {
  clock(t);
  const am = fleet({ expiryRouting: { enabled: true, preempt: true } });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  for (let i = 0; i < 4; i++) {
    for (const [model, advisor] of [[OPUS, null], [SONNET, null], [OPUS, SONNET]]) {
      const decision = {};
      assert.equal(am.getActiveAccount(null, model, advisor, null, 'anthropic', decision).index, 1);
      assert.equal(am.previewRouteIndex(model, advisor), 1);
      assert.equal(decision.rolledOff, undefined);
      assert.equal(am.accounts[1].rampStartedAt, NOW);
      assert.equal(am.getActiveAccount(null, FABLE).index, 0);
      t.mock.timers.tick(50);
    }
  }
  assert.equal(lines.filter(line => /Diverting/.test(line)).length, 3);
  assert.equal(am.currentIndex, 0);
  assert.equal(am.pickAlternate(new Set([1]), OPUS).index, 0);
});

test('policy joins a future pause ramp and only starts a new ramp after the old window', t => {
  clock(t);
  const am = fleet({ distributeSessions: true });
  am.accounts[1].rampStartedAt = NOW + 5000;
  am.recordSession('one', 0, OPUS);
  am.getActiveAccount(null, OPUS, null, 'one');
  assert.equal(am.accounts[1].rampStartedAt, NOW + 5000);
  t.mock.timers.tick(5000 + am.ramp.windowMs);
  am.recordSession('two', 0, OPUS);
  am.getActiveAccount(null, OPUS, null, 'two');
  assert.equal(am.accounts[1].rampStartedAt, Date.now());
});

test('broad routes and unknown models cannot overwrite policy cursors, including degraded advisors', t => {
  clock(t);
  const am = fleet({ routes: [{ name: 'all', match: '*' }] });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  for (let i = 0; i < 3; i++) {
    assert.equal(am.getActiveAccount(null, OPUS).index, 1);
    assert.equal(am.getActiveAccount(null, FABLE).index, 0);
    assert.equal(am.getActiveAccount(null, 'unknown').index, 0);
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).index, 0);
  }
  assert.equal(lines.filter(line => /Diverting/.test(line)).length, 1);
  // Fable becomes impossible for the advisor pass without changing Opus tiers.
  am.accounts[0].maxUsage = { unified7dFable: 0.05 };
  for (let i = 0; i < 3; i++) {
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).index, 1);
    assert.equal(am.getActiveAccount(null, 'unknown').index, 0);
  }
  assert.equal(lines.filter(line => /Diverting/.test(line)).length, 2);
  assert.equal(am.currentIndex, 0);
  assert.equal(am.accounts[1].rampStartedAt, NOW);
});

test('session reset pressure cannot move the global cursor for policy or demote a preferred candidate', t => {
  clock(t);
  const am = fleet({ expiryRouting: { enabled: true, preempt: true } });
  am.accounts[1].quota.unified7dReset = NOW + H;
  am.accounts[1].quota.unified5hReset = NOW;
  assert.equal(am.getActiveAccount(null, OPUS).index, 1);
  assert.equal(am.currentIndex, 0);
  am.currentIndex = 1;
  am.accounts[0].quota.unified7dReset = NOW + H / 2;
  am.accounts[0].quota.unified5hReset = NOW;
  assert.equal(am.getActiveAccount(null, OPUS).index, 1);
  assert.equal(am.currentIndex, 1);
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
for (const failure of [429, 529]) {
  test(`HTTP ${failure} fallback can use the Fable-capable account without moving the fleet`, async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      const status = seen.length === 1 ? failure : 200;
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '60' } : {}) });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { type: 'error', error: { type: 'overloaded_error' } }));
    });
    const upstreamPort = await listen(upstream);
    const am = fleet({ ramp: { enabled: false } });
    const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const proxyPort = await listen(proxy);
    try {
      const result = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
        body: JSON.stringify({ model: OPUS, messages: [] }),
      });
      assert.equal(result.status, 200);
      await result.text();
      assert.deepEqual(seen, ['Bearer t-a1', 'Bearer t-a0']);
      assert.equal(am.currentIndex, 0);
      assert.equal(am.getActiveAccount(null, OPUS).index, 1);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
    }
  });
}

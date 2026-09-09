import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { routingCards, routeRows } from '../src/dashboard.js';

const hour = 3600000;
const oauth = (name, provider = 'anthropic', extra = {}) => ({ name, provider, type: 'oauth', accessToken: 'test', refreshToken: 'test', accountId: name, expiresAt: Date.now() + hour, ...extra });
const pool = () => [oauth('claude-a'), oauth('claude-b'), oauth('codex-a', 'codex'), oauth('codex-b', 'codex')];
const snapshot = am => JSON.stringify({ index: am.currentIndex, providers: [...am.providerCursors], routes: [...am.routeCursors], nextProbe: am._nextProbeAt, currentObs: am._currentObs, ramps: am.accounts.map(a => a.rampStartedAt) });

test('header separates providers and groups model-specific Claude targets', () => {
  const am = new AccountManager(pool(), .98, { preferFableDepletedAccounts: true, routes: [{ name: 'codex-default', match: ['gpt-*', '*codex*'], accounts: ['codex-b'] }] });
  am.applyUsageData(0, { sevenDayFable: { utilization: 1, resetAt: Date.now() + hour }, sevenDay: { utilization: .5, resetAt: Date.now() + hour } });
  am.applyUsageData(1, { sevenDayFable: { utilization: .3, resetAt: Date.now() + hour }, sevenDay: { utilization: .3, resetAt: Date.now() + hour } });
  am.currentIndex = 0;
  const before = snapshot(am);
  const status = am.getStatus();
  assert.equal(snapshot(am), before);
  const cards = routingCards(status);
  assert.equal(cards[0].headline, 'Multiple targets');
  assert.deepEqual(cards[0].groups.find(g => g.target === 'claude-a').labels, ['Opus', 'Sonnet', 'Haiku']);
  assert.deepEqual(cards[0].groups.find(g => g.target === 'claude-b').labels, ['Fable']);
  assert.equal(cards[1].headline, 'codex-b');
  assert.equal(status.sessions.scope, 'claude-session-header');
  assert.deepEqual(status.accounts.map(a => a.provider), ['anthropic', 'anthropic', 'codex', 'codex']);
  const fable = status.routes.find(r => r.name === 'fable');
  assert.deepEqual(fable.accounts.map(a => a.name), ['claude-a', 'claude-b']);
  assert.equal(fable.target, 'claude-b');
  assert.ok(routeRows(status).every(row => row.kind !== 'default'));
});

test('preview mirrors provider cursor and priority without changing routing state', () => {
  const am = new AccountManager(pool());
  am.currentIndex = 0;
  am.providerCursors.set('codex', 3);
  const before = snapshot(am);
  assert.equal(am.previewRouteIndex('gpt-6-astra', null, 'codex'), 3);
  assert.equal(snapshot(am), before);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').index, 3);
  am.accounts[2].priority = -1;
  assert.equal(am.previewRouteIndex('gpt-6-astra', null, 'codex'), 2);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').index, 2);
  am.currentIndex = 2;
  assert.equal(am.previewRouteIndex('claude-opus-5'), am.getActiveAccount(null, 'claude-opus-5').index);
});

test('manual route pins, disabled pins, foreign pins, and exhausted pools are reflected', () => {
  const am = new AccountManager(pool(), .98, { routes: [{ name: 'gpt', match: ['gpt-*'] }] });
  am.setRoutePin('gpt', 3);
  assert.equal(am.getRoutes()[0].target, 'codex-b');
  am.accounts[3].disabled = true;
  const row = routeRows(am.getStatus())[0];
  assert.equal(row.target, 'codex-a');
  assert.equal(row.pinMismatch, true);
  am.accounts[2].quota.unified7d = 1;
  am.accounts[2].quota.unified7dReset = Date.now() + hour;
  assert.equal(am.getRoutes()[0].target, null);
  am.setRoutePin('gpt', 0);
  assert.equal(am.getRoutes()[0].target, null, 'a foreign subscription pin must not appear usable');
  assert.equal(routingCards(am.getStatus())[1].headline, 'Unavailable');
});

test('custom model patterns are previewed by provider and mixed-glob routes keep both projections', () => {
  const am = new AccountManager(pool(), .98, { routes: [
    { name: 'mixed', match: ['claude-*', 'gpt-*'], accounts: ['claude-b', 'codex-b'] },
    { name: 'custom', match: ['custom-*'], accounts: ['claude-a', 'codex-a'] },
  ] });
  const mixed = am.getRoutes()[0];
  assert.deepEqual(mixed.previews.map(p => [p.provider, p.target]), [['anthropic', 'claude-b'], ['codex', 'codex-b']]);
  const custom = am.getRoutes()[1];
  assert.deepEqual(custom.previews.map(p => [p.provider, p.target]), [['anthropic', 'claude-a'], ['codex', 'codex-a']]);
  const cards = routingCards(am.getStatus());
  assert.ok(cards.every(card => card.headline === 'Multiple targets'));
});

test('model overrides and blocked models do not collapse to a universal account', () => {
  const am = new AccountManager(pool(), .98, { routes: [{ name: 'special', match: ['gpt-special'], accounts: ['codex-b'] }] });
  const cards = routingCards(am.getStatus({ blockedModels: ['claude-*', 'gpt-special'] }));
  assert.equal(cards[0].headline, 'Unavailable');
  assert.equal(cards[1].headline, 'Partially available');
  assert.ok(cards[1].groups.some(group => group.blocked && group.target === null));
  assert.equal(am.getStatus({ blockedModels: ['gpt-special'] }).routes[0].target, null);
});

test('missing providers and old status payloads do not borrow the current account', () => {
  const am = new AccountManager([oauth('only-claude')]);
  assert.equal(routingCards(am.getStatus())[1].headline, 'Unavailable');
  assert.deepEqual(routingCards({ currentAccount: 'only-claude', defaultTarget: 'only-claude' }), []);
  const codex = new AccountManager([oauth('only-codex', 'codex')]);
  assert.equal(routingCards(codex.getStatus())[0].headline, 'Unavailable');
  assert.equal(routingCards(codex.getStatus())[1].headline, 'only-codex');
});

test('API-key eligibility follows the existing request selection policy', () => {
  const am = new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'test' }]);
  for (const provider of ['anthropic', 'codex']) {
    const model = provider === 'codex' ? 'gpt-6-astra' : 'claude-opus-5';
    assert.equal(am.previewRouteIndex(model, null, provider), am.getActiveAccount(null, model, null, null, provider).index);
  }
});

test('status HTTP endpoint passes its live blocklist into provider previews', async () => {
  const am = new AccountManager(pool());
  const config = { proxy: { port: 0 }, blockedModels: ['gpt-*'] };
  const server = createProxyServer(am, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/teamclaude/status`;
    const first = await (await fetch(url)).json();
    assert.equal(routingCards(first)[1].headline, 'Unavailable');
    config.blockedModels = [];
    const next = await (await fetch(url)).json();
    assert.equal(routingCards(next)[1].headline, 'codex-a');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

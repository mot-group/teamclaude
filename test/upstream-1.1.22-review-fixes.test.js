import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, resolveAccountRouting } from '../src/account-manager.js';
import { parseRoutingUrl, routingToUrl, describeRouting } from '../src/account-routing.js';
import { fetchResetCreditDetails, consumeResetCredit } from '../src/codex-reset-credits.js';
import { Prober } from '../src/prober.js';

// Fixes to upstream 1.1.22 code found by the Codex review of the merge (#23).

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const OPUS = 'claude-opus-5';
const quietly = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('a maxSpend of 0 is never picked for paid extra usage', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, maxSpend: 0 })], 0.98);
  for (const a of am.accounts) {
    Object.assign(a.quota, { unified7d: 1.0, spend: { enabled: true, usedMinor: 0, exponent: 2, currency: 'USD' } });
  }
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
  // The same account with a positive cap still serves on overage.
  am.accounts[1].maxSpend = 20;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'paid');
});

test('both reset-credit calls leave by the account\'s own routing', async () => {
  const routing = parseRoutingUrl('socks5h://proxy.example:1080');
  const account = { credential: 'c', accountId: 'acct', routing };
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(init.routing);
    return { ok: true, json: async () => ({ credits: [], windows_reset: 1 }) };
  };
  await fetchResetCreditDetails(account, { fetchImpl });
  await consumeResetCredit(account, { redeemRequestId: 'r1' }, { fetchImpl });
  assert.deepEqual(seen, [routing, routing]);
});

test('a configured routing that cannot be used holds the account instead of going direct', () => {
  assert.deepEqual(resolveAccountRouting({ name: 'x', routing: 'none' }), { routing: null, refused: false });
  assert.deepEqual(resolveAccountRouting({ name: 'x' }), { routing: null, refused: false });
  const am = quietly(() => new AccountManager([oauth('bad', { routing: 'socks9://nope' }), oauth('ok')], 0.98));
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'routing');
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'ok');
  // A reload that fixes the routing releases it.
  am.setRouting(0, parseRoutingUrl('http://proxy.example:3128'), false);
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), null);
});

test('an IPv6 routing survives a save and a reload', () => {
  const routing = parseRoutingUrl('socks5h://u:p@[::1]:1080');
  assert.equal(routingToUrl(routing), 'socks5h://u:p@[::1]:1080');
  assert.deepEqual(parseRoutingUrl(routingToUrl(routing)), routing);
  assert.equal(describeRouting(routing), 'socks5h://u:***@[::1]:1080');
});

test('the exhausted-fleet probe skips a zero money cap and a refused routing', () => {
  const am = quietly(() => new AccountManager([
    oauth('zero', { maxSpend: 0 }),
    oauth('bad', { routing: 'socks9://nope' }),
    oauth('ok'),
  ], 0.98));
  for (const a of am.accounts) {
    Object.assign(a.quota, { unified7d: 1.0, spend: { enabled: true, usedMinor: 0, exponent: 2, currency: 'USD' } });
  }
  am._nextProbeAt = 0;
  assert.equal(am._selectProbe(null, OPUS)?.name, 'ok');
  am._nextProbeAt = 0;
  assert.equal(am._selectProbe(new Set([2]), OPUS), null);
});

test('no background path sends a refused account\'s credential', async () => {
  const am = quietly(() => new AccountManager([oauth('bad', { routing: 'socks9://nope', expiresAt: Date.now() - 1000 })], 0.98, {
    refreshFn: async () => { throw new Error('refresh must not run'); },
  }));
  const bad = am.accounts[0];
  await am.ensureTokenFresh(0);
  assert.equal(Prober.prototype._probeable.call({}, bad), false);
  const codex = { credential: 'c', accountId: 'acct', routingRefused: true };
  const fetchImpl = async () => { throw new Error('must not fetch'); };
  assert.ok((await fetchResetCreditDetails(codex, { fetchImpl })).error);
  assert.ok((await consumeResetCredit(codex, { redeemRequestId: 'r1' }, { fetchImpl })).error);
});

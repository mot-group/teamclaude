import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexUsage, fetchCodexUsage } from '../src/codex-usage.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const weekly = { used_percent: 78, limit_window_seconds: 604800, reset_at: 1900000000 };
const fiveHour = { used_percent: 12, limit_window_seconds: 18000, reset_at: 1899500000 };
const payload = {
  plan_type: 'pro', rate_limit: { primary_window: weekly, secondary_window: null },
  additional_rate_limits: [{ metered_feature: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: fiveHour, secondary_window: { ...weekly, used_percent: 0 } } }],
};
const account = (name, extra = {}) => ({ name, type: 'oauth', provider: 'codex', accessToken: name + '-access', refreshToken: name + '-refresh', accountId: name + '-id', expiresAt: Date.now() + 3600000, ...extra });
const normalized = normalizeCodexUsage(payload);

test('Codex usage classifies by duration, including a weekly primary window and model quotas', () => {
  assert.equal(normalized.fiveHour, null);
  assert.deepEqual(normalized.sevenDay, { utilization: 0.78, resetAt: 1900000000000 });
  assert.equal(normalized.planType, 'pro');
  assert.deepEqual(normalized.modelBuckets, [{ slug: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0, resetAt: 1900000000000 }]);
  const swapped = normalizeCodexUsage({ rate_limit: { primary_window: fiveHour, secondary_window: weekly } });
  assert.equal(swapped.fiveHour.utilization, 0.12);
  assert.equal(swapped.sevenDay.utilization, 0.78);
  assert.throws(() => normalizeCodexUsage({ error: 'failed' }));
  assert.throws(() => normalizeCodexUsage({ rate_limit: { primary_window: { ...weekly, used_percent: null } } }));
  assert.equal(normalizeCodexUsage({ rate_limit: null }).sevenDay, null);
});

test('usage requests send only the chosen Codex credentials to the fixed read-only endpoint', async () => {
  const a = { ...account('a'), credential: 'codex-token' };
  let seen;
  const result = await fetchCodexUsage(a, { fetchFn: async (url, options) => { seen = { url, options }; return new globalThis.Response(JSON.stringify(payload)); } });
  assert.deepEqual(result, normalized);
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(seen.options.headers.authorization, 'Bearer codex-token');
  assert.equal(seen.options.headers['ChatGPT-Account-Id'], 'a-id');
  assert.equal(seen.options.method || 'GET', 'GET');
  assert.equal(seen.options.redirect, 'error');
  assert.ok(seen.options.signal instanceof AbortSignal);
  for (const extra of [{ provider: 'anthropic' }, { upstream: 'https://example.invalid' }, { accountId: null }, { type: 'apikey' }]) {
    const refused = await fetchCodexUsage({ ...a, ...extra }, { fetchFn: () => assert.fail('must not send this credential') });
    assert.ok(refused.error);
  }
});

test('HTTP, invalid JSON, and timeout errors do not echo response bodies or credentials', async () => {
  const a = { ...account('a'), credential: 'secret' };
  assert.deepEqual(await fetchCodexUsage(a, { fetchFn: async () => new globalThis.Response('sensitive detail', { status: 401 }) }), { error: 'Codex usage HTTP 401', status: 401 });
  const invalid = await fetchCodexUsage(a, { fetchFn: async () => new globalThis.Response('<html>private</html>') });
  assert.equal(invalid.error, 'Could not read Codex usage');
  const timeout = await fetchCodexUsage(a, { fetchFn: async () => { const error = new Error('private'); error.name = 'TimeoutError'; throw error; } });
  assert.equal(timeout.error, 'Codex usage timed out');
});

test('mixed-provider probing uses the correct reader and never profiles Codex through Anthropic', async () => {
  const am = new AccountManager([account('codex-a'), account('codex-b'), account('claude', { provider: 'anthropic' }), account('custom', { upstream: 'https://custom.invalid' })]);
  const codexSeen = [], claudeSeen = [], profileSeen = [];
  const prober = new Prober(am, {
    codexProbeFn: async a => { codexSeen.push([a.credential, a.accountId]); return normalized; },
    probeFn: async credential => { claudeSeen.push(credential); return { sevenDay: { utilization: 0.2, resetAt: 1900000000000 } }; },
    profileFn: async credential => { profileSeen.push(credential); return {}; }, log: () => {},
  });
  await prober.probeAll();
  assert.deepEqual(codexSeen, [['codex-a-access', 'codex-a-id'], ['codex-b-access', 'codex-b-id']]);
  assert.deepEqual(claudeSeen, ['claude-access']);
  assert.deepEqual(profileSeen, ['claude-access']);
  assert.deepEqual(prober.getStatus().accounts.map(a => a.status), ['ok', 'ok', 'ok', 'not-applicable']);
  assert.equal(am.accounts[0].quota.unified7d, 0.78);
  assert.equal(am.accounts[0].usage.totalRequests, 0);
  assert.equal(am.accounts[0].usage.lastUsed, null);
});

test('Codex probe refreshes on 401 once through the Codex refresh function', async () => {
  let refreshes = 0;
  const am = new AccountManager([account('codex')], 0.98, {
    refreshFn: () => assert.fail('no Anthropic refresh'),
    codexRefreshFn: async () => { refreshes++; return { accessToken: 'fresh', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 }; },
  });
  const seen = [];
  const prober = new Prober(am, {
    codexProbeFn: async a => { seen.push(a.credential); return seen.length === 1 ? { status: 401, error: 'unauthorized' } : normalized; },
    probeFn: () => assert.fail('no Anthropic probe'), log: () => {},
  });
  await prober.probeAll();
  assert.equal(refreshes, 1);
  assert.deepEqual(seen, ['codex-access', 'fresh']);
  assert.equal(prober.getStatus().accounts[0].status, 'ok');
  assert.equal(am.accounts[0].usage.totalRequests, 0);
});

test('disabled, dead-token, and custom-upstream Codex accounts are skipped even by direct probes', async () => {
  const am = new AccountManager([account('disabled', { disabled: true }), account('dead'), account('custom', { upstream: 'https://custom.invalid' })]);
  am.accounts[1]._deadRefreshToken = am.accounts[1].refreshToken;
  const prober = new Prober(am, { codexProbeFn: () => assert.fail('no Codex probe'), probeFn: () => assert.fail('no Anthropic probe') });
  await prober.probeAll();
  for (const a of am.accounts) await prober.probeAccount(a);
});

test('failed probes preserve quota; successful snapshots retire absent windows without changing traffic counters', async () => {
  const am = new AccountManager([account('a')]);
  Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified7d: 0.9, unified5hReset: 1900000000000 });
  am.accounts[0].usage.totalRequests = 7;
  const prober = new Prober(am, { codexProbeFn: async () => ({ error: 'HTTP 500', status: 500 }) });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified7d, 0.9);
  assert.equal(prober.getStatus().accounts[0].status, 'error');
  prober.codexProbeFn = async () => normalized;
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified5h, null);
  assert.equal(am.accounts[0].quota.unified5hReset, null);
  assert.equal(am.accounts[0].quota.unified7d, 0.78);
  assert.equal(am.accounts[0].quota.codexModelBuckets.codex_bengalfox.utilization, 0);
  assert.equal(am.accounts[0].usage.totalRequests, 7);
  assert.equal(prober.getStatus().accounts[0].error, null);
  am.applyCodexUsageData(0, { ...normalized, modelBuckets: [] });
  assert.deepEqual(am.accounts[0].quota.codexModelBuckets, {});
});

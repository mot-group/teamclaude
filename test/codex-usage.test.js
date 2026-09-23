import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCodexUsage, normalizeCodexUsagePayload } from '../src/codex-usage.js';
import { normalizeCodexUsage } from '../src/codex-usage.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const payload = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1700000000 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1700604800 },
  },
  additional_rate_limits: {
    code_review: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1700604800 } },
  },
};

test('normalizes Codex wham usage windows and model buckets', () => {
  const usage = normalizeCodexUsagePayload(payload);
  assert.deepEqual(usage.fiveHour, { utilization: 0.25, resetAt: 1700000000000 });
  assert.deepEqual(usage.sevenDay, { utilization: 0.4, resetAt: 1700604800000 });
  assert.deepEqual(usage.modelBuckets, [{ slug: 'code_review', name: 'code_review', utilization: 0.1, resetAt: 1700604800000 }]);
  assert.equal(usage.planType, 'pro');
});

// The shape a live subscription actually sends: a LIST whose entries name
// themselves. `Object.entries` over it yields array indices, so before this was
// handled every bucket was filed as "0" and "1" — names that identify nothing,
// collide across accounts, and sit beside the header path's name for the same
// bucket instead of replacing it. `metered_feature` is the header's own slug
// with a `codex_` prefix, so stripping it makes the two paths agree on one key.
test('a list of extra limits is named from its entries, not their indices', () => {
  const usage = normalizeCodexUsagePayload({
    plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1700018000 },
          secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1700604800 },
        },
      },
      {
        limit_name: 'gpt-reserve',
        metered_feature: 'base_model_inference',
        rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1700604800 } },
      },
    ],
  });
  assert.deepEqual(usage.modelBuckets, [
    { slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0.03, resetAt: 1700604800000 },
    { slug: 'base_model_inference', name: 'gpt-reserve', utilization: 0.01, resetAt: 1700604800000 },
  ]);
});

// An entry that names itself no way at all is dropped rather than filed under a
// number, which would be indistinguishable from the bug this replaced.
test('an unnamed extra limit is dropped rather than filed under its index', () => {
  const usage = normalizeCodexUsagePayload({
    additional_rate_limits: [
      { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1700604800 } } },
    ],
  });
  assert.deepEqual(usage.modelBuckets, []);
});

// On a live subscription the shared `rate_limit` states a 7-day window and a
// null secondary, so it yields no 5-hour reading at all. The only one the
// payload states sits in an extra limit. Without this fallback the probe could
// never learn a session window, and every rule keyed on it — preemptive
// rotation, expiry clearing, the session-reset switch — stayed unreachable on
// an account the probe was the only reader of.
test("a shared reading with no five-hour window falls back to an extra limit's", () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1700018000 },
          secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1700604800 },
        },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.4, resetAt: 1700018000000 });
  assert.deepEqual(usage.sevenDay, { utilization: 0.07, resetAt: 1700604800000 });
});

// The shared window is the account-wide authority. An extra limit meters the
// models it names, so letting a spent one replace the shared reading would bar
// models it never metered — the one-way ratchet the weekly buckets avoid.
test('an extra limit never replaces a shared five-hour reading', () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1700018000 },
      secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 },
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000, reset_at: 1700099000 } },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.1, resetAt: 1700018000000 });
});

// The weekly guard builds the model bucket; it must not also decide whether the
// 5-hour reading survives, or an extra limit that states only a session window
// is thrown away along with it.
test('an extra limit stating only a five-hour window still contributes it', () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1700018000 } },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.55, resetAt: 1700018000000 });
  assert.deepEqual(usage.modelBuckets, []);
});

test('fetchCodexUsage sends the account-scoped read-only request', async () => {
  let request;
  const usage = await fetchCodexUsage({ provider: 'codex', type: 'oauth', credential: 'secret', accountId: 'acct-1' }, {
    url: 'https://example.test/wham/usage',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(request.url, 'https://example.test/wham/usage');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(usage.sevenDay.utilization, 0.4);
});

test('fetchCodexUsage preserves HTTP status for refresh-on-401', async () => {
  const result = await fetchCodexUsage({ provider: 'codex', type: 'oauth', credential: 'secret', accountId: 'acct-1' }, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.deepEqual(result, { error: 'HTTP 401', status: 401 });
});

// The free rate-limit reset credits ride on this very payload, so reporting
// what an account holds costs no request of its own. Two counts, kept apart:
// `available` is the holdings, `applicable` is upstream's view of how many
// would reset a window right now.
test('reset-credit counts are read from the usage payload', () => {
  const usage = normalizeCodexUsagePayload({
    ...payload,
    rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
  });
  assert.deepEqual(usage.resetCredits, { available: 1, applicable: 0 });
});

test('a payload that mentions no reset credits reports none rather than zero', () => {
  assert.equal(normalizeCodexUsagePayload(payload).resetCredits, null);
  assert.equal(normalizeCodexUsagePayload({ rate_limit_reset_credits: { available_count: 'lots' } }).resetCredits, null);
});

test('an unstated applicable count is null, not zero', () => {
  const usage = normalizeCodexUsagePayload({ rate_limit_reset_credits: { available_count: 2 } });
  assert.deepEqual(usage.resetCredits, { available: 2, applicable: null });
});

// The count is drawn as `RC<n>` on a width-budgeted TUI row, and it comes from a
// private endpoint: whatever arrives has to leave as a small whole number.
test('reset-credit counts are truncated and capped at two digits', () => {
  const read = (available_count, applicable_available_count) =>
    normalizeCodexUsagePayload({ rate_limit_reset_credits: { available_count, applicable_available_count } }).resetCredits;
  assert.deepEqual(read(1.9, 1.2), { available: 1, applicable: 1 });
  assert.deepEqual(read(1e9, 250), { available: 99, applicable: 99 });
  assert.deepEqual(read('3', '0'), { available: 3, applicable: 0 });
  // Not a count at all: dropped, never clamped into one.
  assert.equal(read(Infinity, 1), null);
  assert.equal(read(NaN, 1), null);
  assert.equal(read(-1, 1), null);
  assert.deepEqual(read(2, Infinity), { available: 2, applicable: null });
});

const weekly = { used_percent: 78, limit_window_seconds: 604800, reset_at: 1900000000 };
const fiveHour = { used_percent: 12, limit_window_seconds: 18000, reset_at: 1899500000 };
const forkPayload = {
  plan_type: 'pro', rate_limit: { primary_window: weekly, secondary_window: null },
  additional_rate_limits: [{ metered_feature: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: fiveHour, secondary_window: { ...weekly, used_percent: 0 } } }],
};
const account = (name, extra = {}) => ({ name, type: 'oauth', provider: 'codex', accessToken: name + '-access', refreshToken: name + '-refresh', accountId: name + '-id', expiresAt: Date.now() + 3600000, ...extra });
const normalized = normalizeCodexUsage(forkPayload);

test('Codex usage includes forecast, plan type, and model quotas', () => {
  assert.deepEqual(normalized.fiveHour, { utilization: 0.12, resetAt: 1899500000000 });
  assert.deepEqual(normalized.sevenDay, { utilization: 0.78, resetAt: 1900000000000 });
  assert.equal(normalized.planType, 'pro');
  assert.deepEqual(normalized.modelBuckets, [{ slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0, resetAt: 1900000000000 }]);
  assert.equal(normalized.forecast.plan, 'pro');
  assert.equal(normalized.forecast.enumeration, true);
  assert.equal(normalized.forecast.windows.length, 3);
  const swapped = normalizeCodexUsage({ rate_limit: { primary_window: fiveHour, secondary_window: weekly } });
  assert.equal(swapped.fiveHour.utilization, 0.12);
  assert.equal(swapped.sevenDay.utilization, 0.78);
  assert.equal(normalizeCodexUsage({ rate_limit: null }).sevenDay, null);
});

test('usage requests send only the chosen Codex credentials to the fixed read-only endpoint', async () => {
  const a = { ...account('a'), credential: 'codex-token' };
  let seen;
  const result = await fetchCodexUsage(a, { fetchImpl: async (url, options) => { seen = { url, options }; return new globalThis.Response(JSON.stringify(forkPayload)); } });
  assert.deepEqual(result, normalized);
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(seen.options.headers.Authorization, 'Bearer codex-token');
  assert.equal(seen.options.headers['ChatGPT-Account-Id'], 'a-id');
  assert.equal(seen.options.method || 'GET', 'GET');
  assert.equal(seen.options.redirect, 'error');
  assert.ok(seen.options.signal instanceof AbortSignal);
  for (const extra of [{ provider: 'anthropic' }, { upstream: 'https://example.invalid' }, { accountId: null }, { type: 'apikey' }]) {
    const refused = await fetchCodexUsage({ ...a, ...extra }, { fetchImpl: () => assert.fail('must not send this credential') });
    assert.ok(refused.error);
  }
});

test('HTTP, invalid JSON, and timeout errors do not echo response bodies or credentials', async () => {
  const a = { ...account('a'), credential: 'secret' };
  assert.deepEqual(await fetchCodexUsage(a, { fetchImpl: async () => new globalThis.Response('sensitive detail', { status: 401 }) }), { error: 'HTTP 401', status: 401 });
  const invalid = await fetchCodexUsage(a, { fetchImpl: async () => new globalThis.Response('<html>private</html>') });
  assert.deepEqual(invalid, { error: 'Could not read Codex usage', status: null });
  const timeout = await fetchCodexUsage(a, { fetchImpl: async () => { const error = new Error('private'); error.name = 'TimeoutError'; throw error; } });
  assert.deepEqual(timeout, { error: 'Codex usage timed out', status: null });
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

test('Codex probe observers run in order and cannot fail a successful quota read', async () => {
  const am = new AccountManager([account('codex')]);
  const order = [];
  const resetTracker = {
    error: null,
    observe: () => { order.push('reset'); },
    observeCredits: () => { order.push('credits:observe'); },
    getStatus: () => null,
  };
  const prober = new Prober(am, {
    codexProbeFn: async () => normalized,
    onObservation: () => { order.push('forecast'); throw new Error('forecast failed'); },
    resetTracker,
    creditsFn: async () => { order.push('credits:read'); return { availableCount: 0, credits: [] }; },
  });

  await prober.probeAccount(am.accounts[0]);

  assert.deepEqual(order, ['forecast', 'reset', 'credits:read', 'credits:observe']);
  assert.equal(prober.getStatus().accounts[0].status, 'ok');
  assert.equal(am.accounts[0].quota.unified7d, 0.78);
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
  prober.codexProbeFn = async () => ({ ...normalized, fiveHour: null });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified5h, null);
  assert.equal(am.accounts[0].quota.unified5hReset, null);
  assert.equal(am.accounts[0].quota.unified7d, 0.78);
  assert.equal(am.accounts[0].quota.codexModelBuckets.bengalfox.utilization, 0);
  assert.equal(am.accounts[0].usage.totalRequests, 7);
  assert.equal(prober.getStatus().accounts[0].error, null);
  am.applyCodexUsageData(0, { ...normalized, modelBuckets: [] });
  assert.deepEqual(am.accounts[0].quota.codexModelBuckets, {});
});

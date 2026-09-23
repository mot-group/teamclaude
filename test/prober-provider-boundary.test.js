import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

function oauth(name, extra = {}) {
  return {
    name,
    type: 'oauth',
    accessToken: `${name}-access`,
    refreshToken: `${name}-refresh`,
    expiresAt: Date.now() + 3600_000,
    ...extra,
  };
}

test('scheduled and direct probes never refresh or probe a Codex account', async () => {
  let refreshes = 0;
  let probes = 0;
  let profiles = 0;
  const am = new AccountManager([
    oauth('codex', { provider: 'codex', expiresAt: Date.now() - 1000 }),
  ], 0.98, {
    codexRefreshFn: async () => {
      refreshes++;
      return {
        accessToken: 'codex-fresh',
        refreshToken: 'codex-refresh-2',
        expiresAt: Date.now() + 3600_000,
      };
    },
  });
  const prober = new Prober(am, {
    intervalMs: 300_000,
    probeFn: async () => { probes++; return { error: 'HTTP 401', status: 401 }; },
    profileFn: async () => { profiles++; return {}; },
    log: () => {},
  });

  try {
    await prober.probeAll();
    await prober.probeAccount(am.accounts[0]);
    assert.equal(refreshes, 0);
    assert.equal(probes, 0);
    assert.equal(profiles, 0);
    assert.equal(prober.getStatus().accounts[0].status, 'not-applicable');
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    prober.stop();
  }
});

test('a direct probe never sends custom-upstream OAuth credentials to Anthropic', async () => {
  const am = new AccountManager([
    oauth('custom', { upstream: 'https://example.invalid/anthropic' }),
  ], 0.98);
  let probes = 0;
  let profiles = 0;
  const prober = new Prober(am, {
    intervalMs: 0,
    probeFn: async () => { probes++; return {}; },
    profileFn: async () => { profiles++; return {}; },
    log: () => {},
  });

  await prober.probeAccount(am.accounts[0]);
  assert.equal(probes, 0);
  assert.equal(profiles, 0);
  assert.equal(am.accounts[0].status, 'active');
});

test('a direct probe keeps provider-specific backend quota behavior', async () => {
  const am = new AccountManager([
    oauth('deepseek', { upstream: 'https://api.deepseek.com/anthropic' }),
  ], 0.98);
  let anthropicProbes = 0;
  let backendProbes = 0;
  const prober = new Prober(am, {
    intervalMs: 0,
    probeFn: async () => { anthropicProbes++; return {}; },
    backendFn: async () => { backendProbes++; return { label: 'Balance', text: 'available' }; },
    log: () => {},
  });

  await prober.probeAccount(am.accounts[0]);
  assert.equal(anthropicProbes, 0);
  assert.equal(backendProbes, 1);
});

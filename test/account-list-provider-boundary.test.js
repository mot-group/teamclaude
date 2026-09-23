import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAccountProfiles,
  usesAnthropicAccountMetadata,
  formatAccountSummary,
} from '../src/account-list.js';

const oauth = (name, extra = {}) => ({
  name,
  type: 'oauth',
  accessToken: `${name}-access`,
  refreshToken: `${name}-refresh`,
  expiresAt: 1,
  ...extra,
});

test('account metadata calls stay inside the Anthropic provider boundary', async () => {
  const accounts = [
    oauth('claude'),
    oauth('codex', { provider: 'codex', accountId: 'codex-account' }),
    oauth('custom', { upstream: 'https://example.invalid/anthropic' }),
  ];
  const refreshedTokens = [];
  const profiledTokens = [];
  const phases = [];
  const { profiles, refreshed } = await loadAccountProfiles(accounts, {
    isTokenExpiringSoon: () => true,
    refreshAccessToken: async token => {
      phases.push('refresh');
      refreshedTokens.push(token);
      return {
        accessToken: 'claude-fresh-access',
        refreshToken: 'claude-fresh-refresh',
        expiresAt: 2,
      };
    },
    persistRefreshed: async rows => {
      phases.push('persist');
      assert.deepEqual(rows, [accounts[0]]);
      assert.equal(accounts[0].refreshToken, 'claude-fresh-refresh');
    },
    fetchProfile: async token => {
      phases.push('profile');
      profiledTokens.push(token);
      return { email: 'claude@example.test', accountUuid: 'claude-account' };
    },
  });

  assert.deepEqual(refreshedTokens, ['claude-refresh']);
  assert.deepEqual(profiledTokens, ['claude-fresh-access']);
  assert.deepEqual(refreshed, [accounts[0]]);
  assert.equal(profiles[0].email, 'claude@example.test');
  assert.equal(profiles[1], null);
  assert.equal(profiles[2], null);
  assert.equal(accounts[1].accessToken, 'codex-access');
  assert.equal(accounts[1].refreshToken, 'codex-refresh');
  assert.equal(accounts[2].accessToken, 'custom-access');
  assert.equal(accounts[2].refreshToken, 'custom-refresh');
  assert.deepEqual(phases, ['refresh', 'persist', 'profile']);
});

test('only first-party Anthropic OAuth rows enter profile identity reconciliation', () => {
  assert.equal(usesAnthropicAccountMetadata(oauth('claude')), true);
  assert.equal(usesAnthropicAccountMetadata(oauth('codex', { provider: 'codex' })), false);
  assert.equal(usesAnthropicAccountMetadata(oauth('custom', { upstream: 'https://example.invalid' })), false);
  assert.equal(usesAnthropicAccountMetadata({ name: 'api', type: 'apikey', apiKey: 'secret-prefix' }), false);
});

test('account summaries are provider-correct and never include credential text', () => {
  const api = formatAccountSummary({ name: 'api', type: 'apikey', apiKey: 'secret-prefix' }, null, 0);
  const codex = formatAccountSummary(oauth('codex', { provider: 'codex' }), null, 1);
  const custom = formatAccountSummary(oauth('custom', { upstream: 'https://example.invalid' }), null, 2);
  const claude = formatAccountSummary(oauth('claude'), { hasClaudeMax: true }, 3);

  assert.match(api[0], /api \(apikey\)/);
  assert.doesNotMatch(api.join('\n'), /secret-prefix/);
  assert.match(codex[0], /Codex subscription/);
  assert.match(custom[0], /custom upstream OAuth/);
  assert.match(claude[0], /Claude Max/);
});

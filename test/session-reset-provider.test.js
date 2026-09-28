import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// With expiry routing off, the "session quota reset and weekly expires sooner"
// switch ran with no exclusion set, so it could spend an Anthropic account's
// reset inside a Codex selection walk. The walk then found its slot on an
// account it cannot use and re-picked from scratch, which dropped a manual
// Codex switch onto whichever Codex account reset its weekly first.

const HOUR = 3600_000;
const now = Date.now();
const anthropic = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: now + HOUR });
const codex = (name) => ({ ...anthropic(name), provider: 'codex', accountId: `id-${name}` });

function fleet() {
  const am = new AccountManager([anthropic('claude-a'), anthropic('claude-b'), codex('codex-a'), codex('codex-b')], 0.98);
  const [ca, cb, xa, xb] = am.accounts;
  ca.quota.unified5h = 0.3;
  ca.quota.unified5hReset = now + 3 * HOUR;
  ca.quota.unified7d = 0.5;
  ca.quota.unified7dReset = now + 60 * HOUR;
  // Its 5h window just rolled, and its weekly lapses sooner than anything else.
  cb.quota.unified5h = 0.9;
  cb.quota.unified5hReset = now - 1000;
  cb.quota.unified7d = 0.8;
  cb.quota.unified7dReset = now + 28 * HOUR;
  // codex-a resets first, so a from-scratch pick lands on it.
  xa.quota.unified7d = 0.41;
  xa.quota.unified7dReset = now + 120 * HOUR;
  xb.quota.unified7d = 0.36;
  xb.quota.unified7dReset = now + 120 * HOUR + 225_000;
  return am;
}

const codexPick = (am) => am.getActiveAccount(null, 'gpt-6-sol', null, 's1', 'codex')?.name;
const claudePick = (am) => am.getActiveAccount(null, 'claude-opus-5-5', null, 's2')?.name;

test('an Anthropic reset does not move a manual Codex choice', () => {
  const am = fleet();
  am.setCurrentAccount(3);
  assert.equal(codexPick(am), 'codex-b');
  am.getStatus();                                   // observe the 5h rollover
  assert.equal(codexPick(am), 'codex-b', 'the Codex request spent the Anthropic reset');
});

test('the Anthropic reset is left for the next Anthropic request', () => {
  const am = fleet();
  am.setCurrentAccount(0);
  am.setCurrentAccount(3);                          // Codex now owns the slot
  am.getStatus();
  assert.equal(codexPick(am), 'codex-b');
  assert.equal(claudePick(am), 'claude-b', 'the reset switch should still run for Anthropic');
  assert.equal(codexPick(am), 'codex-b');
});

test('a poll spends the reset only for the provider that owns the slot', () => {
  const am = fleet();
  am.setCurrentAccount(3);
  am.getStatus();
  am.refreshExpiredQuotas();                        // TUI loop, no request in hand
  assert.equal(am.currentIndex, 3);
  assert.equal(am.accounts[1].sessionResetPending, true);
});

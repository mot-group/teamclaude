import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { syncRefreshedTokens } from '../src/account-pairing.js';

const HOUR = 3600_000;
const jwt = (id, expiry) => `e30.${Buffer.from(JSON.stringify({ exp: expiry, 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.sig`;
const direct = (id, extra = {}) => ({ id: `entry-${id}`, name: id, type: 'oauth', provider: 'codex', source: 'login',
  accountId: id, accessToken: `token-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + HOUR, ...extra });
const copy = value => JSON.parse(JSON.stringify(value));

async function fileFixture(t, { opaque = false, missing = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-codex-reload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const write = async (id, extra = {}) => writeFile(path, JSON.stringify({ tokens: {
    access_token: opaque ? `opaque-${id}` : jwt(id, expiry), refresh_token: `file-refresh-${id}`, account_id: id, ...extra,
  } }));
  if (!missing) await write('A');
  const disk = { accounts: [{ id: 'entry-file', name: 'file', type: 'oauth', provider: 'codex', importFrom: path }] };
  const mem = copy(disk);
  return { path, disk, mem, write, expiry };
}

for (const opaque of [false, true]) {
  test(`reload does not restore an unchanged stale file after refresh, opaque=${opaque}`, async t => {
    const { disk, mem } = await fileFixture(t, { opaque });
    const am = new AccountManager(await resolveAccounts(disk), 0.98, {
      codexRefreshFn: async () => ({ accessToken: 'fresh-A', refreshToken: 'rotated-A', expiresAt: Date.now() + HOUR * 2 }),
    });
    am.onTokenRefresh((i, tokens) => syncRefreshedTokens(mem.accounts, am.accounts, i, tokens));
    await am.ensureTokenFresh(0, true);
    for (let i = 0; i < 2; i++) await syncAccountsFromDisk(disk, mem, am);
    assert.equal(am.accounts[0].credential, 'fresh-A');
    assert.equal(am.accounts[0].refreshToken, 'rotated-A');
    assert.equal(mem.accounts[0].accessToken, undefined);
  });
}

test('reload resolves new and reappearing Codex files without admitting empty credentials', async t => {
  const { disk, mem, write } = await fileFixture(t, { missing: true });
  const am = new AccountManager([]);
  for (let i = 0; i < 2; i++) assert.equal(await syncAccountsFromDisk(disk, mem, am), 0);
  assert.equal(mem.accounts.length, 1);
  assert.equal(am.accounts.length, 0);
  await write('A');
  assert.equal(await syncAccountsFromDisk(disk, mem, am), 1);
  assert.equal(am.accounts[0].accountId, 'A');
  assert.equal(mem.accounts[0].accountId, undefined);
  const freshMem = { accounts: [] };
  const freshAm = new AccountManager([]);
  assert.equal(await syncAccountsFromDisk(disk, freshMem, freshAm), 1);
  assert.equal(freshAm.accounts[0].id, freshMem.accounts[0].id);
  assert.equal(freshAm.accounts[0].refreshToken, 'file-refresh-A');
});

test('a file account ID change replaces the complete tuple and resets stale quota and refresh floor', async t => {
  const { disk, mem, write } = await fileFixture(t);
  const am = new AccountManager(await resolveAccounts(disk));
  am.accounts[0].expiresAt = Date.now() + HOUR * 3;
  am.accounts[0]._lastRefreshAt = Date.now();
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + HOUR;
  await write('B', { refresh_token: undefined });
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].accountId, 'B');
  assert.equal(am.accounts[0].refreshToken, null);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0]._lastRefreshAt, null);
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('a newer same-account file is re-imported and an unreadable file keeps the running tuple', async t => {
  const { disk, mem, write, expiry, path } = await fileFixture(t);
  const am = new AccountManager(await resolveAccounts(disk));
  const token = jwt('A', expiry + 3600);
  await write('A', { access_token: token, refresh_token: 'changed-A' });
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].credential, token);
  assert.equal(am.accounts[0].refreshToken, 'changed-A');
  await rm(path);
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].credential, token);
});

test('Codex reload pairs stable entry IDs across renames, list order and equal display names', async () => {
  const mem = { accounts: [direct('B', { name: 'same' }), direct('C', { name: 'same' }),
    { id: 'anthropic', name: 'same', type: 'oauth', accessToken: 'anthropic-token' }] };
  const am = new AccountManager(mem.accounts);
  const disk = copy(mem);
  disk.accounts.reverse();
  disk.accounts[2].name = 'renamed-B';
  disk.accounts[2].accessToken = 'new-B';
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].name, 'renamed-B');
  assert.equal(am.accounts[0].credential, 'new-B');
  assert.equal(am.accounts[1].credential, 'token-C');
  assert.equal(am.accounts[2].credential, 'anthropic-token');
  assert.equal(mem.accounts[0].name, 'renamed-B');
});

test('Codex reload keeps a fresher direct tuple intact', async () => {
  const mem = { accounts: [direct('B')] };
  const am = new AccountManager(mem.accounts);
  const disk = { accounts: [direct('B', { accessToken: 'old-B', refreshToken: 'old-refresh', expiresAt: 1 })] };
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].credential, 'token-B');
  assert.equal(mem.accounts[0].refreshToken, 'refresh-B');
});

test('a malformed direct reload cannot replace a running account with native or foreign credentials', async () => {
  const mem = { accounts: [direct('B')] };
  const am = new AccountManager(mem.accounts);
  for (const accessToken of [null, jwt('A', 1234)]) {
    const disk = { accounts: [direct('B', { accessToken })] };
    await syncAccountsFromDisk(disk, mem, am);
    assert.equal(am.accounts[0].credential, 'token-B');
    assert.equal(am.accounts[0].accountId, 'B');
  }
});

test('a refresh completing after identity replacement cannot cross the account even with the same refresh string', async () => {
  let finish;
  const am = new AccountManager([direct('B', { refreshToken: 'shared-string', expiresAt: 1 })], 0.98, {
    codexRefreshFn: () => new Promise(r => { finish = r; }),
  });
  const pending = am.ensureTokenFresh(0, true);
  am.updateAccountTokens(0, { accessToken: 'new-C', refreshToken: 'shared-string', expiresAt: Date.now() + HOUR, accountId: 'C' });
  finish({ accessToken: jwt('B', 1234), refreshToken: 'returned-B' });
  await pending;
  assert.equal(am.accounts[0].credential, 'new-C');
  assert.equal(am.accounts[0].accountId, 'C');
  assert.equal(am.accounts[0].refreshToken, 'shared-string');
});

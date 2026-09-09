import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { loadConfig, saveConfig } from '../src/config.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { AccountManager } from '../src/account-manager.js';
import { mergeAccountsForSave, syncRefreshedTokens } from '../src/account-pairing.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { upsertCodexAccount, importCodexCredentials } from '../src/codex-auth.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;
const jwt = (id, exp = Math.floor((Date.now() + HOUR) / 1000)) =>
  `e30.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.sig`;
const direct = (id, extra = {}) => ({
  id: `entry-${id}`, name: id, type: 'oauth', provider: 'codex', source: 'login', accountId: id,
  accessToken: jwt(id), refreshToken: `refresh-${id}`, expiresAt: Date.now() + HOUR, ...extra,
});
const configFor = accounts => ({ accounts, upstreamProxy: false, proxy: { port: 0, apiKey: 'dummy-key' } });

async function fixture(t) {
  const home = await mkdtemp(join(os.tmpdir(), 'tc-codex-ownership-'));
  const original = os.homedir;
  const oldConfig = process.env.TEAMCLAUDE_CONFIG;
  os.homedir = () => home;
  syncBuiltinESMExports();
  process.env.TEAMCLAUDE_CONFIG = join(home, 'config.json');
  t.after(async () => {
    os.homedir = original;
    syncBuiltinESMExports();
    if (oldConfig === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = oldConfig;
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, '.codex'));
  const path = join(home, '.codex/auth.json');
  const writeAuth = async (id, extra = {}) => {
    await writeFile(path, JSON.stringify({ tokens: {
      access_token: jwt(id), refresh_token: `file-refresh-${id}`, account_id: id, ...extra,
    } }));
  };
  await writeAuth('native-A');
  return { home, path, writeAuth };
}

for (const native of ['present', 'missing', 'malformed']) {
  test(`direct Codex logins retain distinct tuples with native auth ${native}`, async t => {
    const { path } = await fixture(t);
    if (native === 'missing') await rm(path);
    if (native === 'malformed') await writeFile(path, '{invalid');
    const accounts = [direct('B'), direct('C')];
    assert.deepEqual(await resolveAccounts(configFor(accounts)), accounts);
  });
}

test('a damaged direct login never borrows native auth', async t => {
  await fixture(t);
  const accounts = [direct('B', { accessToken: null }), direct('C', { accessToken: '  ' }),
    { name: 'id-only', type: 'oauth', provider: 'codex', accountId: 'D' }, direct('healthy')];
  assert.deepEqual((await resolveAccounts(configFor(accounts))).map(a => a.name), ['healthy']);
});

test('a substituted access-token identity is rejected before any refresh', async t => {
  await fixture(t);
  const accounts = await resolveAccounts(configFor([direct('B', { accessToken: jwt('native-A') })]));
  let grants = 0;
  const am = new AccountManager(accounts, 0.98, { codexRefreshFn: async () => { grants++; } });
  await am.ensureTokenFresh(0, true);
  assert.equal(accounts.length, 0);
  assert.equal(grants, 0);
});

test('legacy rows with materialized tokens remain file-backed through save and restart', async t => {
  const { writeAuth, path } = await fixture(t);
  const legacy = { id: 'legacy', name: 'legacy', type: 'oauth', provider: 'codex',
    accessToken: 'old-copy', refreshToken: 'old-refresh', expiresAt: 1 };
  await writeFile(process.env.TEAMCLAUDE_CONFIG, JSON.stringify(configFor([legacy])));
  const config = await loadConfig();
  assert.equal(config.accounts[0].importFrom, '~/.codex/auth.json');
  const am = new AccountManager(await resolveAccounts(config));
  assert.equal(am.accounts[0].accountId, 'native-A');
  const before = await readFile(path, 'utf8');
  const tokens = { accessToken: jwt('native-A'), refreshToken: 'fresh-file-copy', expiresAt: Date.now() + HOUR };
  assert.equal(syncRefreshedTokens(config.accounts, am.accounts, 0, tokens), -1);
  config.accounts = mergeAccountsForSave(config.accounts, am.accounts, [legacy]);
  await saveConfig(config);
  assert.equal(await readFile(path, 'utf8'), before);
  await writeAuth('native-D');
  const restarted = await resolveAccounts(await loadConfig());
  assert.equal(restarted[0].accountId, 'native-D');
  assert.equal(restarted[0].refreshToken, 'file-refresh-native-D');
});

test('explicit Codex imports override all stale inline identity and expiry fields', async t => {
  const { path, writeAuth } = await fixture(t);
  const exp = Math.floor((Date.now() + HOUR) / 1000);
  await writeAuth('A', { access_token: jwt('A', exp) });
  const [resolved] = await resolveAccounts(configFor([direct('B', { importFrom: path, expiresAt: 1 })]));
  assert.equal(resolved.accountId, 'A');
  assert.equal(resolved.expiresAt, exp * 1000);
  await writeAuth('A', { access_token: 'opaque' });
  const [opaque] = await resolveAccounts(configFor([direct('B', { importFrom: path })]));
  assert.equal(opaque.expiresAt, null);
});

test('Codex enrollment prefers account ID and refuses conflicting names', () => {
  const accounts = [direct('other', { name: 'same' }), direct('B', { name: 'saved-name', importFrom: '/tmp/auth', priority: 4 })];
  const result = upsertCodexAccount(accounts, direct('B', { name: 'same', refreshToken: 'new-grant' }));
  assert.equal(result.updated, true);
  assert.equal(accounts[1].name, 'saved-name');
  assert.equal(accounts[1].priority, 4);
  assert.equal(accounts[1].id, 'entry-B');
  assert.equal(accounts[1].importFrom, undefined);
  assert.equal(accounts[0].refreshToken, 'refresh-other');
  assert.throws(() => upsertCodexAccount(accounts, direct('C', { name: 'same' })), /distinct --name/);
  upsertCodexAccount(accounts, direct('C'));
  assert.equal(accounts.length, 3);
});

test('an opaque re-enrollment preserves a known account ID', () => {
  const accounts = [direct('B')];
  upsertCodexAccount(accounts, { name: 'B', type: 'oauth', provider: 'codex', accessToken: 'opaque', refreshToken: 'new' });
  assert.equal(accounts[0].accountId, 'B');
  assert.equal(accounts[0].refreshToken, 'new');
});

test('a missed reload cannot undo enrollment during a TUI save', async t => {
  const { path } = await fixture(t);
  const fileEntry = direct('B', { importFrom: path });
  const mem = [fileEntry];
  const am = new AccountManager(await resolveAccounts(configFor(mem)));
  const disk = JSON.parse(JSON.stringify(mem));
  upsertCodexAccount(disk, direct('B', { refreshToken: 'new-B' }));
  let saved = mergeAccountsForSave(mem, am.accounts, disk);
  assert.equal(saved[0].importFrom, undefined);
  assert.equal(saved[0].refreshToken, 'new-B');
  await syncAccountsFromDisk(configFor(saved), configFor(mem), am);
  saved = mergeAccountsForSave(mem, am.accounts, saved);
  await saveConfig(configFor(saved));
  const [restarted] = await resolveAccounts(await loadConfig());
  assert.equal(restarted.accountId, 'B');
  assert.equal(restarted.refreshToken, 'new-B');
  assert.equal(mem[0].importFrom, undefined);
});

test('a disk transition to file ownership removes every absent inline field during save', () => {
  const mem = [direct('B')];
  const disk = [{ id: mem[0].id, name: 'B', type: 'oauth', provider: 'codex', importFrom: '/tmp/new-auth' }];
  const [saved] = mergeAccountsForSave(mem, new AccountManager(mem).accounts, disk);
  for (const key of ['source', 'accessToken', 'refreshToken', 'accountId', 'expiresAt']) assert.equal(saved[key], undefined);
  assert.equal(saved.importFrom, '/tmp/new-auth');
});

test('queued Codex refresh writes cannot replace re-enrollment or cross source ownership', () => {
  const old = direct('B');
  const am = new AccountManager([old]);
  const fresh = { accessToken: jwt('B'), refreshToken: 'refresh-returned', previousRefreshToken: old.refreshToken };
  const disk = [direct('B', { refreshToken: 'new-enrollment' })];
  assert.equal(syncRefreshedTokens(disk, am.accounts, 0, fresh), -1);
  assert.equal(disk[0].refreshToken, 'new-enrollment');
  const fileAm = new AccountManager([direct('B', { importFrom: '/tmp/file' })]);
  assert.equal(syncRefreshedTokens(disk, fileAm.accounts, 0, fresh), -1);
  const withoutId = [direct('B', { refreshToken: null })];
  delete withoutId[0].accountId;
  assert.equal(syncRefreshedTokens(withoutId, am.accounts, 0, fresh), 0);
  assert.equal(withoutId[0].accountId, 'B');
  assert.equal(Object.hasOwn(withoutId[0], 'previousRefreshToken'), false);
});

test('a foreign refreshed token is rejected and its grant is not retried', async () => {
  let grants = 0;
  let persisted = 0;
  const am = new AccountManager([direct('B', { accessToken: 'opaque', expiresAt: 1 })], 0.98, {
    codexRefreshFn: async () => { grants++; return { accessToken: jwt('A'), refreshToken: 'foreign-rotated' }; },
  });
  am.onTokenRefresh(() => { persisted++; });
  await am.ensureTokenFresh(0, true);
  await am.ensureTokenFresh(0, true);
  assert.equal(grants, 1);
  assert.equal(persisted, 0);
  assert.equal(am.accounts[0].credential, 'opaque');
  assert.equal(am.accounts[0].status, 'error');
});

test('direct refresh, persistence and restart keep the pinned upstream token and ID on B', async t => {
  const { path } = await fixture(t);
  const nativeBefore = await readFile(path, 'utf8');
  await saveConfig(configFor([direct('B', { expiresAt: 1 }), direct('C')]));
  const config = await loadConfig();
  let sentRefresh;
  const refreshed = jwt('B', Math.floor(Date.now() / 1000) + 7200);
  const am = new AccountManager(await resolveAccounts(config), 0.98, {
    codexRefreshFn: async token => {
      sentRefresh = token;
      return { accessToken: refreshed, refreshToken: 'B-rotated', expiresAt: Date.now() + HOUR };
    },
  });
  am.onTokenRefresh((i, tokens) => syncRefreshedTokens(config.accounts, am.accounts, i, tokens));
  await am.ensureTokenFresh(0);
  assert.equal(sentRefresh, 'refresh-B');
  await saveConfig({ ...config, accounts: mergeAccountsForSave(config.accounts, am.accounts, []) });
  const restarted = new AccountManager(await resolveAccounts(await loadConfig()));
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(req.headers); res.end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  for (const a of restarted.accounts) a.upstream = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createProxyServer(restarted, config);
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const res = await fetch(`http://127.0.0.1:${proxy.address().port}/tc-acct/B/backend-api/codex/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'chatgpt-account-id': 'native-A' },
    body: JSON.stringify({ model: 'gpt-5', input: 'dummy' }),
  });
  await res.text();
  assert.equal(res.status, 200);
  assert.equal(seen[0].authorization, `Bearer ${refreshed}`);
  assert.equal(seen[0]['chatgpt-account-id'], 'B');
  assert.equal(restarted.accounts[1].refreshToken, 'refresh-C');
  assert.equal(await readFile(path, 'utf8'), nativeBefore);
});

test('Codex import derives expiry only from a valid numeric JWT exp', async t => {
  const { path, writeAuth } = await fixture(t);
  for (const exp of [null, '123', -1]) {
    await writeAuth('A', { access_token: jwt('A', exp) });
    assert.equal((await importCodexCredentials(path)).expiresAt, null);
  }
});

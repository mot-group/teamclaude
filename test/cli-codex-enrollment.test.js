import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function runCli(home, configPath, credentials, args) {
  const child = spawn(process.execPath, ['--import', join(home, 'register.mjs'), cli, ...args], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, TEAMCLAUDE_CONFIG: configPath,
      TEAMCLAUDE_DISABLE_AUTOUPDATE: '1', CODEX_TEST_CREDENTIALS: JSON.stringify(credentials) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${output}`)); }, 10_000);
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

test('Codex CLI enrollment removes file ownership, saves IDs, and notifies the server with the saved config', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tc-cli-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'));
  const nativePath = join(home, '.codex/auth.json');
  const native = JSON.stringify({ tokens: { access_token: 'native-A', refresh_token: 'native-refresh', account_id: 'A' } });
  await writeFile(nativePath, native);
  await writeFile(join(home, 'register.mjs'), `import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`);
  await writeFile(join(home, 'loader.mjs'), `
    export async function load(url, context, nextLoad) {
      const result = await nextLoad(url, context);
      if (!url.endsWith('/src/codex-auth.js')) return result;
      const source = String(result.source).replace('export async function loginCodex(', 'async function unusedLoginCodex(')
        + '\\nexport async function loginCodex() { return JSON.parse(process.env.CODEX_TEST_CREDENTIALS); }';
      return { ...result, source };
    }
  `);
  const configPath = join(home, 'config.json');
  const notifications = [];
  const server = http.createServer(async (req, res) => {
    notifications.push({ path: req.url, key: req.headers['x-api-key'], config: JSON.parse(await readFile(configPath, 'utf8')) });
    res.setHeader('content-type', 'application/json');
    res.end('{"added":1}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(configPath, JSON.stringify({
    upstreamProxy: false, proxy: { port: server.address().port, apiKey: 'dummy-proxy' }, accounts: [
      { id: 'existing-entry', name: 'pooled-B', type: 'oauth', provider: 'codex', accountId: 'B',
        importFrom: nativePath, priority: 4, disabled: true },
      { id: 'unrelated', name: 'unrelated', type: 'apikey', apiKey: 'unchanged' },
    ],
  }));
  const creds = { accountId: 'B', accessToken: 'enrolled-B', refreshToken: 'separate-B', expiresAt: Date.now() + 3600_000 };
  const result = await runCli(home, configPath, creds, ['login', '--codex', '--name', 'pooled-B', '--no-browser']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Reloaded running server/);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].path, '/teamclaude/reload');
  assert.equal(notifications[0].key, 'dummy-proxy');
  const saved = notifications[0].config.accounts[0];
  assert.equal(saved.id, 'existing-entry');
  assert.equal(saved.source, 'login');
  assert.equal(saved.importFrom, undefined);
  assert.equal(saved.refreshToken, 'separate-B');
  assert.equal(saved.priority, 4);
  assert.equal(saved.disabled, true);
  assert.equal(notifications[0].config.accounts[1].apiKey, 'unchanged');
  const added = await runCli(home, configPath, { ...creds, accountId: 'C' }, ['login', '--codex', '--name', 'pooled-C']);
  assert.equal(added.code, 0, added.output);
  const newEntry = notifications[1].config.accounts[2];
  assert.equal(typeof newEntry.id, 'string');
  assert.ok(newEntry.id.length > 0);
  const beforeCollision = await readFile(configPath, 'utf8');
  const collision = await runCli(home, configPath, { ...creds, accountId: 'D' }, ['login', '--codex', '--name', 'pooled-B']);
  assert.equal(collision.code, 1);
  assert.match(collision.output, /Codex enrollment failed:.*distinct --name/);
  assert.doesNotMatch(collision.output, /\n\s+at /);
  assert.equal(notifications.length, 2);
  assert.equal(await readFile(configPath, 'utf8'), beforeCollision);
  assert.equal(await readFile(nativePath, 'utf8'), native);
});

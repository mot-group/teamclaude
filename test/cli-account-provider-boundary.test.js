import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = process.env.TEAMCLAUDE_TEST_CLI
  || fileURLToPath(new URL('../src/index.js', import.meta.url));

async function runAccountCommand(accounts, command = ['accounts', '--verbose']) {
  const directory = await mkdtemp(join(tmpdir(), 'teamclaude-provider-cli-'));
  const configPath = join(directory, 'config.json');
  const connections = [];
  const proxy = http.createServer((request, response) => {
    connections.push(`HTTP ${request.url}`);
    response.writeHead(502);
    response.end();
  });
  proxy.on('connect', (request, socket) => {
    connections.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 3, apiKey: 'synthetic-proxy-key' },
      upstream: `http://127.0.0.1:${proxy.address().port}`,
      upstreamProxy: `http://127.0.0.1:${proxy.address().port}`,
      autoUpdate: false,
      accounts,
    }));
    const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
    delete env.NO_PROXY;
    delete env.no_proxy;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...command], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Synthetic account-list fixture timed out'));
      }, 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    return { ...result, connections, saved: JSON.parse(await readFile(configPath, 'utf8')) };
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

function oauth(id, extra = {}) {
  return {
    id, name: id, type: 'oauth',
    accessToken: `synthetic-access-${id}`,
    refreshToken: `synthetic-refresh-${id}`,
    expiresAt: Date.now() - 60_000,
    ...extra,
  };
}

test('accounts CLI never sends or refreshes non-Anthropic credentials and never prints keys', async () => {
  const accounts = [
    oauth('codex', { provider: 'codex', accountId: 'synthetic-codex-account' }),
    oauth('custom', { upstream: 'https://example.invalid/anthropic' }),
    { id: 'api', name: 'api', type: 'apikey', apiKey: 'SYNTHETIC_API_SECRET_DO_NOT_PRINT' },
  ];
  const result = await runAccountCommand(accounts);
  assert.equal(result.code, 0);
  assert.equal(result.connections.length, 0, 'non-Anthropic listing must make no network connection');
  assert.deepEqual(result.saved.accounts, accounts);
  assert.match(result.stdout, /Codex subscription/);
  assert.match(result.stdout, /custom upstream OAuth/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_API_S|synthetic-access-|synthetic-refresh-/);
});

test('accounts CLI keeps Claude and Codex identities separate during real reconciliation', async () => {
  const accounts = [
    oauth('claude', { accountUuid: 'overlap', orgUuid: 'same-org', expiresAt: Date.now() + 3_600_000 }),
    oauth('codex', { provider: 'codex', accountId: 'codex-account', accountUuid: 'overlap', orgUuid: 'same-org' }),
  ];
  const result = await runAccountCommand(accounts);
  assert.equal(result.code, 0);
  assert.ok(result.connections.length > 0, 'the Claude profile must still be queried through the fake proxy');
  assert.deepEqual(result.saved.accounts, accounts, 'provider-specific identities must not be merged or renamed');
  assert.match(result.stdout, /Codex subscription/);
});

test('Anthropic API convenience command rejects Codex credentials before connecting', async () => {
  const accounts = [oauth('codex', { provider: 'codex', accountId: 'synthetic-codex-account' })];
  for (const selection of [[], ['--account', 'codex']]) {
    const result = await runAccountCommand(accounts, ['api', '/v1/models', ...selection]);
    assert.equal(result.connections.length, 0, 'Codex selection must not make an Anthropic connection');
    assert.equal(result.code, 1);
    assert.deepEqual(result.saved.accounts, accounts);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-access-|synthetic-refresh-/);
  }
});

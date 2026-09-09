import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('native server loads and reloads the option while preserving confirmed readings and explicit pins', { timeout: 20000 }, async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-served-by': req.headers.authorization,
      ...(req.headers.authorization === 'Bearer t-b' ? {
        'anthropic-ratelimit-unified-7d_oi-utilization': '0.99',
        'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(Date.now() / 1000) + 3600),
      } : {}),
    });
    res.end('{}');
  });
  const upPort = await listen(upstream);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'tc-fable-reload-'));
  const configPath = join(dir, 'teamclaude.json');
  const config = {
    proxy: { port, apiKey: 'test' }, upstream: `http://127.0.0.1:${upPort}`,
    preferFableDepletedAccounts: true, quotaProbeSeconds: 0, stormRamp: { enabled: false },
    accounts: ['a', 'b'].map(name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'fake', expiresAt: Date.now() + 3600_000 })),
  };
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url)), 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const request = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts, headers: { 'x-api-key': 'test', 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
  });
  const post = async path => {
    const res = await request(path, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: [] }) });
    await res.text();
    assert.equal(res.status, 200);
    return res.headers.get('x-served-by');
  };
  try {
    let status;
    for (let attempt = 0; attempt < 60; attempt++) {
      status = await request('/teamclaude/status').then(r => r.json()).catch(() => null);
      if (status) break;
      if (child.exitCode != null) assert.fail(output);
      await delay(50);
    }
    assert.ok(status, output);
    assert.equal(status.fableDepletionRouting.enabled, true);
    assert.equal(await post('/v1/messages'), 'Bearer t-a', 'startup is unconfirmed');
    assert.equal(await post('/tc-acct/b/v1/messages'), 'Bearer t-b');
    assert.equal(await post('/v1/messages'), 'Bearer t-b');
    assert.equal(await post('/tc-acct/a/v1/messages'), 'Bearer t-a', 'explicit pin overrides preference');
    for (const enabled of [false, true]) {
      const latest = JSON.parse(await readFile(configPath, 'utf8'));
      latest.preferFableDepletedAccounts = enabled;
      await writeFile(configPath, JSON.stringify(latest));
      const reload = await request('/teamclaude/reload', { method: 'POST' });
      assert.equal(reload.status, 200);
      await reload.text();
      status = await request('/teamclaude/status').then(r => r.json());
      assert.equal(status.fableDepletionRouting.enabled, enabled);
      assert.equal(status.accounts[1].fableEvidence, 'confirmed');
      assert.equal(await post('/v1/messages'), enabled ? 'Bearer t-b' : 'Bearer t-a');
    }
  } finally {
    child.kill();
    await exited;
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

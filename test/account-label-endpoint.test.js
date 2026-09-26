import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// POST /teamclaude/accounts/label is the dashboard's rename. It writes a
// display-only `label` and leaves `name` alone: API-key accounts pair config
// rows to running accounts by name, so a rename there would add a duplicate on
// the reload that follows. Driven against the real CLI so the file is the witness.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('a label is written, shown in status, and cleared, without touching the name', async () => {
  const port = await closedPort();
  const dead = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-label-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${dead}`,
    upstreamProxy: false,
    accounts: [
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    ],
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['a@example.com'] }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  const base = `http://127.0.0.1:${port}/teamclaude`;
  const rename = body => fetch(`${base}/accounts/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = async () => (await (await fetch(`${base}/status`)).json()).accounts;
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { if ((await fetch(`${base}/status`)).ok) break; } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise(r => setTimeout(r, 100));
    }

    const set = await rename({ account: 'a@example.com', provider: 'anthropic', label: '  Team A  ' });
    assert.equal(set.status, 200, await set.clone().text());
    const onDisk = await disk();
    assert.equal(onDisk.accounts[0].label, 'Team A');
    assert.equal(onDisk.accounts[0].name, 'a@example.com');
    assert.equal(onDisk.accounts.length, 2);
    assert.deepEqual(onDisk.routes[0].accounts, ['a@example.com']);
    const live = await status();
    assert.equal(live.length, 2, 'the reload did not add a duplicate');
    assert.equal(live[0].label, 'Team A');
    assert.equal(live[0].name, 'a@example.com');

    assert.equal((await rename({ account: 'a@example.com', provider: 'anthropic', label: 'x'.repeat(65) })).status, 400);
    assert.equal((await rename({ account: 'a@example.com', provider: 'anthropic', label: 'a\nb' })).status, 400);
    assert.equal((await rename({ account: 'nobody', provider: 'anthropic', label: 'X' })).status, 404);
    assert.equal((await rename({ account: 'a@example.com', provider: 'codex', label: 'X' })).status, 404);

    const cleared = await rename({ account: 'a@example.com', provider: 'anthropic', label: '' });
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn((await disk()).accounts[0], 'label'), false);
    assert.equal((await status())[0].label, null);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.on('exit', r));
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountManager } from '../src/account-manager.js';
import { createControlQueue } from '../src/control-queue.js';
import { createToolSet } from '../src/mcp-tools.js';
import { TUI } from '../src/tui.js';

// FR 16: every in-process settings writer and every reload take turns on one
// queue, and a write and the reload that applies it are one unit. index.js
// builds its queue with createControlQueue over reloadAccounts and hands the
// pieces out; each writer below is wired the way index.js wires it. A writer's
// write step is recorded when it starts, so "did not run" is an order check,
// not a timing guess.

function gate() {
  /** @type {() => void} */
  let release = () => {};
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, release };
}

async function until(cond, what) {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise(r => setTimeout(r, 2));
  }
}

/** Let everything already runnable run, so a unit that could start would have. */
const drain = () => new Promise(r => setTimeout(r, 20));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-serialize-'));
  const configPath = join(dir, 'config.json');
  process.env.TEAMCLAUDE_CONFIG = configPath;
  const fleet = [{ id: 'id-a', name: 'a@example.com', type: 'apikey', apiKey: 'k1' }];
  await writeFile(configPath, JSON.stringify({ proxy: { apiKey: 'tc', mcp: 'full' }, switchThreshold: 0.98, routes: [], accounts: fleet }));
  /** @type {string[]} */
  const order = [];
  let failReload = false;
  const queue = createControlQueue(async () => {
    order.push('reload:start');
    await new Promise(r => setTimeout(r, 5));
    if (failReload) { failReload = false; order.push('reload:failed'); throw new Error('bad schedule'); }
    order.push('reload:end');
    return 0;
  });
  // MCP, as index.js exposes the hooks; the wrapper records when the write step starts.
  // It also counts arrivals: MCP's own write queue adds a few async hops
  // before the call joins this queue, and a test that wants MCP ahead of the
  // next writer waits for that.
  const mcp = { arrived: 0 };
  const hooks = {
    reload: queue.reloadQueued,
    applyChange: write => { mcp.arrived++; return queue.applyChange(() => { order.push('mcp:write'); return write(); }); },
  };
  const tools = createToolSet('full', { accountManager: new AccountManager(fleet, 0.98), config: {}, hooks, client: 'ci' });
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  return { queue, order, tools, disk, mcp, failReload: () => { failReload = true; } };
}

const cycle = ['reload:start', 'reload:end'];

test('a paused dashboard save holds back MCP, a TUI save, a bare reload and a rename', async () => {
  const { queue, order, tools, disk, mcp: arrivals } = await setup();
  const g = gate();
  // The dashboard save: a write and its reload in one applyChange unit.
  const first = queue.applyChange(async () => { order.push('dash:write'); await g.promise; });
  await until(() => order.includes('dash:write'), 'the dashboard write started');

  const mcp = tools.call('set_threshold', { percent: 70 });
  await until(() => arrivals.arrived === 1, 'the MCP write joined the queue');
  // The TUI settings save: its write is queued; its reload is a separate reloadQueued unit.
  const tuiSave = queue.queued(async () => { order.push('tui:write'); });
  const bare = queue.reloadQueued();
  // The rename: hooks.saveLabel is an applyChange unit.
  const rename = queue.applyChange(async () => { order.push('rename:write'); });

  try {
    await drain();
    assert.deepEqual(order, ['dash:write'], 'nothing else may start while the dashboard unit holds the queue');
    assert.equal((await disk()).switchThreshold, 0.98);
  } finally {
    g.release();
  }
  const [, mcpResult] = await Promise.all([first, mcp, tuiSave, bare, rename]);
  assert.notEqual(mcpResult.isError, true, mcpResult.content?.[0]?.text);
  assert.deepEqual(order, [
    'dash:write', ...cycle,
    'mcp:write', ...cycle,
    'tui:write',
    ...cycle,
    'rename:write', ...cycle,
  ]);
  assert.equal((await disk()).switchThreshold, 0.7);
});

test('a paused force write holds back an MCP write until its reload finishes', async () => {
  const { queue, order, tools } = await setup();
  const g = gate();
  // saveOverride's shape: queued directly, reloading inside with the unqueued reload.
  const force = queue.queued(async () => {
    order.push('force:write');
    await g.promise;
    order.push('reload:start'); order.push('reload:end');
  });
  await until(() => order.includes('force:write'), 'the force write started');
  const mcp = tools.call('set_threshold', { percent: 80 });
  try {
    await drain();
    assert.deepEqual(order, ['force:write']);
  } finally {
    g.release();
  }
  await Promise.all([force, mcp]);
  assert.deepEqual(order, ['force:write', ...cycle, 'mcp:write', ...cycle]);
});

for (const action of ['save', 'delete']) {
  test(`a TUI route ${action} paused between disk and publication holds back other writes and reloads`, async () => {
    const { queue, order } = await setup();
    const g = gate();
    const file = { routes: [{ name: 'opus', match: ['claude-opus-*'] }] };
    const am = {
      accounts: [{ name: 'a', index: 0 }],
      currentIndex: 0,
      switchThreshold: 0.98,
      setRoutes() { order.push('route:publish'); return []; },
      getRoutes() { return []; },
    };
    const tui = new TUI({
      accountManager: am, config: { proxy: { port: 1 }, routes: [...file.routes] }, sx: null,
      saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
      updateConfig: async updater => {
        await updater(file);
        order.push('route:disk');
        await g.promise;
        return JSON.parse(JSON.stringify(file));
      },
      serialize: queue.queued,
    });
    tui.render = () => {};

    const edit = action === 'save'
      ? tui._routeSave({ name: 'fable', match: 'claude-*', accounts: '', bucket: '', color: '' }, null)
      : tui._routeDelete(0);
    await until(() => order.includes('route:disk'), 'the route reached disk');
    const dash = queue.applyChange(async () => { order.push('dash:write'); });
    const bare = queue.reloadQueued();
    try {
      await drain();
      assert.deepEqual(order, ['route:disk'], 'publication must finish before any other unit starts');
    } finally {
      g.release();
    }
    await Promise.all([edit, dash, bare]);
    assert.deepEqual(order, ['route:disk', 'route:publish', 'dash:write', ...cycle, ...cycle]);
  });
}

test('a failed reload inside applyChange is reload-failed, and the queue keeps working', async () => {
  const { queue, order, failReload } = await setup();
  failReload();
  await assert.rejects(queue.applyChange(async () => { order.push('write'); }), err => {
    assert.equal(/** @type {any} */ (err).code, 'reload-failed');
    assert.match(/** @type {Error} */ (err).message, /bad schedule/);
    return true;
  });
  // A refused write reaches the caller as thrown and reloads nothing.
  await assert.rejects(queue.applyChange(async () => { throw Object.assign(new Error('nope'), { code: 'changed-elsewhere' }); }), { code: 'changed-elsewhere' });
  assert.equal(await queue.applyChange(async () => 'next'), 'next');
  assert.deepEqual(order, ['write', 'reload:start', 'reload:failed', ...cycle]);
});

test('MCP keeps its reload-failed wording through applyChange', async () => {
  const { tools, failReload, disk } = await setup();
  failReload();
  const result = await tools.call('set_threshold', { percent: 60 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /saved to the config file, but the reload failed/);
  assert.equal((await disk()).switchThreshold, 0.6);
});

// No deadlock: a unit waits for every unit queued before it, so a unit that
// queued another and awaited it would never finish. Code inside a unit calls
// the unqueued reload (reloadAccounts) instead. This scans each unit's body in
// the sources for the queued entry points.
test('no code inside a queued unit calls back into the queue', async () => {
  /** Bodies of every call to one of `openers`, found by paren matching. */
  const bodies = (src, openers) => {
    const found = [];
    for (const opener of openers) {
      let at = src.indexOf(opener);
      while (at >= 0) {
        let depth = 0;
        let i = at + opener.length - 1;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) break;
        }
        found.push(src.slice(at, i + 1));
        at = src.indexOf(opener, i);
      }
    }
    return found;
  };
  const read = f => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const forbidden = /reloadQueued\(|hooks\.reload\(|hooks\.applyChange\(|hooks\.persistAccounts\(|\bqueued\(|applyChange\(|this\.saveConfig\(|this\.syncAccounts\(|this\.serialize\(|tools\.call\(/;

  const index = bodies(await read('index.js'), ['queued(', 'applyChange(']);
  assert.ok(index.length >= 4, `expected the queued units in index.js, found ${index.length}`);
  for (const body of index) {
    const inner = body.slice(body.indexOf('(') + 1);
    assert.doesNotMatch(inner, forbidden, `a unit in index.js calls back into the queue:\n${body.slice(0, 200)}`);
  }
  for (const body of bodies(await read('tui.js'), ['this.serialize('])) {
    assert.doesNotMatch(body.slice('this.serialize('.length), forbidden, `a TUI unit calls back into the queue:\n${body.slice(0, 200)}`);
  }
  for (const body of bodies(await read('mcp-tools.js'), ['hooks.applyChange('])) {
    assert.doesNotMatch(body.slice('hooks.applyChange('.length), forbidden, `an MCP unit calls back into the queue:\n${body.slice(0, 200)}`);
  }
});

test('a TUI threshold save queued behind a dashboard write persists the TUI value, not the reloaded one', async () => {
  // The file, the running config and the manager, with a reload that copies
  // the file into the other two the way reloadAccounts does.
  const disk = { switchThreshold: 0.98 };
  const config = { proxy: { port: 1 }, switchThreshold: 0.98 };
  const am = { accounts: [], currentIndex: 0, switchThreshold: 0.98, getRoutes() { return []; } };
  const queue = createControlQueue(async () => {
    config.switchThreshold = disk.switchThreshold;
    am.switchThreshold = disk.switchThreshold;
  });
  const g = gate();
  // Wired like index.js: the edit runs again at the unit's turn, then the write.
  const saveConfig = (_config, reapply) => queue.queued(async () => {
    reapply?.();
    disk.switchThreshold = config.switchThreshold;
  });
  const tui = new TUI({ accountManager: am, config, sx: null, saveConfig, syncAccounts: async () => 0, onQuit: () => {} });
  tui.render = () => {};

  const dash = queue.applyChange(async () => { await g.promise; disk.switchThreshold = 1; });
  const edit = tui._doSetThreshold('90');
  await drain();
  g.release();
  await Promise.all([dash, edit]);
  assert.equal(disk.switchThreshold, 0.9);
  assert.equal(config.switchThreshold, 0.9);
  assert.equal(am.switchThreshold, 0.9);
});

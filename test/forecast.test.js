import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { subscriptionKey, observation, estimateWindow, codexWindows, claudeWindows, HOUR, DAY } from '../src/forecast/observations.js';
import { buildForecast } from '../src/forecast/engine.js';
import { ForecastHistory } from '../src/forecast/history.js';
import { forecastPolicy, ForecastService } from '../src/forecast/service.js';
import { AccountManager } from '../src/account-manager.js';
import { normalizeUsageBucket, normalizeUsagePayload } from '../src/oauth.js';
import { normalizeCodexUsage } from '../src/codex-usage.js';
import { predictions, scorePrediction } from '../src/forecast/evaluation.js';
import { createProxyServer } from '../src/server.js';
import { Prober } from '../src/prober.js';

const now = Date.UTC(2026, 8, 12, 18);
const account = { name: 'one', type: 'oauth', provider: 'anthropic', accountUuid: 'user1', orgUuid: 'org1' };
const key = subscriptionKey(account);
const makeWindows = used => [
  { bucket: 'shared:fiveHour', scope: 'shared', durationMs: 5 * HOUR, utilization: used, resetAt: now + 2 * HOUR, precision: 0.01 },
  { bucket: 'shared:sevenDay', scope: 'shared', durationMs: 7 * DAY, utilization: used, resetAt: now + 2 * DAY, precision: 0.01 },
];
const samples = () => Array.from({ length: 7 }, (_, i) => ({ kind: 'observation', id: `event-${i}`, subscription: key,
  provider: 'anthropic', source: 'probe', collector: 'owner', at: now - (6 - i) * 300_000,
  semantics: 'test-v1', enumeration: true, windows: makeWindows(0.5 + i * 0.02) }));
const policies = () => [{ subscription: key, name: 'one', provider: 'anthropic', disabled: false, status: 'active',
  maxUsage: null, thresholds: { default: 0.98 }, models: [{ model: 'claude-fable-5-1', allowed: true }, { model: 'claude-opus-5', allowed: true }] }];
const build = (records, extra = {}) => buildForecast({ records, policies: policies(), collector: 'owner', now, intervalMs: 300_000, ...extra });

test('subscription identity survives credential and entry changes, never merges organizations by email', () => {
  assert.equal(subscriptionKey({ ...account, accessToken: 'rotated', id: 'another', index: 7 }), key);
  assert.notEqual(subscriptionKey({ ...account, orgUuid: 'other' }), key);
  assert.equal(subscriptionKey({ type: 'oauth', name: 'same', email: 'same@example.test' }), null);
  assert.equal(subscriptionKey({ ...account, upstream: 'https://example.test' }), null);
});

test('every Codex model duration is retained including unsupported durations', () => {
  const w = seconds => ({ used_percent: 30, limit_window_seconds: seconds, reset_at: now / 1000 + 1000 });
  const result = codexWindows({ rate_limit: { primary_window: w(18000) }, additional_rate_limits: [
    { metered_feature: 'astra', rate_limit: { primary_window: w(3600), secondary_window: w(604800) } },
  ] });
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[1].durationMs, HOUR);
  assert.equal(result.windows[2].scope, 'model:astra');
});

test('Claude deduplicates legacy and enumerated family counters; unknown scopes remain unknown', () => {
  const result = claudeWindows({ seven_day_sonnet: { utilization: 20 }, limits: [
    { group: 'weekly', scope: { model: { display_name: 'Sonnet' } }, percent: 21 },
    { group: 'hourly', scope: {}, percent: 22 },
  ] }, normalizeUsageBucket);
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].utilization, 0.21);
  assert.equal(result.windows[1].scope, 'unknown');
});

test('observations contain allowlisted fields and exclude credentials and content', () => {
  const r = observation({ ...account, credential: 'SECRET' }, { forecast: { ...codexWindows({}), windows: makeWindows(0.5) }, prompt: 'PRIVATE' },
    { at: now, collector: 'owner', intervalMs: 300_000, eventId: 'one' });
  assert.ok(r);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});

test('global burn comes only from provider changes, including all machines', () => {
  const result = estimateWindow(samples(), 'shared:fiveHour', now, 300_000);
  assert.equal(result.status, 'Recent-rate scenario');
  assert.ok(Math.abs(result.ratePerHour - 0.24) < 1e-9);
  assert.ok(Math.abs(result.limitAt - (now + 0.38 / 0.24 * HOUR)) < 1);
});

test('resets, corrections, source gaps, clock reversal, plan changes and idle usage break estimation', () => {
  for (const mutate of [
    r => { r.at -= HOUR; },
    r => { r.windows[0].utilization = 0.1; },
    r => { r.windows[0].resetAt += HOUR; },
    r => { r.plan = 'different'; },
  ]) {
    const rows = samples(); mutate(rows.at(-1));
    assert.equal(estimateWindow(rows, 'shared:fiveHour', now, 300_000).ratePerHour, null);
  }
  const idle = samples().map(r => ({ ...r, windows: makeWindows(0.5) }));
  assert.equal(estimateWindow(idle, 'shared:fiveHour', now, 300_000).ratePerHour, null);
  assert.equal(estimateWindow(samples(), 'shared:fiveHour', now + 20 * 60_000, 300_000).status, 'Usage data stale');
  assert.equal(estimateWindow(samples(), 'shared:fiveHour', now + 3 * HOUR, 300_000).status, 'Awaiting reset observation');
});

test('duplicate subscriptions and mirrored polling do not increase rate or count', () => {
  const records = samples();
  const result = build(records.flatMap(r => [r, { ...r, id: `${r.id}-copy`, at: r.at + 1 }]), {
    now: now + 1, policies: [...policies(), { ...policies()[0], name: 'duplicate' }],
  });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.coverage.exclusions[0].reason, 'Duplicate subscription, counted once');
  assert.ok(Math.abs(result.accounts[0].windows[0].ratePerHour - 0.24) < 1e-9);
  assert.equal(result.firstShortfall, null);
});

test('qualitative switching avoids only a confirmed scoped limit and still checks shared limits', () => {
  const records = samples();
  for (const r of records) r.windows.push({ bucket: 'family:fable', scope: 'family:fable', durationMs: 7 * DAY,
    utilization: 1, resetAt: now + DAY, precision: 0.01 });
  const alternatives = [{ from: 'claude-fable-5-1', to: 'claude-opus-5' }];
  const result = build(records, { alternatives });
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].gainMinutes, null);
  records.at(-1).windows[1].utilization = 1;
  assert.equal(build(records, { alternatives }).recommendations.length, 0);
});

test('unknown model scope, disabled account, held route or empty alternatives suppress advice', () => {
  const rows = samples();
  assert.equal(build(rows).recommendations.length, 0);
  const disabled = build(rows, { policies: [{ ...policies()[0], disabled: true }] });
  assert.equal(disabled.perModel[0].eligible, false);
  rows.at(-1).windows.push({ bucket: 'unknown', scope: 'unknown', durationMs: null, utilization: 0.1, resetAt: now + HOUR });
  assert.equal(build(rows).perModel[0].complete, false);
});

test('forecast policy reads do not mutate account manager or routing learners', () => {
  const manager = new AccountManager([{ ...account, accessToken: 'never-send', maxUsage: 0.8 }], 0.98,
    { routes: [{ name: 'opus', match: ['*opus*'], accounts: ['one'] }] });
  manager.setRoutePin('configured:opus', 0, { whenSpent: 'hold' });
  const before = JSON.stringify(manager);
  const p = forecastPolicy(manager, { blockedModels: ['*fable*'] }, ['claude-opus-5', 'claude-fable-5-1']);
  assert.equal(JSON.stringify(manager), before);
  assert.ok(!JSON.stringify(p).includes('never-send'));
  assert.equal(p[0].models[1].allowed, false);
});

test('SQLite history persists, deduplicates and preserves corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-forecast-'));
  let history;
  try {
    const path = join(dir, 'history.sqlite');
    history = new ForecastHistory(path);
    await history.append(samples()[0]);
    await history.append(samples()[0]);
    assert.equal((await history.load(now - DAY)).length, 1);
    await history.close(); history = new ForecastHistory(path);
    assert.equal((await history.load(now - DAY)).length, 1);
    await history.close(); history = null;
    await writeFile(path, 'corrupt database evidence');
    history = new ForecastHistory(path);
    await assert.rejects(history.load(now - DAY));
    assert.equal(await readFile(path, 'utf8'), 'corrupt database evidence');
  } finally { await history?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('storage failure disables estimates without throwing into the probe caller', async () => {
  const history = { load: async () => { throw new Error('disk'); }, close: async () => {} };
  const service = new ForecastService({ manager: { accounts: [] }, config: {}, file: '', history });
  await service.ready;
  assert.equal(service.getSnapshot().status, 'History unavailable');
  assert.doesNotThrow(() => service.observe(account, {}));
  await service.close();
});

test('shared enumeration mirrors do not invent extra constraints; idle family retains observed zero', () => {
  const raw = { five_hour: { utilization: 20, resets_at: now / 1000 + 1800 }, limits: [
    { kind: 'session', group: 'session', percent: 20, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Fable' } }, percent: 0, resets_at: null },
  ] };
  const normalized = claudeWindows(raw, normalizeUsageBucket);
  assert.equal(normalized.windows.length, 2);
  const r = { ...samples()[0], at: now, windows: normalized.windows };
  const window = estimateWindow([r], 'family:fable', now, 300_000);
  assert.equal(window.utilization, 0);
  assert.equal(window.status, 'No active window');
  assert.equal(window.limitAt, null);
});

test('fixed-lead scoring excludes reset crossings, missed outcomes and changed policy', () => {
  const rows = samples();
  const snapshot = build(rows);
  const pending = predictions(snapshot, rows, 300_000);
  assert.ok(pending.length > 0);
  assert.ok(pending.every(p => p.targetAt < p.resetAt));
  const p = pending[0];
  const outcome = { ...rows.at(-1), at: p.targetAt, windows: makeWindows(0.74) };
  assert.equal(scorePrediction(p, outcome, p.policyVersion).eligible, true);
  assert.equal(scorePrediction(p, { ...outcome, at: p.expiresAt + 1 }, p.policyVersion).reason, 'Observation gap');
  assert.equal(scorePrediction(p, outcome, 'changed').eligible, false);
  outcome.windows[0].resetAt += DAY;
  assert.equal(scorePrediction(p, outcome, p.policyVersion).reason, 'Reset boundary');
});

test('only successful probes reach the observer and observer errors do not change probe success', async () => {
  const manager = new AccountManager([{ ...account, accessToken: 'dummy', expiresAt: now + 100 * DAY }]);
  manager.ensureTokenFresh = async () => {};
  let calls = 0;
  let usage = { error: 'timeout' };
  const prober = new Prober(manager, { probeFn: async () => usage, log: () => {}, onObservation: () => { calls++; throw new Error('disk'); } });
  await prober.probeAccount(manager.accounts[0]);
  assert.equal(calls, 0);
  usage = { fiveHour: { utilization: 0.2, resetAt: now + HOUR } };
  await prober.probeAccount(manager.accounts[0]);
  assert.equal(calls, 1);
  assert.equal(prober.getStatus().accounts[0].status, 'ok');
});

test('forecast endpoint is read-only, accepts bounded horizons and keeps cross-origin protection', async t => {
  const manager = new AccountManager([]);
  const server = createProxyServer(manager, { proxy: { apiKey: 'test' } }, { getForecast: hours => ({ version: 1, hours }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/teamclaude/forecast`;
  const r = await fetch(url + '?hours=168');
  assert.deepEqual(await r.json(), { version: 1, hours: 168 });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url + '?hours=169')).status, 400);
  assert.equal((await fetch(url + '?hours=NaN')).status, 400);
  assert.equal((await fetch(url, { headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('bounded account forecast preserves input for 50 subscriptions', t => {
  const records = [];
  const policy = [];
  for (let i = 0; i < 50; i++) {
    const subscription = `subscription-${i}`;
    policy.push({ ...policies()[0], subscription });
    for (let j = 0; j < 400; j++) records.push({ ...samples()[0], subscription, id: `${i}:${j}`,
      at: now - (399 - j) * 300_000, windows: makeWindows(0.1 + j * 0.001) });
  }
  const before = JSON.stringify(records);
  const start = performance.now();
  const result = build(records, { policies: policy });
  t.diagnostic(`50-account recalculation: ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(JSON.stringify(records), before);
  assert.equal(result.accounts.length, 50);
});

test('malformed forecast metadata cannot break existing provider normalization', () => {
  const claude = normalizeUsagePayload({ five_hour: { utilization: 25 }, limits: [
    { group: 'weekly', scope: { model: { display_name: 123 } }, percent: 10 },
  ] });
  assert.equal(claude.fiveHour.utilization, 0.25);
  assert.equal(claude.forecast.windows[1].scope, 'unknown');
  const codex = normalizeCodexUsage({ rate_limit: { primary_window: {
    used_percent: 20, limit_window_seconds: 18000, reset_at: now / 1000,
  } }, additional_rate_limits: {} });
  assert.equal(codex.fiveHour.utilization, 0.2);
});

test('pending evaluation evidence is retained by age but evicted within the disk budget with recorded loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forecast-budget-'));
  const file = join(dir, 'history.sqlite');
  const history = new ForecastHistory(file, { maxBytes: 512 * 1024 });
  try {
    await history.append({ kind: 'outcome', id: 'ancient-pending', at: now - 120 * DAY, pending: true, evidence: 'audit' });
    await history.append({ ...samples()[0], id: 'old-observation', at: now - 40 * DAY });
    await history.append(samples().at(-1));
    await history.compact(now);
    assert.equal((await history.call('scores')).length, 1, 'pending audit evidence does not expire at 90 days');
    assert.equal((await history.call('summaries')).length, 1);
    assert.equal((await history.load(now - 90 * DAY)).length, 1, 'compaction retains the current observation');
    for (let i = 0; i < 40; i++) {
      const prediction = { kind: 'prediction', id: `pred-${i}`, at: now + i, subscription: key, pending: true, evidence: 'x'.repeat(8000) };
      await history.append(prediction);
      await history.call('settle', { record: { kind: 'outcome', id: `large-${i}`, at: now + i,
        subscription: key, pending: true, predictionId: prediction.id, prediction } });
    }
    assert.equal((await history.call('pending')).length, 0);
    const coverage = await history.call('coverage');
    assert.ok(coverage.counts.outcome > 0);
    assert.equal(coverage.evaluationGateDeferred, true);
    assert.ok((await stat(file)).size <= 256 * 1024);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    for (let i = 0; i < 40; i++) await history.append({ kind: 'prediction', id: `unsettled-${i}`, at: now + i,
      subscription: key, pending: true, evidence: 'x'.repeat(8000) });
    assert.ok((await history.call('coverage')).counts.prediction > 0, 'unsettled evidence is also bounded as a last resort');
    await history.append({ kind: 'outcome', id: 'still-writable', at: now + DAY, pending: true });
  } finally { await history.close(); await rm(dir, { recursive: true, force: true }); }
});

test('duration tolerance and per-subscription policy versions avoid unrelated exclusions', () => {
  const rows = samples();
  for (const r of rows) r.windows[0].durationMs += 60_000;
  const first = build(rows);
  assert.ok(first.accounts[0].windows[0].ratePerHour > 0);
  assert.equal(first.perModel[0].complete, true);
  const changed = build(rows, { policies: [...policies(), { ...policies()[0], subscription: 'other', status: 'throttled' }] });
  assert.equal(first.accounts[0].policyVersion, changed.accounts[0].policyVersion);
  assert.notEqual(first.coverage.policyVersion, changed.coverage.policyVersion);
});

test('calculation failures recover without disabling observation collection; stale snapshots suppress model claims', async () => {
  const manager = new AccountManager([{ ...account, accessToken: 'dummy' }]);
  const realThreshold = manager.thresholdFor.bind(manager);
  manager.thresholdFor = () => { throw new Error('calculation'); };
  const saved = [];
  const history = { load: async () => [], call: async op => ['pending', 'scores'].includes(op) ? [] : null,
    append: async r => { saved.push(r); }, compact: async () => {}, close: async () => {} };
  let clock = now;
  const service = new ForecastService({ manager, config: { quotaProbeSeconds: 300, forecast: { models: ['claude-opus-5'] } }, file: '', history, now: () => clock });
  try {
    await service.ready; await new Promise(setImmediate);
    assert.equal(service.calculationError, 'Forecast calculation failed');
    assert.equal(service.error, null);
    service.observe(manager.accounts[0], { forecast: { windows: makeWindows(0.5), enumeration: true, semantics: 'test' } });
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.ok(saved.some(r => r.kind === 'observation'));
    assert.equal(service.error, null);
    manager.thresholdFor = realThreshold;
    service.recompute(); await new Promise(setImmediate);
    assert.equal(service.calculationError, null);
    clock += 61_000;
    assert.equal(service.getSnapshot().status, 'Forecast recalculation stale');
    assert.equal(service.getSnapshot().accounts[0].windows[0].limitAt, null);
    assert.equal(service.getSnapshot().perModel[0].eligible, false);
  } finally { await service.close(); }
});

test('closing history terminates its worker even when readiness never resolves', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forecast-close-'));
  const history = new ForecastHistory(join(dir, 'history.sqlite'));
  try {
    await history.ready;
    history.ready = new Promise(() => {});
    await history.close();
    assert.equal(history.worker.threadId, -1);
  } finally { await history.worker.terminate(); await rm(dir, { recursive: true, force: true }); }
});

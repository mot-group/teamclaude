import { randomUUID } from 'node:crypto';
import { ForecastHistory } from './history.js';
import { buildForecast, evaluationPolicyVersion } from './engine.js';
import { subscriptionKey, observation, HOUR, DAY, hash } from './observations.js';
import { modelGlobMatches } from '../model.js';
import { predictions, scorePrediction } from './evaluation.js';

const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : null;

export function forecastPolicy(manager, config, models) {
  return manager.accounts.slice(0, 100).map(a => ({
    subscription: subscriptionKey(a), name: text(a.name), provider: a.provider || 'anthropic',
    disabled: !!a.disabled, credentialAvailable: !!a.credential && !(a._deadRefreshToken && a._deadRefreshToken === a.refreshToken),
    status: a.status, rateLimitedUntil: a.rateLimitedUntil,
    entitlementDeniedUntil: a.entitlementDeniedUntil, pausedUntil: a.pausedUntil,
    maxUsage: typeof a.maxUsage === 'number' ? a.maxUsage : a.maxUsage ? Object.fromEntries(
      Object.entries(a.maxUsage).filter(([k, v]) => k.length < 120 && Number.isFinite(v))) : null,
    thresholds: Object.fromEntries(['default', 'unified5h', 'unified7d', 'unified7dFable', 'unified7dSonnet']
      .map(key => [key, manager.thresholdFor(key)])),
    models: models.map(model => ({ model,
      allowed: !config.blockedModels?.some(p => modelGlobMatches(p, model)) && manager._routeAllows(a, model),
      bucketOverride: manager._routeForModel(model)?.bucket || null,
    })),
  }));
}

export class ForecastService {
  constructor({ manager, config, file, now = Date.now, history = null }) {
    this.manager = manager;
    this.config = config;
    this.now = now;
    this.collector = 'owner-probe-v1';
    this.boot = randomUUID();
    this.records = [];
    this.predictions = [];
    this.outcomes = [];
    this.error = null;
    this.calculationError = null;
    this.running = false;
    this.closing = false;
    this.history = history || new ForecastHistory(file);
    this.snapshot = this.unavailable('History starting');
    this.ready = this.history.load(this.now() - 30 * DAY).then(async records => {
      this.records = records;
      this.predictions = await this.history.call('pending');
      this.outcomes = await this.history.call('scores');
      this.coverageLoss = await this.history.call('coverage');
      this.recompute();
    }).catch(() => { this.error = 'History unavailable'; this.snapshot = this.unavailable(this.error); });
    this.timer = setInterval(() => this.recompute(), 30_000);
    this.timer.unref?.();
  }

  unavailable(reason) {
    return { version: 1, generatedAt: this.now(), observedThrough: null, horizonEnd: null,
      status: reason, firstShortfall: null, accounts: [], perModel: [], events: [], recommendations: [],
      coverage: { completePool: false, numericModelGains: false, storageError: this.error } };
  }

  observe(account, usage, { at = this.now(), intervalMs = 0, eventId = randomUUID() } = {}) {
    if (this.error || this.closing) return;
    const record = observation(account, usage, { at, intervalMs, collector: this.collector, eventId: `${this.boot}:${eventId}` });
    if (!record) return;
    this.history.append(record).then(async () => {
      await this.ready;
      if (this.error) return;
      this.records.push(record);
      this.records = this.records.filter(r => r.at >= this.now() - 30 * DAY).slice(-20000);
      const models = [...new Set((this.snapshot.perModel || []).map(m => m.model))];
      let policy;
      try { policy = forecastPolicy(this.manager, this.config, models).find(p => p.subscription === record.subscription); }
      catch { this.calculationError = 'Forecast calculation failed'; this.recompute(); return; }
      for (const prediction of [...this.predictions]) {
        const outcome = scorePrediction(prediction, record, policy ? evaluationPolicyVersion(policy) : null);
        if (!outcome) continue;
        this.predictions = this.predictions.filter(p => p.id !== prediction.id);
        await this.history.call('settle', { record: outcome });
        this.outcomes.push(outcome);
      }
      this.outcomes = this.outcomes.slice(-20000);
      this.recompute();
    }).catch(() => { this.error = 'History storage failed'; this.snapshot = this.unavailable(this.error); });
  }

  recompute() {
    if (this.running || this.closing) return;
    this.running = true;
    setImmediate(() => {
      try {
        if (this.error) { this.snapshot = this.unavailable(this.error); return; }
        const alternatives = (Array.isArray(this.config.forecast?.alternatives) ? this.config.forecast.alternatives : [])
          .slice(0, 30).map(a => ({ from: text(a?.from), to: text(a?.to) })).filter(a => a.from && a.to);
        const models = [...new Set([...alternatives.flatMap(a => [a.from, a.to]),
          ...(Array.isArray(this.config.forecast?.models) ? this.config.forecast.models : []).filter(m => typeof m === 'string').map(text)])].slice(0, 60);
        const policies = forecastPolicy(this.manager, this.config, models);
        const modelScopes = Object.fromEntries(Object.entries(this.config.forecast?.modelScopes || {}).slice(0, 60)
          .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [text(k), v.slice(0, 30).map(text).filter(Boolean)]));
        this.snapshot = buildForecast({ records: this.records, policies, collector: this.collector,
          intervalMs: (this.config.quotaProbeSeconds || 0) * 1000, alternatives, modelScopes, now: this.now() });
        this.calculationError = null;
        const eligible = this.outcomes.filter(o => o.eligible);
        const mean = key => {
          const values = eligible.map(o => o[key]).filter(Number.isFinite);
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        this.snapshot.coverage.evaluation = { fixedLeadObservations: eligible.length,
          excludedOutcomes: this.outcomes.length - eligible.length,
          meanAbsoluteError: mean('error'), lastValueError: mean('lastValueError'), linearError: mean('linearError'),
          independentExhaustions: 0, calibrated: false, experimental: true };
        this.snapshot.coverage.historyEvictions = this.coverageLoss || null;
        this.snapshot.coverage.pendingPredictionLimitReached = this.predictionLimitReached || false;
        if (this.manager.accounts.length > 100 || this.records.length >= 20000) {
          this.snapshot.coverage.limitReached = true;
        }
        const period = Math.floor(this.now() / (30 * 60_000));
        if (period !== this.lastPeriod) {
          this.lastPeriod = period;
          const snapshot = this.snapshot;
          this.history.append({ kind: 'forecast', id: hash(['forecast', this.boot, period]), at: snapshot.generatedAt,
            subscription: null, snapshot }).catch(() => { this.error = 'History storage failed'; });
          const pending = predictions(snapshot, this.records, (this.config.quotaProbeSeconds || 0) * 1000);
          this.predictions.push(...pending);
          if (this.predictions.length > 20000) {
            this.predictions = this.predictions.slice(-20000);
            this.predictionLimitReached = true;
            this.snapshot.coverage.pendingPredictionLimitReached = true;
          }
          this.history.call('appendMany', { records: pending }).catch(() => { this.error = 'History storage failed'; });
          this.history.compact(this.now()).then(() => this.history.call('coverage'))
            .then(loss => { this.coverageLoss = loss; }).catch(() => { this.error = 'History storage failed'; });
        }
      } catch {
        this.calculationError = 'Forecast calculation failed';
        this.snapshot = this.unavailable(this.calculationError);
      } finally { this.running = false; }
    });
  }

  getSnapshot(hours = 8) {
    const snapshot = JSON.parse(JSON.stringify(this.snapshot));
    const horizon = Number.isFinite(hours) && hours > 0 && hours <= 168 ? hours : 8;
    snapshot.horizonEnd = snapshot.generatedAt + horizon * HOUR;
    snapshot.scenario = { ...snapshot.scenario, horizonHours: horizon };
    const staleCalculation = this.now() - snapshot.generatedAt > 60_000;
    if (this.error || this.calculationError || staleCalculation || !(this.config.quotaProbeSeconds > 0)) {
      snapshot.status = this.error || this.calculationError || (staleCalculation ? 'Forecast recalculation stale' : 'Global observation coverage unavailable');
      snapshot.recommendations = [];
      for (const m of snapshot.perModel || []) { m.eligible = false; m.reason = snapshot.status; }
      for (const a of snapshot.accounts) for (const m of a.models || []) { m.eligible = false; m.reason = snapshot.status; }
      for (const account of snapshot.accounts) for (const w of account.windows) {
        w.lastEstimate = w.limitAt ? { limitAt: w.limitAt, observedAt: w.observedAt } : w.lastEstimate;
        w.limitAt = null;
        w.ratePerHour = null;
        w.hardCapAt = null;
        w.softThresholdAt = null;
        w.status = 'Usage data stale';
      }
    }
    return snapshot;
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.history.close();
  }
}

import { estimateWindow, HOUR, DAY, hash, windowClass } from './observations.js';
import { modelFamily, resolveMaxUsage } from '../model.js';

export function bucketKey(window) {
  if (window.scope === 'shared') return windowClass(window.durationMs) === 'fiveHour' ? 'unified5h'
    : windowClass(window.durationMs) === 'sevenDay' ? 'unified7d' : window.bucket;
  if (window.scope === 'family:fable') return 'unified7dFable';
  if (window.scope === 'family:sonnet') return 'unified7dSonnet';
  return window.scope?.startsWith('family:') ? `scoped:${window.scope.slice(7)}` : window.bucket;
}

export function evaluationPolicyVersion(policy) {
  return hash([policy.subscription, policy.provider, policy.disabled, policy.credentialAvailable,
    policy.maxUsage, policy.thresholds, policy.models]);
}

function scopedWindows(account, model, modelScopes) {
  const family = modelFamily(model);
  const known = account.provider === 'anthropic' ? family !== 'other' : Array.isArray(modelScopes[model]);
  const windows = account.windows.filter(w => w.scope === 'shared' || w.scope === `family:${family}`
    || w.scope === 'unknown' || (modelScopes[model] || []).some(scope => w.scope === `model:${scope}`));
  const complete = known && account.enumeration && !account.truncated
    && windows.some(w => w.scope === 'shared' && windowClass(w.durationMs) === 'fiveHour')
    && windows.some(w => w.scope === 'shared' && windowClass(w.durationMs) === 'sevenDay')
    && windows.every(w => w.scope !== 'unknown' && windowClass(w.durationMs));
  return { windows, complete };
}

function currentEligibility(account, model, policy, modelScopes, now) {
  const { windows, complete } = scopedWindows(account, model, modelScopes);
  const route = policy.models.find(m => m.model === model);
  const reason = !route || !route.allowed ? 'Model or route blocked'
    : policy.disabled ? 'Account disabled'
      : policy.credentialAvailable === false ? 'Subscription credentials unavailable'
      : policy.status === 'error' ? 'Account error'
        : policy.status === 'exhausted' ? 'Provider refused quota'
          : policy.status === 'throttled' || policy.rateLimitedUntil > now || policy.pausedUntil > now ? 'Temporary throttle'
            : policy.entitlementDeniedUntil > now ? 'Subscription access blocked'
              : route.bucketOverride ? 'Route bucket override needs mapping'
                : !complete ? 'Constraint coverage incomplete'
                  : windows.some(w => ['Usage data stale', 'Awaiting reset observation'].includes(w.status)) ? 'Usage data stale'
                    : windows.some(w => w.observedAt === null || w.utilization === null) ? 'Usage data missing'
                      : windows.some(w => w.utilization >= Math.min(1, resolveMaxUsage(policy.maxUsage, bucketKey(w)) ?? 1)) ? 'Governing quota reached'
                        : null;
  return { model, eligible: !reason, reason, windows: windows.map(w => w.bucket), complete,
    firstConstraint: windows.filter(w => w.limitAt !== null).sort((a, b) => a.limitAt - b.limitAt)[0]?.bucket ?? null };
}

export function buildForecast({ records, policies, intervalMs, collector, alternatives = [], modelScopes = {}, now = Date.now() }) {
  const bySubscription = new Map();
  for (const r of records) {
    if (r.source !== 'probe' || r.collector !== collector || r.at > now || r.at < now - 30 * DAY) continue;
    if (!bySubscription.has(r.subscription)) bySubscription.set(r.subscription, []);
    bySubscription.get(r.subscription).push(r);
  }
  const accounts = [];
  const exclusions = [];
  const seen = new Set();
  for (const policy of policies) {
    if (!policy.subscription) { exclusions.push({ name: policy.name, reason: 'Subscription identity unverified or resource unsupported' }); continue; }
    if (seen.has(policy.subscription)) { exclusions.push({ name: policy.name, reason: 'Duplicate subscription, counted once' }); continue; }
    seen.add(policy.subscription);
    const raw = (bySubscription.get(policy.subscription) || []).sort((a, b) => a.at - b.at);
    const unique = new Map();
    for (const r of raw) unique.set(Math.floor(r.at / Math.max(5 * 60_000, intervalMs)), r);
    const samples = [...unique.values()];
    const last = samples.at(-1);
    const windowIds = last?.windows.map(w => w.bucket) || [];
    const windows = windowIds.map(bucket => {
      const window = estimateWindow(samples, bucket, now, intervalMs);
      const cap = resolveMaxUsage(policy.maxUsage, bucketKey(window));
      const threshold = policy.thresholds[bucketKey(window)] ?? policy.thresholds.default;
      const crossing = limit => window.ratePerHour > 0
        ? window.observedAt + Math.max(0, limit - window.utilization) / window.ratePerHour * HOUR : null;
      return { ...window, hardCap: cap, hardCapAt: cap === null ? null : crossing(cap),
        softThreshold: threshold, softThresholdAt: crossing(threshold),
        resetConditional: true, numericProbability: null };
    });
    const account = { name: policy.name, subscription: policy.subscription, provider: policy.provider,
      disabled: policy.disabled, policyVersion: evaluationPolicyVersion(policy),
      enumeration: last?.enumeration === true, truncated: last?.truncated === true,
      observedAt: last?.at ?? null, windows, models: [],
      continuity: null, continuityReason: 'Account pace does not establish service after workload moves between accounts' };
    account.models = policy.models.map(m => currentEligibility(account, m.model, policy, modelScopes, now));
    const prior = samples.at(-2);
    account.confirmed = !!prior && now - prior.at <= Math.max(intervalMs * 3, 15 * 60_000)
      && prior.semantics === last.semantics && prior.plan === last.plan
      && prior.windows.length === last.windows.length && last.windows.every(w => {
        const old = prior.windows.find(p => p.bucket === w.bucket);
        return old && old.scope === w.scope && old.durationMs === w.durationMs && old.resetAt === w.resetAt;
      });
    account.previousWindows = prior?.windows || [];
    accounts.push(account);
  }
  const recommendations = [];
  for (const alternative of alternatives) {
    for (const account of accounts) {
      const from = account.models.find(m => m.model === alternative.from);
      const to = account.models.find(m => m.model === alternative.to);
      if (!account.confirmed || !from || !to?.eligible || from.eligible || !from.complete) continue;
      const avoided = account.windows.filter(w => from.windows.includes(w.bucket) && !to.windows.includes(w.bucket)
        && w.utilization >= 1 && account.previousWindows.some(p => p.bucket === w.bucket && p.utilization >= 1));
      const policy = policies.find(p => p.subscription === account.subscription);
      const confirmedAvailable = to.windows.every(bucket => account.previousWindows.some(w => w.bucket === bucket
        && w.utilization !== null && w.utilization < Math.min(1, resolveMaxUsage(policy.maxUsage, bucketKey(w)) ?? 1)
        && (w.resetAt > now || w.resetAt === null && w.utilization === 0)));
      if (!avoided.length || !confirmedAvailable) continue;
      recommendations.push({ from: alternative.from, to: alternative.to, account: account.name,
        avoidedConstraints: avoided.map(w => w.bucket), remainingConstraints: to.windows,
        machine: 'This proxy', sessions: 'Selected new or restartable sessions only',
        gainMinutes: null, gainReason: 'Model-specific quota consumption has not been calibrated',
        evidence: 'Constraint eligibility confirmed by two provider probes; simulated option',
        tradeoff: 'Requires your choice. Existing session pins and other machines\' demand remain unchanged.' });
    }
  }
  for (const account of accounts) delete account.previousWindows;
  const observed = accounts.map(a => a.observedAt).filter(Number.isFinite);
  const enabled = intervalMs > 0;
  return { version: 1, algorithm: 'account-pace-v1', generatedAt: now,
    observedThrough: observed.length === accounts.length && observed.length ? Math.min(...observed) : null,
    horizonEnd: now + 8 * HOUR, scenario: { type: 'current-account-pace', horizonHours: 8,
      assumption: 'Each subscription keeps its observed total workload, including other machines' },
    status: !enabled ? 'Global observation coverage unavailable'
      : accounts.some(a => a.windows.some(w => w.ratePerHour !== null)) ? 'Experimental account forecasts' : 'Insufficient history',
    firstShortfall: null, firstShortfallReason: 'Pool continuity needs measured workload transfer and policy replay',
    perModel: accounts.flatMap(a => a.models.map(m => ({ ...m, account: a.name, provider: a.provider }))),
    accounts, recommendations: enabled ? recommendations : [],
    events: accounts.flatMap(a => a.windows.filter(w => w.resetAt > now).map(w => ({ account: a.name,
      bucket: w.bucket, at: w.resetAt, type: 'reported-reset', conditional: true }))),
    coverage: { subscriptionCount: accounts.length, exclusions, source: 'provider-global probes',
      continuousSourceConfigured: enabled, intervalSeconds: intervalMs / 1000, topology: 'This proxy only',
      remoteConsumption: 'Included in provider quota changes; attribution unknown',
      numericModelGains: false, completePool: false, storageError: null,
      adviceReason: alternatives.length ? 'Only confirmed eligible alternatives are suggested' : 'No acceptable alternatives configured',
      evaluation: { windowErrors: null, independentExhaustions: 0, calibrated: false },
      policyVersion: hash(policies), alternativesVersion: hash(alternatives) } };
}

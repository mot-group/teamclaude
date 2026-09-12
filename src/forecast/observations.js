import { createHash } from 'node:crypto';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : null;

export function subscriptionKey(account) {
  const provider = account.provider || 'anthropic';
  if (account.type !== 'oauth' || account.upstream) return null;
  if (provider === 'codex' && account.accountId) return hash([provider, account.accountId]);
  if (provider === 'anthropic' && account.accountUuid && account.orgUuid) {
    return hash([provider, account.accountUuid, account.orgUuid]);
  }
  return null;
}

export function codexWindows(data) {
  const result = [];
  const add = (limit, scope, prefix) => {
    for (const key of ['primary_window', 'secondary_window']) {
      const w = limit?.[key];
      if (!w) continue;
      result.push({ bucket: `${prefix}:${key}`, scope, durationMs: number(w.limit_window_seconds) * 1000 || null,
        utilization: number(w.used_percent) === null ? null : w.used_percent / 100,
        resetAt: number(w.reset_at) > 0 ? w.reset_at * 1000 : null, precision: null });
    }
  };
  add(data?.rate_limit, 'shared', 'shared');
  for (const [i, limit] of (data?.additional_rate_limits || []).entries()) {
    const scope = label(limit?.metered_feature);
    add(limit?.rate_limit, scope ? `model:${scope}` : 'unknown', scope ? `model:${scope}` : `unknown:${i}`);
  }
  return { windows: result, enumeration: !!data?.rate_limit, semantics: 'codex-v1', plan: label(data?.plan_type) };
}

export function claudeWindows(data, normalize) {
  const result = new Map();
  const add = (bucket, scope, durationMs, value) => {
    if (!value) return;
    const w = normalize(value);
    result.set(bucket, { bucket, scope, durationMs, utilization: w?.utilization ?? null,
      resetAt: w?.resetAt ?? null, precision: null });
  };
  add('shared:fiveHour', 'shared', 5 * HOUR, data?.five_hour);
  add('shared:sevenDay', 'shared', 7 * DAY, data?.seven_day);
  for (const [key, value] of Object.entries(data || {})) {
    if (key.startsWith('seven_day_') && value) {
      const family = label(key.slice(10));
      add(`family:${family}`, `family:${family}`, 7 * DAY, value);
    }
  }
  for (const [i, limit] of (Array.isArray(data?.limits) ? data.limits : []).entries()) {
    const sharedKey = limit?.scope == null && limit?.kind === 'session' ? 'shared:fiveHour'
      : limit?.scope == null && limit?.kind === 'weekly_all' ? 'shared:sevenDay' : null;
    if (sharedKey) {
      const existing = result.get(sharedKey);
      const value = normalize({ utilization: limit.percent, resets_at: limit.resets_at });
      if (!existing) add(sharedKey, 'shared', sharedKey.endsWith('fiveHour') ? 5 * HOUR : 7 * DAY,
        { utilization: limit.percent, resets_at: limit.resets_at });
      else if (value.utilization !== existing.utilization || value.resetAt && existing.resetAt && value.resetAt !== existing.resetAt) {
        add(`conflict:${sharedKey}`, 'unknown', null, { utilization: limit.percent, resets_at: limit.resets_at });
      }
      continue;
    }
    const family = label(limit?.scope?.model?.display_name?.trim().toLowerCase());
    const duration = limit?.group === 'weekly' ? 7 * DAY : null;
    const scope = family ? `family:${family}` : 'unknown';
    const key = family && duration ? scope : `unknown:${i}`;
    add(key, scope, duration, { utilization: limit?.percent, resets_at: limit?.resets_at });
  }
  return { windows: [...result.values()], enumeration: Array.isArray(data?.limits), semantics: 'claude-v1', plan: null };
}

export function observation(account, usage, { at, collector, intervalMs, eventId }) {
  const subscription = subscriptionKey(account);
  if (!subscription || !usage?.forecast) return null;
  const windows = usage.forecast.windows.slice(0, 100).map(w => ({
    bucket: label(w.bucket), scope: label(w.scope) || 'unknown', durationMs: number(w.durationMs),
    utilization: number(w.utilization), resetAt: number(w.resetAt), precision: number(w.precision),
  }));
  return { kind: 'observation', id: hash([collector, eventId, subscription]), at, subscription,
    provider: account.provider || 'anthropic', collector, source: 'probe', intervalMs,
    semantics: usage.forecast.semantics, plan: usage.forecast.plan || account.rateLimitTier || null,
    enumeration: usage.forecast.enumeration === true, truncated: usage.forecast.windows.length > 100,
    windows };
}

export function estimateWindow(samples, bucket, now, intervalMs) {
  let segment = [];
  let previous = null;
  for (const sample of samples) {
    const w = sample.windows.find(w => w.bucket === bucket);
    if (!w || w.utilization === null || w.utilization < 0
      || sample.truncated || sample.at > now) { segment = []; previous = null; continue; }
    const point = { ...w, at: sample.at, semantics: sample.semantics, plan: sample.plan };
    if (previous && (point.at <= previous.at || point.at - previous.at > Math.max(intervalMs * 3, 15 * 60_000)
      || point.utilization < previous.utilization || point.resetAt !== previous.resetAt
      || point.durationMs !== previous.durationMs || point.scope !== previous.scope
      || point.semantics !== previous.semantics || point.plan !== previous.plan)) segment = [];
    segment.push(point);
    previous = point;
  }
  const last = segment.at(-1);
  const unavailable = reason => ({ bucket, status: reason, ratePerHour: null, limitAt: null,
    resetAt: last?.resetAt ?? null, observedAt: last?.at ?? null, utilization: last?.utilization ?? null,
    durationMs: last?.durationMs ?? null, scope: last?.scope ?? 'unknown', intervals: Math.max(0, segment.length - 1) });
  if (!last) return unavailable('Insufficient history');
  const maxAge = last.durationMs === 5 * HOUR ? 15 * 60_000 : last.durationMs === 7 * DAY ? HOUR : null;
  if (!maxAge || last.scope === 'unknown') return unavailable('Unsupported window semantics');
  if (last.resetAt !== null && last.resetAt <= now) return unavailable('Awaiting reset observation');
  const baseAge = intervalMs > 0 ? Math.min(3 * intervalMs, maxAge) : maxAge;
  if (now - last.at > baseAge) return unavailable('Usage data stale');
  if (last.resetAt === null) return unavailable(last.utilization === 0 ? 'No active window' : 'Reset time unknown');
  if (last.utilization >= 1) return { ...unavailable('Observed limit reached'), limitAt: last.at };
  if (segment.length < 7 || last.at - segment[0].at < 30 * 60_000) return unavailable('Insufficient history');
  const first = segment[0];
  const deltas = segment.slice(1).map((p, i) => p.utilization - segment[i].utilization).filter(x => x > 1e-9);
  const precision = last.precision || (deltas.length ? Math.min(...deltas) : null);
  if (!precision || last.utilization - first.utilization < 3 * precision - 1e-9) return unavailable('Usage change below measurement resolution');
  const rate = (last.utilization - first.utilization) / ((last.at - first.at) / HOUR);
  if (!(rate > 0)) return unavailable('No measured active demand');
  const ttl = (1 - last.utilization) / rate * HOUR;
  const permittedAge = intervalMs > 0 ? Math.min(baseAge, Math.max(intervalMs, ttl / 4)) : baseAge;
  const limitAt = last.at + ttl;
  const stale = now - last.at > permittedAge;
  return { ...unavailable(stale ? 'Usage data stale' : 'Recent-rate scenario'),
    ratePerHour: stale ? null : rate, limitAt: stale ? null : limitAt,
    lastEstimate: stale ? { limitAt, observedAt: last.at } : null,
    precision, precisionKind: last.precision ? 'reported' : 'empirical',
    conditional: true, exhaustBeforeReset: limitAt < last.resetAt,
    projectionThrough: Math.min(last.resetAt, now + 8 * HOUR) };
}

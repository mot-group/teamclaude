import { HOUR, hash } from './observations.js';

export function predictions(snapshot, records, intervalMs) {
  if (!intervalMs) return [];
  const result = [];
  for (const account of snapshot.accounts) for (const window of account.windows) {
    if (!(window.ratePerHour > 0)) continue;
    const points = [];
    for (const r of records) {
      if (r.subscription !== account.subscription || r.at > window.observedAt || r.at < window.observedAt - HOUR) continue;
      const w = r.windows.find(w => w.bucket === window.bucket);
      const previous = points.at(-1);
      if (!w || w.resetAt !== window.resetAt || w.utilization == null) { points.length = 0; continue; }
      if (previous && (r.at <= previous.at || r.at - previous.at > intervalMs * 3
        || previous.window.utilization > w.utilization || previous.plan !== r.plan || previous.semantics !== r.semantics)) points.length = 0;
      points.push({ at: r.at, window: w, plan: r.plan, semantics: r.semantics });
    }
    const first = points[0];
    const linearRate = first && window.observedAt > first.at
      ? (window.utilization - first.window.utilization) / ((window.observedAt - first.at) / HOUR) : null;
    for (const leadMs of [HOUR / 2, 2 * HOUR, 8 * HOUR]) {
      const targetAt = snapshot.generatedAt + leadMs;
      if (targetAt >= window.resetAt) continue;
      const elapsed = (targetAt - window.observedAt) / HOUR;
      result.push({ kind: 'prediction', pending: true, id: hash([snapshot.generatedAt, account.subscription, window.bucket, leadMs]),
        at: snapshot.generatedAt, subscription: account.subscription, bucket: window.bucket, targetAt,
        expiresAt: targetAt + intervalMs, resetAt: window.resetAt, observedAt: window.observedAt,
        leadMs, precision: window.precision, precisionKind: window.precisionKind,
        prediction: Math.min(1, window.utilization + window.ratePerHour * elapsed),
        baselineLastValue: window.utilization,
        baselineLinear: linearRate > 0 ? Math.min(1, window.utilization + linearRate * elapsed) : null,
        plan: points.at(-1)?.plan ?? null, semantics: points.at(-1)?.semantics ?? null,
        policyVersion: snapshot.coverage.policyVersion, algorithm: snapshot.algorithm });
    }
  }
  return result;
}

export function scorePrediction(prediction, record, policyVersion) {
  if (record.subscription !== prediction.subscription || record.at <= prediction.at) return null;
  const w = record.windows.find(w => w.bucket === prediction.bucket);
  const changed = policyVersion !== prediction.policyVersion ? 'Policy changed'
    : (record.plan ?? null) !== prediction.plan || (record.semantics ?? null) !== prediction.semantics ? 'Calibration segment changed'
      : !w || w.utilization == null ? 'Missing outcome'
        : w.resetAt !== prediction.resetAt || w.resetAt <= record.at ? 'Reset boundary'
          : w.utilization < prediction.baselineLastValue ? 'Provider correction'
            : null;
  if (!changed && record.at < prediction.targetAt) return null;
  const reason = record.at > prediction.expiresAt ? 'Observation gap'
    : changed;
  return { kind: 'outcome', pending: true, id: hash(['outcome', prediction.id]), at: record.at,
    subscription: prediction.subscription, predictionId: prediction.id, prediction,
    eligible: !reason, reason, observationAt: record.at, observedUtilization: w?.utilization ?? null,
    error: reason ? null : Math.abs(prediction.prediction - w.utilization),
    lastValueError: reason ? null : Math.abs(prediction.baselineLastValue - w.utilization),
    linearError: reason || prediction.baselineLinear === null ? null : Math.abs(prediction.baselineLinear - w.utilization),
    cluster: hash([prediction.subscription, prediction.resetAt]),
    note: 'Correlated fixed-lead utilization observation; no exhaustion or calibration claim' };
}

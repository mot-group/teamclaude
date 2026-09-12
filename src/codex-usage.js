import { codexWindows } from './forecast/observations.js';
import { proxyFetch } from './upstream-fetch.js';
import { safeLine } from './safe-text.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function windows(rateLimit) {
  const result = {};
  if (rateLimit == null) return result;
  if (typeof rateLimit !== 'object' || Array.isArray(rateLimit)
    || !['primary_window', 'secondary_window'].some(key => Object.hasOwn(rateLimit, key))) throw new Error('Invalid Codex rate limit');
  for (const name of ['primary_window', 'secondary_window']) {
    const window = rateLimit[name];
    if (window == null) continue;
    const { used_percent: used, limit_window_seconds: seconds, reset_at: reset } = window;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0
      || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0
      || typeof reset !== 'number' || !Number.isFinite(reset) || reset < 0) throw new Error('Invalid Codex quota window');
    const key = Math.abs(seconds - 18000) <= 1800 ? 'fiveHour'
      : Math.abs(seconds - 604800) <= 60480 ? 'sevenDay' : null;
    if (key) result[key] = { utilization: used / 100, resetAt: reset > 0 ? reset * 1000 : null };
  }
  return result;
}

export function normalizeCodexUsage(data) {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'rate_limit')) throw new Error('Missing Codex rate limit');
  const result = { fiveHour: null, sevenDay: null, ...windows(data.rate_limit), forecast: codexWindows(data) };
  if (typeof data.plan_type === 'string') result.planType = safeLine(data.plan_type, 64);
  if (Array.isArray(data.additional_rate_limits)) {
    result.modelBuckets = data.additional_rate_limits.map(limit => {
      if (!limit || typeof limit.metered_feature !== 'string') throw new Error('Invalid Codex model limit');
      const weekly = windows(limit.rate_limit).sevenDay;
      return weekly ? { slug: safeLine(limit.metered_feature, 64), name: safeLine(limit.limit_name || limit.metered_feature, 64), ...weekly } : null;
    }).filter(bucket => bucket?.slug);
  }
  return result;
}

export async function fetchCodexUsage(account, { timeoutMs = 10000, fetchFn = proxyFetch } = {}) {
  if (account?.provider !== 'codex' || account.type !== 'oauth' || account.upstream || !account.credential || !account.accountId) {
    return { error: 'Codex subscription credentials and account ID required', status: null };
  }
  try {
    const response = await fetchFn(USAGE_URL, {
      headers: { authorization: `Bearer ${account.credential}`, 'ChatGPT-Account-Id': account.accountId, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: `Codex usage HTTP ${response.status}`, status: response.status };
    }
    return normalizeCodexUsage(await response.json());
  } catch (err) {
    return { error: err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Codex usage timed out' : 'Could not read Codex usage', status: null };
  }
}

export function normalizeResetCredits(data) {
  if (!data || !Array.isArray(data.credits) || !Number.isSafeInteger(data.available_count) || data.available_count < 0) throw new Error('Invalid reset credits');
  return {
    availableCount: data.available_count,
    credits: data.credits.map(credit => {
      if (!credit || typeof credit.id !== 'string' || !credit.id || typeof credit.status !== 'string' || typeof credit.reset_type !== 'string') throw new Error('Invalid reset credit');
      const expiresAt = credit.expires_at == null ? null : Date.parse(credit.expires_at);
      const grantedAt = credit.granted_at == null ? null : Date.parse(credit.granted_at);
      if ((expiresAt !== null && !Number.isFinite(expiresAt)) || (grantedAt !== null && !Number.isFinite(grantedAt))) throw new Error('Invalid reset credit timestamp');
      return { id: safeLine(credit.id, 200), status: safeLine(credit.status, 40), resetType: safeLine(credit.reset_type, 80),
        title: typeof credit.title === 'string' ? safeLine(credit.title, 120) : null, grantedAt, expiresAt };
    }),
  };
}

export async function fetchCodexResetCredits(account, { timeoutMs = 10000, fetchFn = proxyFetch } = {}) {
  if (account?.provider !== 'codex' || account.type !== 'oauth' || account.upstream || !account.credential || !account.accountId) {
    return { error: 'Codex subscription credentials and account ID required', status: null };
  }
  try {
    const response = await fetchFn('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
      headers: { authorization: `Bearer ${account.credential}`, 'ChatGPT-Account-Id': account.accountId, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: `Codex reset credits HTTP ${response.status}`, status: response.status };
    }
    return normalizeResetCredits(await response.json());
  } catch {
    return { error: 'Could not read Codex reset credits', status: null };
  }
}

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeLine } from './safe-text.js';

const MIN_DROP = 0.20;
const LOW_USAGE = 0.10;
const TIME_TOLERANCE = 60_000;
const DAY = 86400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const labels = { fiveHour: '5-hour', sevenDay: 'Weekly', sevenDaySonnet: 'Sonnet weekly', sevenDayFable: 'Fable weekly' };
const typeLabel = type => type === 'restarted-window' ? 'Restarted window' : 'Quota refill';
const percent = value => `${Math.round(value * 100)}%`;
const date = value => new Date(value).toISOString();

function identity(account) {
  return hash(JSON.stringify([account.provider || 'anthropic', account.accountId || account.accountUuid || account.id || account.name, account.orgUuid || null]));
}

function readings(usage, at) {
  const result = {};
  const entries = Object.entries(labels).map(([key, label]) => [key, label, usage[key]]);
  for (const [family, bucket] of Object.entries(usage.scopedWeekly || {})) {
    if (family !== 'sonnet' && family !== 'fable') entries.push([`family:${family}`, `${family} weekly`, bucket]);
  }
  for (const bucket of usage.modelBuckets || []) entries.push([`model:${bucket.slug}`, bucket.name, bucket]);
  for (const [key, label, bucket] of entries) {
    // A reset time already behind `at` is the window that just ended, still
    // being echoed; it is not a reading of a live window.
    if (!bucket || !Number.isFinite(bucket.utilization) || bucket.utilization < 0
      || !Number.isFinite(bucket.resetAt) || bucket.resetAt <= at) continue;
    result[key] = { label: safeLine(label, 80), utilization: bucket.utilization, resetAt: bucket.resetAt, at };
  }
  return result;
}

export function classifyReset(before, after, maxGapMs) {
  if (after.resetAt <= after.at || !before || after.at <= before.at) return null;
  const advanced = after.resetAt > before.resetAt + TIME_TOLERANCE;
  const same = Math.abs(after.resetAt - before.resetAt) <= TIME_TOLERANCE;
  if (!advanced && !same) return null;
  // A scheduled roll is dated by the window's own reset time, not by when the
  // probes happened to land, so the observation gap does not limit it: an idle
  // account can sit for hours between a window ending and the next one starting.
  if (advanced && before.at < before.resetAt && after.at >= before.resetAt - TIME_TOLERANCE) {
    return { type: 'restarted-window', timing: 'scheduled', before, after };
  }
  if (after.at - before.at > maxGapMs) return null;
  if (before.utilization - after.utilization < MIN_DROP - 1e-9 || after.utilization > LOW_USAGE) return null;
  return { type: advanced ? 'restarted-window' : 'quota-refill',
    timing: after.at < before.resetAt - TIME_TOLERANCE ? 'early' : 'uncertain', before, after };
}

export class ResetTracker {
  constructor({ stateFile = null, webhook = '', dashboardUrl = '', fetchFn = fetch, now = Date.now } = {}) {
    this.stateFile = stateFile;
    this.webhook = webhook;
    this.dashboardUrl = dashboardUrl;
    this.fetchFn = fetchFn;
    this.now = now;
    this.error = null;
    this.sending = false;
    this.state = { version: 1, accounts: {}, events: [], outbox: [], startedAt: now() };
    if (webhook) {
      const url = new URL(webhook);
      if (url.protocol !== 'https:' || url.hostname !== 'chat.googleapis.com' || url.port
        || url.username || url.password || !/^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname)
        || !url.searchParams.get('key') || !url.searchParams.get('token')) throw new Error('Invalid Google Chat webhook configuration');
    }
    if (stateFile) {
      try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (saved.version !== 1 || !saved.accounts || !Array.isArray(saved.events) || !Array.isArray(saved.outbox)) throw new Error('Invalid reset history');
        this.state = saved;
      } catch (err) {
        if (err.code !== 'ENOENT') throw new Error('Cannot read reset history; preserve the file before recovery');
      }
    }
  }

  save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  observe(account, usage, { at = this.now(), maxGapMs = 15 * 60_000 } = {}) {
    if (!usage || usage.error) return;
    const id = identity(account);
    const previous = this.state.accounts[id];
    if (previous && at <= previous.lastObservedAt) return;
    const current = readings(usage, at);
    const row = previous || { windows: {}, pending: {}, totals: { early: 0, scheduled: 0, uncertain: 0 }, earlyTypes: { 'restarted-window': 0, 'quota-refill': 0 }, creditNotices: [] };
    row.name = safeLine(account.name, 100);
    row.provider = account.provider || 'anthropic';
    // A window that ended on schedule since it was last read reports no live
    // window (or echoes the past reset time) until the account is used again.
    // Hold the last pre-expiry reading so the next fresh window still has a
    // `before` to roll over from; otherwise every idle rollover goes uncounted.
    for (const [key, before] of Object.entries(row.windows)) {
      if (!current[key] && before.at < before.resetAt && before.resetAt <= at) current[key] = before;
    }
    const confirmed = [];
    const pending = {};
    for (const [key, after] of Object.entries(current)) {
      const candidate = row.pending[key];
      if (candidate && after.at > candidate.after.at && after.at - candidate.after.at <= maxGapMs
        && Math.abs(after.resetAt - candidate.after.resetAt) <= TIME_TOLERANCE
        && after.utilization >= candidate.after.utilization - 0.01
        && after.utilization <= Math.min(candidate.before.utilization - MIN_DROP, candidate.after.utilization + LOW_USAGE)) {
        confirmed.push({ key, ...candidate });
        continue;
      }
      const event = classifyReset(row.windows[key], after, maxGapMs);
      if (event?.timing === 'scheduled') confirmed.push({ key, ...event });
      else if (event) pending[key] = event;
    }
    row.windows = current;
    row.pending = pending;
    row.lastObservedAt = at;
    this.state.accounts[id] = row;
    const groups = new Map();
    for (const window of confirmed) {
      const group = `${window.timing}:${window.before.at}:${window.after.at}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(window);
    }
    for (const windows of groups.values()) {
      const timing = windows[0].timing;
      const event = { id: hash(JSON.stringify([id, windows])), account: row.name, provider: row.provider, timing, confirmedAt: at, windows };
      row.totals[timing]++;
      if (timing === 'early') for (const type of new Set(windows.map(window => window.type))) row.earlyTypes[type]++;
      this.state.events.unshift(event);
      if (timing === 'early') this.enqueue(event.id, this.resetMessage(event));
    }
    this.state.events = this.state.events.slice(0, 500);
    this.save();
  }

  observeCredits(account, inventory, at = this.now()) {
    const row = this.state.accounts[identity(account)];
    if (!row) return;
    if (!inventory || inventory.error) {
      row.creditError = inventory?.error || 'Reset credit inventory unavailable';
      this.save();
      return;
    }
    const before = row.credits;
    row.credits = { ...inventory, observedAt: at };
    row.creditError = null;
    const notices = new Set(row.creditNotices);
    const available = inventory.credits.filter(c => c.status === 'available' && (!c.expiresAt || c.expiresAt > at));
    for (const credit of available) {
      const newlyAvailable = before && !before.credits.some(c => c.id === credit.id && c.status === 'available');
      const expiresSoon = credit.expiresAt && credit.expiresAt - at <= DAY;
      for (const kind of [...(newlyAvailable ? ['available'] : []), ...(expiresSoon ? ['expiry'] : [])]) {
        const key = `${credit.id}:${kind}:${credit.expiresAt}`;
        if (notices.has(key)) continue;
        notices.add(key);
        this.enqueue(hash(`${identity(account)}:${key}`), `${row.name}: banked reset ${kind === 'expiry' ? 'expires within 24 hours' : 'available'}. ${credit.title || credit.resetType}.${credit.expiresAt ? ` Expires ${date(credit.expiresAt)}.` : ''}`);
      }
    }
    if (before && inventory.availableCount > before.availableCount && !available.some(c => !before.credits.some(old => old.id === c.id && old.status === 'available'))) {
      this.enqueue(hash(`${identity(account)}:count:${at}`), `${row.name}: banked resets increased from ${before.availableCount} to ${inventory.availableCount}.`);
    }
    row.creditNotices = [...notices].slice(-1000);
    this.save();
  }

  resetMessage(event) {
    return `${event.account}: early reset detected.\n` + event.windows.map(w =>
      `${w.after.label}: ${typeLabel(w.type)}, ${percent(w.before.utilization)} to ${percent(w.after.utilization)}. Observed between ${date(w.before.at)} and ${date(w.after.at)}. Reset time: ${date(w.before.resetAt)} to ${date(w.after.resetAt)}.`).join('\n');
  }

  enqueue(id, text) {
    if (!this.webhook || this.state.outbox.some(item => item.id === id)) return;
    this.state.outbox.push({ id, text: text.slice(0, 6000) + (this.dashboardUrl ? `\n${this.dashboardUrl}` : ''), attempts: 0, nextAttemptAt: 0 });
    this.state.outbox = this.state.outbox.slice(-500);
  }

  async flush() {
    if (this.sending || !this.webhook) return;
    this.sending = true;
    try {
      this.save();
      for (const item of [...this.state.outbox]) {
        if (item.nextAttemptAt > this.now()) continue;
        try {
          const url = new URL(this.webhook);
          url.searchParams.set('messageId', `client-tc-${item.id.slice(0, 48)}`);
          const response = await this.fetchFn(url.toString(), { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: item.text }), signal: AbortSignal.timeout(10_000) });
          await response.body?.cancel();
          if (!response.ok && response.status !== 409) throw new Error('Chat delivery failed');
          this.state.outbox = this.state.outbox.filter(entry => entry.id !== item.id);
          this.state.lastSentAt = this.now();
          this.state.deliveryError = null;
        } catch {
          item.attempts++;
          item.nextAttemptAt = this.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(item.attempts, 7));
          this.state.deliveryError = 'Google Chat delivery failed; retry queued';
          this.save();
          break;
        }
        this.save();
      }
    } finally { this.sending = false; }
  }

  getStatus(accounts) {
    const ids = new Set(accounts.map(identity));
    const rows = Object.entries(this.state.accounts).filter(([id]) => ids.has(id)).map(([, row]) => ({
      name: row.name, provider: row.provider, windows: row.windows, pending: Object.values(row.pending), totals: row.totals, earlyTypes: row.earlyTypes,
      lastObservedAt: row.lastObservedAt, credits: row.credits || null, creditError: row.creditError || null,
    }));
    return { startedAt: this.state.startedAt, accounts: rows, events: this.state.events,
      notifications: { enabled: !!this.webhook, pending: this.state.outbox.length, lastSentAt: this.state.lastSentAt || null, error: this.state.deliveryError || null }, error: this.error };
  }
}

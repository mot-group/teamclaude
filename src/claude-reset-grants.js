// Claude banked limit resets ("Reset for free" in claude.ai Settings > Usage).
//
// Two sources feed one inventory, the same shape the reset tracker keeps for
// Codex reset credits:
// - `cedar_ember`, the grant list the OAuth usage endpoint returns when asked
//   with `?cedar_ember=1`. The block is gated on the User-Agent, which is why
//   the usage probe sends a Claude Code one (USAGE_USER_AGENT in oauth.js).
//   It is read by the same rules as bankedResets() in oauth.js, which feeds the
//   status line, TUI tag and dashboard badge, so the two cannot disagree.
// - `bankedResets` on the account's config row, entered by the operator from
//   what claude.ai shows, for when the endpoint answers ineligible.

import { safeLine } from './safe-text.js';
import { creditCount } from './codex-usage.js';

/**
 * @typedef {{ id: string, status: string, resetType: string, title: string|null,
 *   grantedAt: number|null, expiresAt: number|null, source: 'oauth'|'manual' }} ClaudeResetCredit
 * @typedef {{ eligible: boolean, reason: string|null, credits: ClaudeResetCredit[] }} ClaudeResetGrants
 */

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value) return null;
  // A bare date is the day claude.ai prints ("Expires Oct 22"). Read it as the
  // start of that day in local time, so an expiry alert fires early, not late.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const local = new Date(year, month, date);
    // The Date constructor rolls 2026-02-30 over to March 2; refuse it instead.
    return local.getFullYear() === year && local.getMonth() === month && local.getDate() === date ? local.getTime() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return typeof value === 'string' && value.trim() ? safeLine(value, max) : null;
}

/**
 * Read the `cedar_ember` section of a usage payload. Null when the payload did
 * not carry one (the request was made without the flag).
 * @param {any} section
 * @returns {ClaudeResetGrants|null}
 */
export function normalizeClaudeResetGrants(section) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const eligible = section.eligible === true;
  // An ineligible block lists nothing, as in bankedResets().
  const grants = eligible && Array.isArray(section.grants) ? section.grants : [];
  /** @type {ClaudeResetCredit[]} */
  const credits = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const grant of grants) {
    if (!grant || typeof grant !== 'object') continue;
    const left = creditCount(grant.resets_left) ?? 0;
    const grantedAt = timestamp(grant.starts_at);
    const expiresAt = timestamp(grant.ends_at);
    const title = text(grant.label, 120);
    // Never the grant id: it is the handle that spends the reset.
    const key = `${grantedAt ?? ''}:${expiresAt ?? ''}`;
    for (let i = 0; i < left && credits.length < 99; i++) {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      credits.push({ id: `oauth:${key}:${n}`, status: 'available', resetType: 'limit reset', title, grantedAt, expiresAt, source: 'oauth' });
    }
  }
  return { eligible, reason: text(section.ineligible_reason, 80), credits };
}

/**
 * Banked resets the operator recorded on the account's config row. Entries
 * without a readable expiry are skipped rather than failing the probe.
 * @param {unknown} entries
 * @returns {ClaudeResetCredit[]}
 */
export function manualResetCredits(entries) {
  if (!Array.isArray(entries)) return [];
  /** @type {ClaudeResetCredit[]} */
  const credits = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const expiresAt = timestamp(entry.expiresAt);
    if (expiresAt === null) continue;
    const title = text(entry.title, 120);
    credits.push({
      id: `manual:${expiresAt}:${title || ''}`,
      status: 'available',
      resetType: text(entry.resetType, 80) || 'limit reset',
      title,
      grantedAt: null,
      expiresAt,
      source: 'manual',
    });
  }
  return credits;
}

/**
 * The inventory the reset tracker stores and alerts on: every available credit
 * from both sources, plus whether Anthropic listed grants to this OAuth token.
 * A response without a `cedar_ember` section says nothing about grants, and an
 * ineligible one after an eligible one is no reading either (as for
 * bankedResets()), so the OAuth half of `previous` carries over rather than
 * being read as "none left", which would announce the same grants as new when
 * they come back. Manual entries count only while Anthropic does not list the
 * grants, or one reset would count twice.
 * @param {ClaudeResetGrants|null|undefined} grants
 * @param {unknown} bankedResets
 * @param {number} [now]
 * @param {{ credits?: ClaudeResetCredit[], oauth?: { eligible: boolean, reason: string|null }|null }|null} [previous]
 */
export function claudeResetInventory(grants, bankedResets, now = Date.now(), previous = null) {
  if (previous?.oauth && (!grants || (!grants.eligible && previous.oauth.eligible))) {
    grants = { ...previous.oauth, credits: (previous.credits || []).filter(c => c.source === 'oauth') };
  }
  const credits = [...(grants?.credits || []), ...(grants?.eligible ? [] : manualResetCredits(bankedResets))];
  const availableCount = credits.filter(c => c.status === 'available' && (c.expiresAt === null || c.expiresAt > now)).length;
  return { availableCount, credits, oauth: grants ? { eligible: grants.eligible, reason: grants.reason } : null };
}

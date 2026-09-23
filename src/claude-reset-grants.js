// Claude banked limit resets ("Reset for free" in claude.ai Settings > Usage).
//
// Two sources feed one inventory, the same shape the reset tracker keeps for
// Codex reset credits:
// - `cedar_ember`, the grant list the OAuth usage endpoint returns when asked
//   with `?cedar_ember=1`. Anthropic currently answers OAuth tokens with
//   `eligible: false, ineligible_reason: "surface"` and no grants, because it
//   lists web-issued grants only to claude.ai sessions. The grant fields are
//   read leniently since none has been seen populated yet.
// - `bankedResets` on the account's config row, entered by the operator from
//   what claude.ai shows.

import { safeLine } from './safe-text.js';

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
  const grants = Array.isArray(section.grants) ? section.grants : [];
  /** @type {ClaudeResetCredit[]} */
  const credits = [];
  for (const grant of grants) {
    if (!grant || typeof grant !== 'object') continue;
    const id = text(grant.id ?? grant.grant_id, 200);
    if (!id) continue;
    credits.push({
      id: `oauth:${id}`,
      status: text(grant.status, 40) || 'available',
      resetType: text(grant.reset_type ?? grant.kind ?? grant.type, 80) || 'limit reset',
      title: text(grant.title ?? grant.display_name ?? grant.description, 120),
      grantedAt: timestamp(grant.granted_at ?? grant.created_at),
      expiresAt: timestamp(grant.expires_at ?? grant.expiry),
      source: 'oauth',
    });
  }
  return { eligible: section.eligible === true, reason: text(section.ineligible_reason, 80), credits };
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
 * A response without a `cedar_ember` section says nothing about grants, so the
 * OAuth half of `previous` carries over rather than being read as "none left",
 * which would announce the same grants as new when the section returns.
 * @param {ClaudeResetGrants|null|undefined} grants
 * @param {unknown} bankedResets
 * @param {number} [now]
 * @param {{ credits?: ClaudeResetCredit[], oauth?: { eligible: boolean, reason: string|null }|null }|null} [previous]
 */
export function claudeResetInventory(grants, bankedResets, now = Date.now(), previous = null) {
  if (!grants && previous?.oauth) {
    grants = { ...previous.oauth, credits: (previous.credits || []).filter(c => c.source === 'oauth') };
  }
  const credits = [...(grants?.credits || []), ...manualResetCredits(bankedResets)];
  const availableCount = credits.filter(c => c.status === 'available' && (c.expiresAt === null || c.expiresAt > now)).length;
  return { availableCount, credits, oauth: grants ? { eligible: grants.eligible, reason: grants.reason } : null };
}

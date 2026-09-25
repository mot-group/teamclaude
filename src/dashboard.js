// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for only when the server
// refuses the page without one (401/403; loopback browsers are exempt), and is
// kept in localStorage; a later refusal (wrong or rotated key) asks again.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT, RESET_CREDIT_MAX_AGE_MS } from './status-renderer.js';

export function renderDashboardHtml({ sessionAuth = false } = {}) {
  return PAGE.replace("var SESSION_AUTH = false;", `var SESSION_AUTH = ${sessionAuth};`);
}

/**
 * Content-Security-Policy for the dashboard, sent by the server with the page.
 *
 * The page holds the proxy key in localStorage, so the policy is the backstop
 * for a script that should never run there: nothing loads from anywhere
 * (`default-src 'none'`), the one inline script is admitted by its hash rather
 * than by `'unsafe-inline'` — the page is static, so the hash is stable — and
 * the only network the script may touch is this origin, for status and switch.
 * Styles need `'unsafe-inline'` because the layout uses `style=` attributes,
 * which hashes do not cover; CSSOM writes (`el.style.width = …`) are not
 * governed by CSP at all. `frame-ancestors 'none'` keeps the page out of
 * another site's iframe, where a click on "switch" could be overlaid.
 */
export function dashboardCsp(html = PAGE) {
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The page's pure logic lives here, not in the script string: these functions
// close over nothing and touch no DOM, so they are serialized into the page
// with toString() below AND exported for the test suite. One implementation,
// tested and served — a test against the string would only be a source grep.

// Model-scoped weekly buckets, one row per family upstream actually metered.
// `scopedWeekly` is learned from the usage payload's `limits` array, so it is
// the complete list when present; the two dedicated fields are the fallback for
// a payload that reported `seven_day_sonnet` without a `limits` array.
export function scopedWeeklyRows(quota) {
  var q = quota || {};
  var scoped = q.scopedWeekly || {};
  var rows = [];
  Object.keys(scoped).forEach(function (family) {
    var b = scoped[family] || {};
    rows.push({ family: family, label: family.charAt(0).toUpperCase() + family.slice(1), utilization: b.utilization, resetAt: b.resetAt });
  });
  [{ family: 'fable', label: 'Fable', u: q.unified7dFable, r: q.unified7dFableReset },
    { family: 'sonnet', label: 'Sonnet', u: q.unified7dSonnet, r: q.unified7dSonnetReset }].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null) return;
    rows.push({ family: f.family, label: f.label, utilization: f.u, resetAt: f.r });
  });
  rows.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  return rows;
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
    + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);
}

/** @param {string|null|undefined} provider */
export function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'anthropic') return 'Claude';
  return provider || 'Unknown';
}

// Provider order everywhere the page lists providers (FR 3): Claude, then
// Codex, then any other key alphabetically, then an account with no provider.
// One comparator so the account table groups and routeRows' default rows
// cannot drift apart.
/** @param {string|null|undefined} a @param {string|null|undefined} b */
export function providerOrder(a, b) {
  var rank = function (p) { return p === 'anthropic' ? 0 : p === 'codex' ? 1 : p ? 2 : 3; };
  var x = rank(a), y = rank(b);
  if (x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Every bucket switchThreshold can be keyed by, plus the short names the
// threshold badge shows them under. Mirrors THRESHOLD_BUCKET_KEYS in model.js
// and THRESHOLD_BUCKET_LABELS in status-renderer.js — duplicated rather than
// imported, because the browser never runs an import. It does not see this
// module's scope either: a helper reaches the page as its own source text, so
// these two are written into the page by SHARED_CONSTS below. Without that the
// first table-form override throws a ReferenceError inside render() and takes
// the accounts pane with it.
export var THRESHOLD_BUCKET_KEYS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'tokens', 'requests'];
/** @type {Object<string, string>} */
export var THRESHOLD_BUCKET_LABELS = {
  unified5h: '5h', unified7d: '7d', unified7dSonnet: 'sonnet', unified7dFable: 'fable',
  tokens: 'tokens', requests: 'requests',
};

// How far below the effective limit a bucket counts as `near` (FR 5): 15
// points, so with the 0.98 default `near` starts at 83%. Written into the
// page by SHARED_CONSTS, like the two tables above.
export var QUOTA_NEAR_BAND = 0.15;

/**
 * The fleet-wide switch threshold for one bucket off the status payload's own
 * two fields — the wire-shape twin of resolveFleetThreshold in model.js
 * (`switchThresholds` entry, else its `default`, else `switchThreshold`, else
 * 0.98). Shared by thresholdBadgeText and effectiveLimit so the badge and the
 * bar grade agree on the number.
 * @param {string} bucket
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {number}
 */
export function fleetFor(bucket, fleetThreshold, fleetThresholds) {
  if (fleetThresholds && typeof fleetThresholds === 'object') {
    var v = fleetThresholds[bucket];
    if (v == null) v = fleetThresholds.default;
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return typeof fleetThreshold === 'number' && isFinite(fleetThreshold) ? fleetThreshold : 0.98;
}

// Ported from model.js (resolveSwitchThreshold / resolveMaxUsage) for the same
// reason THRESHOLD_BUCKET_KEYS is: the browser never runs an import, and the
// page must grade an account exactly the way the router rotates it.
/**
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {string} bucket
 * @param {number} fleetValue
 * @returns {number}
 */
export function resolveSwitchThreshold(accountThreshold, bucket, fleetValue) {
  if (typeof accountThreshold === 'number' && isFinite(accountThreshold)) return accountThreshold;
  if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    var v = accountThreshold[bucket];
    if (v == null) v = accountThreshold.default;
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return fleetValue;
}

/**
 * @param {number|Object<string, number>|null|undefined} maxUsage
 * @param {string} bucket
 * @returns {number|null}  null means uncapped
 */
export function resolveMaxUsage(maxUsage, bucket) {
  if (typeof maxUsage === 'number' && isFinite(maxUsage)) return maxUsage;
  if (maxUsage && typeof maxUsage === 'object') {
    var v = maxUsage[bucket];
    if (v == null) v = maxUsage.default;
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

/**
 * The ratio a bucket's bar is graded against (FR 4): the lower of the switch
 * threshold the router would rotate at and the account's hard maxUsage cap.
 * @param {Record<string, any>|null|undefined} account
 * @param {string} bucket
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {{ limit: number, kind: 'threshold'|'cap', threshold: number, cap: number|null }}
 */
export function effectiveLimit(account, bucket, fleetThreshold, fleetThresholds) {
  var a = account || {};
  var threshold = resolveSwitchThreshold(a.switchThreshold, bucket, fleetFor(bucket, fleetThreshold, fleetThresholds));
  var cap = resolveMaxUsage(a.maxUsage, bucket);
  var capped = cap != null && cap < threshold;
  return { limit: capped ? cap : threshold, kind: capped ? 'cap' : 'threshold', threshold: threshold, cap: cap };
}

/**
 * The four-grade scale (FR 5): `spent` at ratio >= 1, `at` from the limit up,
 * `near` within `band` below the limit, `ok` under that; null for a ratio the
 * account did not report.
 * @param {number|null|undefined} ratio
 * @param {number} limit
 * @param {number} [band]
 * @returns {'ok'|'near'|'at'|'spent'|null}
 */
export function quotaGrade(ratio, limit, band) {
  if (typeof ratio !== 'number' || !isFinite(ratio)) return null;
  if (band == null) band = QUOTA_NEAR_BAND;
  if (ratio >= 1) return 'spent';
  if (ratio >= limit) return 'at';
  if (ratio >= limit - band) return 'near';
  return 'ok';
}

/**
 * "switch at 100%" / "switch 7d 90%, fable 80%" — an account's OWN
 * switchThreshold (issue #409), or '' when it has none or every override it
 * carries merely repeats what the fleet already resolves to. `fleetThreshold`
 * and `fleetThresholds` are the status payload's own top-level fields
 * (`status.switchThreshold` / `status.switchThresholds`), so the comparison
 * uses the exact fleet value the live server is gating on.
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {string}
 */
export function thresholdBadgeText(accountThreshold, fleetThreshold, fleetThresholds) {
  /** @param {string} bucket */
  function fleet(bucket) { return fleetFor(bucket, fleetThreshold, fleetThresholds); }
  /** @param {number} v */
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  /** @param {unknown} v */
  function valid(v) { return typeof v === 'number' && isFinite(v); }
  /** @type {string[]} */
  var parts = [];
  /** @type {Object<string, any>} */
  var table = {};
  /** @type {any} */
  var ownDefault = null;
  if (typeof accountThreshold === 'number') {
    if (!valid(accountThreshold)) return '';
    ownDefault = accountThreshold;
    if (accountThreshold !== fleet('default')) parts.push('at ' + pct(accountThreshold));
  } else if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    table = accountThreshold;
    ownDefault = table.default;
    Object.keys(table).forEach(function (key) {
      var v = table[key];
      if (!valid(v)) return;
      if (key !== 'default' && THRESHOLD_BUCKET_KEYS.indexOf(key) === -1) return;
      if (v !== fleet(key)) parts.push((key === 'default' ? 'at' : (THRESHOLD_BUCKET_LABELS[key] || key)) + ' ' + pct(v));
    });
  }
  // As switchThresholdDiffs in model.js: the account's own default outranks a
  // bucket entry in the FLEET table, so a default equal to the fleet's can
  // still move a bucket the fleet names (fleet 7d at 85%, account 0.98 puts
  // that account's 7d at 98%). When the defaults differ, "at N%" already
  // covers every bucket the account does not list.
  if (valid(ownDefault) && ownDefault === fleet('default')) {
    THRESHOLD_BUCKET_KEYS.forEach(function (key) {
      if (valid(table[key])) return;
      if (ownDefault !== fleet(key)) parts.push(THRESHOLD_BUCKET_LABELS[key] + ' ' + pct(ownDefault));
    });
  }
  return parts.length ? 'switch ' + parts.join(', ') : '';
}

/**
 * "cap 60%" / "cap 7d 60%, fable 50%" — the account's own maxUsage, the hard
 * limit the router refuses at. It is shown on the account row and dialog (FR
 * 25 keeps it off Diagnostics), or '' when the account has none.
 * @param {number|Object<string, number>|null|undefined} maxUsage
 * @returns {string}
 */
export function capBadgeText(maxUsage) {
  /** @param {number} v */
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  if (typeof maxUsage === 'number') return isFinite(maxUsage) ? 'cap ' + pct(maxUsage) : '';
  if (!maxUsage || typeof maxUsage !== 'object' || Array.isArray(maxUsage)) return '';
  var parts = [];
  Object.keys(maxUsage).forEach(function (key) {
    var v = maxUsage[key];
    if (typeof v !== 'number' || !isFinite(v)) return;
    if (key !== 'default' && THRESHOLD_BUCKET_KEYS.indexOf(key) === -1) return;
    parts.push((key === 'default' ? '' : THRESHOLD_BUCKET_LABELS[key] + ' ') + pct(v));
  });
  return parts.length ? 'cap ' + parts.join(', ') : '';
}

/**
 * `now` keeps the fourth slot master's reset-credit callers already use; the
 * fleet threshold pair (#409) follows it.
 * @param {Record<string, any>|null|undefined} account
 * @param {string|null} [current]
 * @param {Record<string, string>|null} [currentAccounts]
 * @param {number|null} [now]  ms epoch a reset-credit reading's age is measured from
 * @param {number|null|undefined} [fleetThreshold]
 * @param {Object<string, number>|null|undefined} [fleetThresholds]
 */
export function accountBadges(account, current, currentAccounts, now, fleetThreshold, fleetThresholds) {
  var a = account || {};
  var isCurrent = currentAccounts
    ? currentAccounts[a.provider] === a.name
    : a.name === current;
  var status = a.disabled ? 'disabled' : (a.status || 'unknown');
  var recent = Number.isFinite(a.sessions) ? a.sessions : 0;
  var known = Number.isFinite(a.knownSessions) ? a.knownSessions : 0;
  var badges = [
    { cls: 'provider ' + (a.provider || 'unknown'), text: providerLabel(a.provider) },
    { cls: 'meta', text: a.type || 'unknown' },
    { cls: 'meta priority', text: 'prio ' + (a.priority || 0) },
  ];
  if (isCurrent) badges.push({ cls: 'current', text: 'current' });
  badges.push({ cls: status, text: status });
  if (recent) badges.push({ cls: 'sessions', text: recent + ' recent' });
  if (known > recent) badges.push({ cls: 'sessions known', text: known + ' known' });
  // Free Codex rate-limit reset credits this account holds — what it could
  // spend to undo an exhausted window rather than wait one out. The count is
  // the account's holdings, not what upstream would apply this instant.
  // A reading past RESET_CREDIT_MAX_AGE_MS is dropped, as it is on the status
  // screen and the TUI row: only the usage probe refreshes the count, so an old
  // one may describe a credit that has since been redeemed or has expired.
  var reading = (a.quota || {}).resetCredits || {};
  var credits = reading.available;
  var stale = Number.isFinite(reading.seenAt) && (now == null ? Date.now() : now) - reading.seenAt > RESET_CREDIT_MAX_AGE_MS;
  if (Number.isFinite(credits) && credits > 0 && !stale) {
    badges.push({ cls: 'meta', text: credits + ' reset credit' + (credits === 1 ? '' : 's') });
  }
  // Arguments 5/6 are optional (the pre-#409 unit test above omits them): with
  // no account switchThreshold at all — the common case — thresholdBadgeText
  // returns '' regardless of what the fleet args are, so an old caller sees no
  // new badge. A caller that DOES set switchThreshold on the account is
  // expected to pass the fleet's own value too, the way `render()` does below,
  // or the comparison falls back to thresholdBadgeText's own 0.98 default.
  var thresholdText = thresholdBadgeText(a.switchThreshold, fleetThreshold, fleetThresholds);
  if (thresholdText) badges.push({ cls: 'meta threshold', text: thresholdText });
  return badges;
}

// One row per conversation, from `sessions.items` (proxy.sessionDetail). A
// Claude Code session that fans out to nine subagents is nine rows, because a
// conversation is what holds a pin and a prompt cache. The visible identity
// keeps the session name and a short conversation digest in separate fields.
// Token columns sum what responses reported across every weekly bucket.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
      session: s.session || s.id || '',
      // Enough of the digest to separate one session's live conversations; the
      // whole of it is a column read to the end by nobody.
      conversation: String(s.conversation || '').slice(0, 8),
      client: s.client || '',
      project: (s.dimensions || {}).project || '',
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0,
      accounts: Object.keys(s.pins || {}).map(function (b) { return s.pins[b]; }).join(', '),
      lastSeen: s.lastSeen || 0,
    };
    Object.keys(buckets).forEach(function (b) {
      var t = buckets[b] || {};
      row.cacheRead += t.cacheRead || 0;
      row.cacheCreation += t.cacheCreation || 0;
      row.input += t.input || 0;
      row.output += t.output || 0;
      row.context += t.context || 0;
    });
    row.total = row.cacheRead + row.cacheCreation + row.input + row.output;
    return row;
  });
}

export function filterSessionRows(rows, filters) {
  var f = filters || {};
  return (rows || []).filter(function (r) {
    if (f.project && r.project !== f.project) return false;
    if (f.client && r.client !== f.client) return false;
    return true;
  });
}

// Text sorts alphabetically, numbers numerically. A missing value sorts as
// empty/zero rather than dropping the row.
export function sortRows(rows, key, dir) {
  var sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    }
    return sign * ((x || 0) - (y || 0));
  });
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) { if (v) seen[v] = true; });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /teamclaude/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/teamclaude/switch',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ account: name }),
    },
  };
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
export function switchOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'Selection failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'Starting account recorded: ' + res.account + '. Rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'Starting account recorded: ' + res.account + '. Normal routing still applies.' };
}

// One row per route the server reports, each model family the fleet meters
// separately, autocreated or configured, plus a trailing default row for each
// provider. Older payloads keep one "Everything else" row. `target` is the server's own answer
// to "where does a request for this family land right now", so the page does
// not re-derive routing from quota bars; the eligible split says why a family
// is where it is.
export function routingCards(status) {
  return ((status || {}).providerRouting || []).map(function (provider) {
    var groups = [];
    (provider.models || []).forEach(function (model) {
      var target = model.target || null;
      var group = groups.filter(function (g) { return g.target === target && g.blocked === !!model.blocked; })[0];
      if (!group) { group = { target: target, blocked: !!model.blocked, labels: [], models: [] }; groups.push(group); }
      if (group.labels.indexOf(model.label) < 0) group.labels.push(model.label);
      group.models.push(model.model);
    });
    var available = groups.filter(function (group) { return group.target; });
    return { provider: provider.provider, label: provider.label, groups: groups,
      headline: groups.length === 1 && available.length === 1 ? available[0].target
        : available.length ? (groups.some(function (group) { return !group.target; }) ? 'Partially available' : 'Multiple targets') : 'Unavailable' };
  });
}

export function routeRows(status) {
  var s = status || {};
  var rows;
  if (Array.isArray(s.providerRouting)) {
    rows = (s.routes || []).flatMap(function (route) {
      // `members` is the route's resolved membership: index references already
      // resolved to names, and an unrestricted route resolved to every account,
      // which is the list the endpoint compares against. A preview's accounts
      // are filtered by provider, so they are only the fallback for a server
      // that does not send it. `id`, `override` and `persisted` below default
      // to null for the same reason.
      var members = Array.isArray(route.members) ? route.members
        : (((route.previews || [])[0] || {}).accounts || route.accounts || []);
      return (route.previews || []).map(function (preview) {
        var accounts = preview.accounts || [];
        return { kind: 'route', name: route.name, provider: preview.provider,
          label: (preview.provider === 'codex' ? 'Codex' : 'Claude') + ' / ' + route.name,
          match: preview.label, sampleModel: preview.model,
          target: preview.target || null, pinned: preview.pinned || null,
          pinMismatch: !!preview.pinned && preview.pinned !== preview.target,
          blocked: !!preview.blocked, autocreated: !!route.autocreated,
          id: route.id || null, override: route.override || null, persisted: route.persisted || null,
          globs: route.match || [],
          members: members.map(function (a) { return typeof a === 'string' ? a : (a || {}).name; }),
          accounts: (route.accounts || []).map(function (a) { return typeof a === 'string' ? a : (a || {}).name; }),
          eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
          ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }) };
      });
    });
  } else {
    var blockedModels = s.blockedModels || [];
    rows = (s.routes || []).map(function (r) {
      var accounts = r.accounts || [];
      var name = r.name || '';
      var match = r.match || [];
      var target = r.target || null;
      var pinned = r.pinned || null;
      return {
        kind: 'route',
        name: name,
        provider: r.provider || 'anthropic',
        label: name.charAt(0).toUpperCase() + name.slice(1),
        match: match.join(', '),
        target: target,
        pinned: pinned,
        // A pin the server is not honouring (its account cannot serve the
        // family right now): routing went elsewhere, and the row must say so
        // rather than let "pinned" read as "this is the pin".
        pinMismatch: !!pinned && pinned !== target,
        // The blocklist answers 400 before selection, so a route whose every
        // glob is blocked has a target no request will reach. A literal glob
        // comparison covers the common case; the server's overlap logic is not
        // shipped to the page.
        blocked: match.length > 0 && match.every(function (g) { return blockedModels.indexOf(g) !== -1; }),
        autocreated: !!r.autocreated,
        id: r.id || null, override: r.override || null, persisted: r.persisted || null,
        globs: match,
        members: (Array.isArray(r.members) ? r.members : accounts).map(function (a) { return typeof a === 'string' ? a : (a || {}).name; }),
        accounts: accounts.map(function (a) { return typeof a === 'string' ? a : (a || {}).name; }),
        eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
        ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
      };
    });
  }
  if (rows.length) {
    // The server reports one default per provider. A mixed Claude/Codex fleet
    // has two independent cursors, so collapsing these into one global row is
    // the exact ambiguity this table exists to remove. Older servers retain
    // the original single-row fallback.
    var defaults = s.defaultTargets || null;
    var providers = defaults ? Object.keys(defaults).sort(providerOrder) : [];
    if (!providers.length) providers = [rows[0].provider || 'anthropic'];
    providers.forEach(function (provider) {
      var current = (s.currentAccounts && s.currentAccounts[provider]) || s.currentAccount || null;
      var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
      rows.push({
        kind: 'default', name: '',
        label: defaults ? providerLabel(provider) + ' default' : 'Everything else',
        provider: provider, match: '',
        target: defaults ? defaults[provider] : (s.defaultTarget || current), current: current,
        currentUnavailable: (cur && cur.unavailable) || null,
        pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
      });
    });
  }
  return rows;
}

// The Overview strip (FR 13): one line per routingCards() entry, in
// providerOrder whatever order the server listed them. The headline
// is the card's own, so the strip and the Routing cards cannot disagree; the
// tag says a forced or pinned route sits behind it. `why` carries the default
// row (only when it differs from the headline) and the current account, with
// the outranks / is-blocked wording the routes table used to print on its
// default rows, so dropping those rows loses no sentence.
export function routeStripLines(status) {
  var s = status || {};
  var defaults = {};
  routeRows(s).forEach(function (r) { if (r.kind === 'default') defaults[r.provider] = r; });
  var forced = {};
  (s.routes || []).forEach(function (r) { if (r.override && r.override.account) forced[r.name] = true; });
  return routingCards(s).map(function (card, i) {
    var models = ((s.providerRouting || [])[i] || {}).models || [];
    var def = defaults[card.provider] || null;
    var target = def ? def.target : null;
    var current = (s.currentAccounts && s.currentAccounts[card.provider]) || s.currentAccount || null;
    var why = [];
    if (target && target !== card.headline) why.push({ text: 'Default target: ' + target, warn: false });
    if (current && current === card.headline) why.push({ text: 'Also the current account', warn: false });
    else if (current) {
      // Like the old default row: any default that is not the current account
      // explains itself, even a null one (nothing can serve); only "outranks"
      // needs an account to name.
      var reason = !def || target === current ? ''
        : def.currentUnavailable ? ' · current account ' + current + ' is blocked: ' + (UNAVAILABLE_TEXT[def.currentUnavailable] || def.currentUnavailable)
        : target ? ' · ' + target + ' outranks the current account ' + current : '';
      why.push({ text: 'Current: ' + current + reason, warn: !!reason });
    }
    return {
      provider: card.provider, label: providerLabel(card.provider),
      accounts: (s.accounts || []).filter(function (a) { return a.provider === card.provider; }).length,
      headline: card.headline,
      // One group with a target: the headline names an account, not a summary.
      resolved: card.groups.length === 1 && !!card.groups[0].target,
      tag: models.some(function (m) { return m.route && forced[m.route]; }) ? 'forced'
        : models.some(function (m) { return m.pinned; }) ? 'pinned' : null,
      why: why,
    };
  }).sort(function (a, b) { return providerOrder(a.provider, b.provider); });
}

// The override as one chip after the target. `state` is the server's own
// answer to whether the forced account is actually serving the route, so the
// page never re-derives it from quota bars: `unavailable` means traffic is
// going elsewhere while the force stands, `holding` means requests are being
// refused on purpose, and those two read very differently to an operator.
export function chipFor(row) {
  var r = row || {};
  var o = r.override || null;
  if (!o || !o.account) return null;
  var x = o.account;
  var why = o.reason || 'not available';
  var out;
  if (o.state === 'unavailable') out = { kind: 'warn', text: 'forced to ' + x + ' · ' + x + ' is ' + why + ' · serving from ' + (r.target || 'nothing') };
  else if (o.state === 'holding') out = { kind: 'bad', text: 'held on ' + x + ' · ' + x + ' is ' + why + ' · requests get 429' };
  else if (o.state === 'no-target') out = { kind: 'bad', text: 'forced to ' + x + ' · nothing can serve right now' };
  else out = { kind: 'accent', text: o.whenSpent === 'hold' ? 'forced · held' : 'forced · falls back when spent' };
  // A TUI pin is memory only. Saying so on the chip is the whole difference
  // between "this survives a reload" and "this is gone at the next restart".
  if (o.source === 'tui') out.text += ' · from the TUI, until restart';
  return out;
}

// Which member the Force dialog offers first: the one whose weekly window
// refills soonest, because spending it is what the fleet's own ranking already
// prefers. A member whose reset upstream never reported sorts last rather than
// first, because an unknown reset is not an early one.
export function forceDefaultAccount(row, accounts) {
  var members = ((row || {}).members || []).map(function (m) { return typeof m === 'string' ? m : (m || {}).name; })
    .filter(function (name) { return !!name; });
  var byName = {};
  (accounts || []).forEach(function (a) { if (a && a.name) byName[a.name] = a; });
  var best = null, bestAt = null;
  members.forEach(function (name) {
    var reset = ((byName[name] || {}).quota || {}).unified7dReset;
    var at = typeof reset === 'number' && isFinite(reset) ? reset : null;
    if (best === null) { best = name; bestAt = at; return; }
    if (at !== null && (bestAt === null || at < bestAt)) { best = name; bestAt = at; }
  });
  return best;
}

// The row's definition as the page last saw it. The endpoint compares this
// against a fresh read of the config inside its transaction and answers 409
// when anything moved, so a Force applied to a stale table is refused instead
// of landing on a route that now means something else. Membership goes over as
// the server's resolved `members`, which is what it compares against: the raw
// config list can say "3" or say nothing at all and mean every account.
export function expectedFor(row) {
  var r = row || {};
  var p = r.persisted || null;
  var match = Array.isArray(r.match) ? r.match : (r.globs || []);
  return {
    match: match.slice(),
    accounts: (Array.isArray(r.members) ? r.members : (r.accounts || []))
      .map(function (a) { return typeof a === 'string' ? a : (a || {}).name; })
      .filter(function (name) { return !!name; }),
    persisted: p ? { account: p.account, whenSpent: p.whenSpent } : null,
  };
}

// The request the Force dialog sends. Pure, like switchRequest, so the test
// suite can put exactly this through a real proxy.
export function overrideRequest(payload, key) {
  return {
    url: '/teamclaude/routes/override',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    },
  };
}

// What to tell the operator afterwards. The endpoint reports writing the config
// and applying it to the running router separately, and the difference matters:
// `persisted` without `applied` means the next reload will pick the override up
// while the live fleet is still routing the old way.
export function overrideOutcome(res) {
  var r = res || {};
  if (r.ok) {
    var o = (r.row || {}).override || null;
    var text = o && o.account
      ? 'Forced to ' + o.account + (o.whenSpent === 'hold' ? ', held on it.' : ', falling back when it is spent.')
      : 'Force cleared. Normal routing applies.';
    var warnings = (r.warnings || []).join(' ');
    if (r.applied === false) return { kind: 'warn', row: r.row || null, text: text + ' Saved, but the router did not reload; see the proxy log.' };
    return { kind: 'ok', row: r.row || null, text: warnings ? text + ' ' + warnings : text };
  }
  if (r.error === 'changed elsewhere') {
    return { kind: 'warn', conflict: true, row: r.row || null, text: 'This route changed elsewhere, so nothing was applied.' };
  }
  var detail = (r.errors || []).map(function (e) { return e.message; }).join('; ') || r.error || 'no reason given';
  if (r.persisted === true) return { kind: 'warn', row: r.row || null, text: 'Saved to the config, but not applied: ' + detail };
  return { kind: 'error', row: null, text: 'Nothing changed: ' + detail };
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// conversation starves at once — and one fan-out is a dozen of them under one
// session's name. Naming all of them would bury the dashboard at the moment it
// matters most; the count carries the scale, three names carry enough to go and
// ask someone.
export var STARVED_LIST_MAX = 3;

/**
 * What is wrong right now, worst first, or an empty list. Only states that are
 * actionable and not ordinary operation: a spent weekly bucket, a rate-limit
 * back-off and an upstream refusal are rotation and back-off working, and
 * saying so every day would teach the reader to ignore the banner on the day it
 * matters.
 */
export function problems(status) {
  var s = status || {};
  var out = [];

  // Named when proxy.sessionDetail is on; otherwise the aggregate still says
  // that something is starving, which is the half that must not be opt-in.
  // When nothing can serve, every session starves and "it is failing" sends the
  // operator hunting for a broken token. Say which, if the fleet agrees on why.
  var accounts = s.accounts || [];
  var stalled = accounts.filter(function (a) { return a.unavailable === 'quota' || a.unavailable === 'throttled'; });
  var reasons = {};
  stalled.forEach(function (a) { reasons[a.unavailable] = true; });
  var why = accounts.length && stalled.length === accounts.length
    ? ' — every account is ' + (reasons.quota && reasons.throttled ? 'over its quota threshold or in a rate-limit hold'
      : reasons.quota ? 'over its quota threshold' : 'in a rate-limit hold') + '.'
    : ' — it is failing, not idle.';

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : []).filter(function (r) {
    return r.active && r.starved >= STARVED_MIN;
  }).sort(function (a, b) { return b.starved - a.starved; });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // The session first, since that is the name an operator can go and find,
      // and the conversation after it, because a streak belongs to one agent of
      // a fan-out: without it three lines of one session read as the same line
      // three times. Omitted when the record carries no conversation.
      text: (r.client ? r.client + "'s session " : 'Session ') + r.session.slice(0, 8)
        + (r.conversation ? ', conversation ' + r.conversation + ',' : '')
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more conversations are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // A conversation, not a session: the streak is counted per conversation,
      // and a session whose other agents are answering fine is not starving.
      text: 'A conversation has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
        + ' Turn on proxy.sessionDetail to see which.',
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // five-minute cooldown and `upstream-rejected` is upstream's way of saying a
  // shared bucket is spent — both expire on their own, like `quota` and
  // `throttled`, and none of them wants a person.
  var ATTENTION = { error: 'needs a re-login', disabled: 'is disabled' };
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    // provider and account let the banner tint the line and lead with the
    // provider word (FR 1); the text itself stays provider-neutral.
    if (why) out.push({ severity: 'warn', kind: 'account', provider: a.provider || null, account: a.name, text: 'Account ' + a.name + ' ' + why + '.' });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `teamclaude status` both carry it, with the amount.

  return out;
}

export function quotaDisplay(ratio, mode = 'spent') {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  var spent = Math.max(0, Math.min(1, ratio));
  // Reserve full exhaustion for a fully spent limit, and keep the two views complementary.
  var percentage = spent === 1 ? 100 : Math.min(99, Math.round(spent * 100));
  return mode === 'left' ? 100 - percentage : percentage;
}

export function accountQuotaGroups(account = {}) {
  var q = account.quota || {};
  var shared = [];
  if (q.unified7d != null) shared.push({ label: 'Weekly', ratio: q.unified7d, resetAt: q.unified7dReset, bucket: 'unified7d' });
  if (q.tokensLimit != null) shared.push({ label: 'Tokens', ratio: q.tokensLimit > 0 && q.tokensRemaining != null ? 1 - q.tokensRemaining / q.tokensLimit : null, resetAt: q.resetsAt, bucket: 'tokens' });
  // The router gates on `requests` too (capExceeded / maxUtilization in
  // account-manager.js, same 1 - remaining / limit ratio), so it is a row and a
  // binding-limit candidate. Appended after Tokens so existing rows keep their order.
  if (q.requestsLimit != null) shared.push({ label: 'Requests', ratio: q.requestsLimit > 0 && q.requestsRemaining != null ? 1 - q.requestsRemaining / q.requestsLimit : null, resetAt: q.resetsAt, bucket: 'requests' });
  var session = q.unified5h == null ? [] : [{ label: '5-hour', ratio: q.unified5h, resetAt: q.unified5hReset, bucket: 'unified5h' }];
  // `bucket` is the switchThreshold/maxUsage key the row grades against; a
  // family the router has no key for (Codex per-model) carries null.
  var models = scopedWeeklyRows(q).map(function (row) {
    var key = 'unified7d' + row.family.charAt(0).toUpperCase() + row.family.slice(1);
    return { label: row.label + ' weekly', ratio: row.utilization, resetAt: row.resetAt, bucket: THRESHOLD_BUCKET_KEYS.indexOf(key) === -1 ? null : key };
  });
  Object.keys(q.codexModelBuckets || {}).forEach(function (slug) {
    var bucket = q.codexModelBuckets[slug];
    models.push({ label: (bucket.name || slug) + ' weekly', ratio: bucket.utilization, resetAt: bucket.resetAt, bucket: null });
  });
  return { shared: shared, session: session, models: models };
}

/**
 * The one bucket that gates this account's routing soonest (FR 9, 10): of the
 * THRESHOLD_BUCKET_KEYS buckets the account reports a finite ratio for, the
 * least headroom (effective limit minus spent ratio); ties go to the earlier
 * key. Per-model rows (`bucket: null`) never bind. Null when nothing gates.
 * @param {Record<string, any>|null|undefined} account
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {{ bucket: string, label: string, ratio: number, limit: number, limitKind: 'threshold'|'cap', headroom: number, grade: 'ok'|'near'|'at'|'spent'|null, resetAt: any }|null}
 */
export function bindingLimit(account, fleetThreshold, fleetThresholds) {
  var groups = accountQuotaGroups(account || {});
  var best = null;
  groups.shared.concat(groups.session, groups.models).forEach(function (row) {
    var order = row.bucket ? THRESHOLD_BUCKET_KEYS.indexOf(row.bucket) : -1;
    if (order === -1 || typeof row.ratio !== 'number' || !isFinite(row.ratio)) return;
    var lim = effectiveLimit(account, row.bucket, fleetThreshold, fleetThresholds);
    var headroom = lim.limit - row.ratio;
    if (best && (headroom > best.headroom || (headroom === best.headroom && order > THRESHOLD_BUCKET_KEYS.indexOf(best.bucket)))) return;
    best = {
      bucket: row.bucket, label: row.label, ratio: row.ratio, limit: lim.limit, limitKind: lim.kind,
      headroom: headroom, grade: quotaGrade(row.ratio, lim.limit, QUOTA_NEAR_BAND), resetAt: row.resetAt,
    };
  });
  return best;
}

// The reset tracker names its watched windows by limit; the grading helpers
// name them by status bucket. This maps one onto the other so a Resets-view
// mini bar grades exactly like the account bar for the same limit (FR 21).
// A window missing here grades against the account's default limit.
export var RESET_WINDOW_BUCKETS = { sevenDay: 'unified7d', fiveHour: 'unified5h', sevenDayFable: 'unified7dFable', sevenDaySonnet: 'unified7dSonnet' };

// One table row per reset-event window for the Resets view, newest first
// (RT 2), so the page can cap the table at its head. `when` is the
// moment the reader cares about: a scheduled roll is the window's own reset
// time, while an early or unclear reset is only known to lie between two
// probes, so the probe that confirmed it dates it. A row with no readable
// time sorts last.
export function resetHistoryRows(events) {
  var rows = [];
  (events || []).forEach(function (event) {
    (event.windows || []).forEach(function (w) {
      var what, kind = '';
      if (event.timing === 'scheduled') what = 'Rolled over on schedule';
      else if (event.timing === 'early') { what = w.type === 'quota-refill' ? 'Reset early, quota refilled' : 'Reset early, window restarted'; kind = 'warn'; }
      else { what = 'Reset, timing unclear'; kind = 'dim'; }
      rows.push({
        when: event.timing === 'scheduled' ? w.before.resetAt : w.after.at,
        account: event.account, provider: event.provider || null, window: w.after.label, what: what, kind: kind,
        before: Math.round(w.before.utilization * 100), after: Math.round(w.after.utilization * 100),
        observed: [w.before.at, w.after.at], resetAt: [w.before.resetAt, w.after.resetAt],
      });
    });
  });
  /** @param {any} v */
  function time(v) { var t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? t : -Infinity; }
  return rows.sort(function (a, b) { var ta = time(a.when), tb = time(b.when); return ta === tb ? 0 : tb > ta ? 1 : -1; });
}

export function sessionActivityText(sessions) {
  if (!sessions || typeof sessions.active !== 'number') return 'Session tracking unavailable';
  return sessions.active === 0 ? 'No recent Claude session IDs observed'
    : sessions.active + ' recent Claude session ' + (sessions.active === 1 ? 'ID' : 'IDs');
}

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, providerLabel, providerOrder, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, routingCards, routeStripLines, problems, quotaDisplay, accountQuotaGroups, sessionActivityText, resetHistoryRows,
  chipFor, forceDefaultAccount, expectedFor, overrideRequest, overrideOutcome,
  fleetFor, resolveSwitchThreshold, resolveMaxUsage, effectiveLimit, quotaGrade, bindingLimit, capBadgeText,
].map(fn => fn.toString()).join('\n\n');

// The constants ride along: `problems` closes over the thresholds and
// `accountBadges` over the reset-credit cut-off, so a page without them would
// ReferenceError on first render. The same goes for the two tables
// `thresholdBadgeText` reads and the UNAVAILABLE_TEXT wording
// `routeStripLines` quotes.
const SHARED_CONSTS = [
  `var STARVED_MIN = ${STARVED_MIN};`,
  `var STARVED_LIST_MAX = ${STARVED_LIST_MAX};`,
  `var RESET_CREDIT_MAX_AGE_MS = ${RESET_CREDIT_MAX_AGE_MS};`,
  `var THRESHOLD_BUCKET_KEYS = ${JSON.stringify(THRESHOLD_BUCKET_KEYS)};`,
  `var THRESHOLD_BUCKET_LABELS = ${JSON.stringify(THRESHOLD_BUCKET_LABELS)};`,
  `var QUOTA_NEAR_BAND = ${QUOTA_NEAR_BAND};`,
  `var RESET_WINDOW_BUCKETS = ${JSON.stringify(RESET_WINDOW_BUCKETS)};`,
  `var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};`,
].join('\n');

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  :root {
    color-scheme:dark;
    --bg:#0d1015; --panel:#151920; --panel-2:#1b2029; --line:#2a313d; --text:#f0f2f7; --dim:#a0abba; --accent:#b5c7ff;
    --ok:#8cd7b0; --warn:#efc17b; --bad:#ffaaa6;
    /* provider tints: identity only (rails, group headers, provider badges). Never a bar fill. */
    --claude:#e8956a; --claude-soft:#2a1d16;
    --codex:#3fbfd0; --codex-soft:#12242a;
    --other:#a0abba; --other-soft:#1b2029;
    /* quota grades: measurement only (bar fill, grade word, status badge). Never on identity elements. */
    --grade-ok:#9ad46e; --grade-ok-ink:#b9e394; --grade-ok-soft:#1c2a19;
    --grade-near:#f2d060; --grade-near-ink:#f5db85; --grade-near-soft:#2e2814;
    --grade-at:#e8506a; --grade-at-ink:#ff9aae; --grade-at-soft:#33181e;
    --grade-spent:#e8506a; --grade-spent-ink:#ff9aae; --grade-spent-soft:#33181e;
    --track:#262d39; --tick:#f0f2f7;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  h1,h2,h3,p { margin:0; }
  h1 { font-size:30px; font-weight:650; letter-spacing:-.8px; line-height:1.25; }
  h2 { font-size:17px; font-weight:600; letter-spacing:-.25px; }
  h3 { font-size:14px; }
  button,input,select { font:inherit; }
  button { cursor:pointer; background:#1b2029; color:var(--text); border:1px solid var(--line); border-radius:7px; padding:9px 13px; min-height:40px; }
  button:hover { border-color:#6f7f9b; }
  button:disabled { opacity:.5; cursor:default; }
  button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,th:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  a { color:var(--accent); }
  .skip { position:absolute; left:12px; top:-80px; padding:12px; background:var(--panel); z-index:5; }
  .skip:focus { top:12px; }
  #app { display:grid; grid-template-columns:204px minmax(0,1fr); min-height:100vh; }
  .sidebar { min-width:0; background:#10141a; border-right:1px solid var(--line); padding:30px 18px; }
  .brand { color:var(--text); font-size:20px; letter-spacing:-.5px; font-weight:650; display:flex; align-items:center; gap:10px; padding:0 10px; text-decoration:none; }
  .brand-mark { width:22px; height:22px; display:inline-block; border:2px solid var(--accent); border-radius:5px; box-shadow:6px 6px 0 -2px var(--bg),6px 6px 0 0 var(--accent); margin-right:5px; }
  .nav-label { margin:42px 12px 12px; color:var(--dim); font-size:11px; letter-spacing:1.2px; text-transform:uppercase; }
  nav { display:flex; flex-direction:column; gap:5px; }
  nav a { text-decoration:none; color:var(--dim); padding:11px 13px; min-height:44px; border-radius:7px; font-size:13px; }
  nav a[aria-current] { color:#e0e8ff; background:#242d40; }
  nav a:hover { background:#1b2330; }
  .main-content { padding:32px 38px; max-width:1560px; width:100%; margin:0 auto; min-width:0; }
  .topline,.section-head { display:flex; align-items:center; justify-content:space-between; gap:18px; }
  .topline { margin-bottom:28px; }
  .topline>div:first-child { min-width:0; flex:1 1 auto; }
  .eyebrow { color:var(--dim); font-size:11px; letter-spacing:1.4px; text-transform:uppercase; margin-bottom:8px; }
  .sub,.routing-help { color:var(--dim); font-size:13px; margin-top:8px; }
  .toolbar,.account-tools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .toolbar { flex:0 0 auto; }
  .live { color:var(--dim); font-size:12px; }
  .route-panel { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .route-panel .section-head { padding:17px 20px; margin:0; border-bottom:1px solid var(--line); }
  .provider-routing { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  /* Overview routing strip: one line per provider, the only home of the default target and current account. */
  .route-strip { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .route-strip .section-head { padding:15px 20px; margin:0; border-bottom:1px solid var(--line); }
  .strip-line { display:grid; grid-template-columns:150px minmax(0,1fr); gap:14px; padding:14px 20px 14px 17px; border-left:3px solid var(--other); border-bottom:1px solid var(--line); align-items:baseline; }
  .strip-line:last-child { border-bottom:0; }
  .strip-line[data-provider="anthropic"] { border-left-color:var(--claude); }
  .strip-line[data-provider="codex"] { border-left-color:var(--codex); }
  .strip-provider b { font-weight:700; }
  .strip-line[data-provider="anthropic"] .strip-provider b { color:var(--claude); }
  .strip-line[data-provider="codex"] .strip-provider b { color:var(--codex); }
  .strip-provider small { display:block; color:var(--dim); font-size:11px; }
  .strip-target { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
  .strip-target .badge { vertical-align:2px; margin-left:6px; font-weight:400; }
  .strip-why { color:var(--dim); font-size:12px; margin-top:3px; overflow-wrap:anywhere; }
  .strip-target.warnt,.strip-why.warnt { color:var(--grade-near-ink); }
  .route-strip>.routing-help { padding:12px 20px; margin:0; border-top:1px solid var(--line); font-size:12px; }
  .provider-card { padding:16px 20px 18px 17px; border-right:1px solid var(--line); min-width:0; border-top:3px solid var(--other); }
  .provider-card[data-provider="anthropic"] { border-top-color:var(--claude); }
  .provider-card[data-provider="codex"] { border-top-color:var(--codex); }
  .provider-card:last-child { border-right:0; }
  .provider-card h3 { color:var(--dim); font-size:12px; font-weight:500; margin-bottom:8px; }
  .provider-card h3 b { font-weight:600; }
  .provider-card[data-provider="anthropic"] h3 b { color:var(--claude); }
  .provider-card[data-provider="codex"] h3 b { color:var(--codex); }
  .provider-target { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
  .provider-models { color:var(--dim); font-size:12px; margin-top:8px; overflow-wrap:anywhere; }
  .route-panel>.routing-help { padding:12px 20px; margin:0; border-top:1px solid var(--line); font-size:12px; }
  .section-head { margin:27px 0 15px; }
  .section-head .sub { margin-top:5px; }
  .search,input,select { background:#11161e; border:1px solid var(--line); color:var(--text); border-radius:7px; padding:9px 12px; }
  .search { width:200px; min-height:40px; font-size:12px; }
  .search::placeholder { color:var(--dim); }
  .quota-toggle { display:inline-flex; align-items:center; border:1px solid #424d62; border-radius:7px; padding:3px; background:#11161e; }
  .quota-toggle button { min-height:32px; padding:5px 12px; border:0; background:none; font-size:12px; color:var(--dim); }
  .quota-toggle button[aria-pressed="true"] { background:#c2d0f6; color:#19243a; font-weight:600; }
  .account-table-wrap { border:1px solid var(--line); border-radius:11px; overflow:auto; background:var(--panel); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:14px 16px; font-size:13px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-size:12px; font-weight:500; }
  tr:last-child td { border-bottom:0; }
  th.sortable { cursor:pointer; }
  .account-table { table-layout:fixed; }
  .account-table th:first-child { width:27%; }
  .account-table th:last-child { width:94px; }
  .account-table th:nth-child(4) { width:24%; }
  /* Provider tint lives on identity slots only: the group band, the row rail, the provider badge, the dialog top border. */
  .account-table .provider-heading th { padding:9px 16px 9px 13px; font-weight:600; border-left:3px solid var(--other); background:var(--other-soft); color:var(--text); }
  .account-table .provider-heading[data-provider="anthropic"] th { border-left-color:var(--claude); background:var(--claude-soft); }
  .account-table .provider-heading[data-provider="codex"] th { border-left-color:var(--codex); background:var(--codex-soft); }
  .provider-heading th b { font-weight:700; }
  .provider-heading[data-provider="anthropic"] th b { color:var(--claude); }
  .provider-heading[data-provider="codex"] th b { color:var(--codex); }
  .provider-heading th span { color:var(--dim); font-weight:400; }
  .account-table td { padding-top:18px; padding-bottom:18px; }
  .account-row td:first-child { border-left:3px solid var(--other); padding-left:13px; }
  .account-row[data-provider="anthropic"] td:first-child { border-left-color:var(--claude); }
  .account-row[data-provider="codex"] td:first-child { border-left-color:var(--codex); }
  .reset-table td { padding:12px 16px; }
  .reset-table th:first-child { white-space:nowrap; }
  .reset-table td small { display:block; font-size:11px; margin-top:3px; }
  #resetAccounts .card p { margin-top:8px; }
  #resetAccounts .card p.usage { margin-top:6px; line-height:1.5; }
  /* Resets: the rail and the provider word are identity; the mini bars are grades. */
  .card[data-provider] { border-left:3px solid var(--other); }
  .card[data-provider="anthropic"] { border-left-color:var(--claude); }
  .card[data-provider="codex"] { border-left-color:var(--codex); }
  .card-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .card-head h3 { font-size:14px; overflow-wrap:anywhere; }
  #resetAccounts .card p.totals { margin:0 0 4px; font-family:var(--mono); font-size:12px; color:var(--dim); }
  .totals b { color:var(--text); font-weight:600; }
  .totals .early b { color:var(--grade-near-ink); }
  .mini { display:grid; grid-template-columns:110px minmax(0,1fr) 120px; gap:10px; align-items:center; margin-top:10px; font-size:12px; }
  .mini .lbl { color:var(--dim); }
  .mini .num { text-align:right; color:var(--dim); font-size:11px; white-space:nowrap; }
  .mini .num b { color:var(--text); font-weight:600; }
  #resetAccounts .card .mini + p { margin-top:12px; }
  #resetAccounts { margin:14px 0; }
  #resetAccounts .card { margin:0; }
  #resetAccounts .card p.warnt { font-size:12px; line-height:1.5; }
  #resetsSection .warnt { color:var(--grade-near-ink); }
  .reset-table tr[data-provider] td:first-child { border-left:3px solid var(--other); padding-left:13px; }
  .reset-table tr[data-provider="anthropic"] td:first-child { border-left-color:var(--claude); }
  .reset-table tr[data-provider="codex"] td:first-child { border-left-color:var(--codex); }
  .reset-table tr[data-provider="anthropic"] .pv { color:var(--claude); }
  .reset-table tr[data-provider="codex"] .pv { color:var(--codex); }
  .reveal { margin:12px 0 0; }
  .account-name { font-size:13px; font-weight:600; display:block; overflow-wrap:anywhere; margin-bottom:7px; }
  .account-meta { color:var(--dim); font-size:11px; margin-top:6px; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .badge { display:inline-block; font-size:11px; border-radius:5px; border:1px solid var(--line); padding:2px 7px; color:var(--dim); line-height:1.5; }
  .badge.provider { color:var(--text); border-color:var(--other); }
  .badge.provider.anthropic { color:var(--claude); border-color:var(--claude); background:var(--claude-soft); }
  .badge.provider.codex { color:var(--codex); border-color:var(--codex); background:var(--codex-soft); }
  .badge.meta { color:var(--dim); }
  .badge.current { color:var(--text); border-color:#4a5568; font-weight:600; }
  /* Status badges use the grade palette, so a badge and a bar of one severity read as the same thing. */
  .badge.near { color:var(--grade-near-ink); background:var(--grade-near-soft); border-color:var(--grade-near); }
  .badge.at,.badge.spent,.badge.error { color:var(--grade-at-ink); background:var(--grade-at-soft); border-color:var(--grade-at); }
  /* The binding-limit line: the one line to read per account. */
  .binding { display:grid; grid-template-columns:auto minmax(0,1fr); gap:0 8px; align-items:center; margin-top:10px; font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:11.5px; line-height:1.55; color:var(--dim); }
  .binding .dot { width:8px; height:8px; border-radius:2px; background:var(--dim); }
  .binding .sub2 { grid-column:2; color:var(--dim); font-size:11px; }
  .binding[data-grade="ok"] .dot { background:var(--grade-ok); }
  .binding[data-grade="near"] .dot { background:var(--grade-near); }
  .binding[data-grade="at"] .dot { background:var(--grade-at); }
  .binding[data-grade="spent"] .dot { background:var(--grade-spent); }
  .binding b { color:var(--text); font-weight:600; }
  .binding .g { font-weight:700; text-transform:uppercase; letter-spacing:.4px; }
  .binding[data-grade="ok"] .g { color:var(--grade-ok-ink); }
  .binding[data-grade="near"] .g { color:var(--grade-near-ink); }
  .binding[data-grade="at"] .g,.binding[data-grade="spent"] .g { color:var(--grade-at-ink); }
  /* Quota rows and graded bars. Grade lands as a class and data-grade, never an inline color. */
  .quota+.quota { margin-top:16px; }
  .quota-head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:5px 12px; margin-bottom:7px; }
  .quota .lbl { color:var(--dim); font-size:11px; overflow-wrap:anywhere; }
  .quota .lbl.binding-mark::before { content:"▸ "; color:var(--text); }
  .quota .val { font-size:12px; font-weight:600; white-space:nowrap; font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .quota .val small { font-size:11px; color:var(--dim); font-weight:400; font-family:ui-sans-serif,system-ui,sans-serif; }
  .quota .val .g { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; margin-left:6px; font-family:ui-sans-serif,system-ui,sans-serif; }
  .quota[data-grade="ok"] .g { color:var(--grade-ok-ink); }
  .quota[data-grade="near"] .g { color:var(--grade-near-ink); }
  .quota[data-grade="at"] .g,.quota[data-grade="spent"] .g { color:var(--grade-at-ink); }
  .bar { position:relative; height:6px; border-radius:3px; background:var(--track); }
  .bar i { display:block; height:100%; border-radius:3px; background:var(--dim); }
  .bar[data-grade="ok"] i { background:var(--grade-ok); }
  .bar[data-grade="near"] i { background:var(--grade-near); }
  .bar[data-grade="at"] i { background:var(--grade-at); }
  .bar[data-grade="spent"] i { background:var(--grade-spent); background-image:repeating-linear-gradient(135deg,transparent 0 4px,#0d101580 4px 6px); }
  .bar b { position:absolute; top:-3px; width:2px; height:12px; background:var(--tick); border-radius:1px; transform:translateX(-1px); }
  .bar b.cap { background:var(--grade-at-ink); width:3px; }
  .bar b.cap::after { content:""; position:absolute; left:-3px; top:-4px; border:4px solid transparent; border-top-color:var(--grade-at-ink); border-bottom:0; }
  .quota-reset { font-size:11px; color:var(--dim); margin-top:6px; }
  .quota-reset span { display:block; }
  .quota-unknown { color:var(--dim); font-size:12px; }
  .quota-date { white-space:nowrap; }
  .act { white-space:nowrap; background:none; border:0; color:var(--accent); padding:4px 0; min-height:44px; font-size:12px; }
  .account-foot { display:flex; gap:20px; justify-content:space-between; color:var(--dim); font-size:11px; margin-top:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:14px 0; overflow-x:auto; }
  .row { display:flex; gap:9px; flex-wrap:wrap; align-items:baseline; margin-bottom:15px; }
  .name { font-weight:600; overflow-wrap:anywhere; }
  .tag,.usage,.hint { color:var(--dim); font-size:12px; }
  .usage { margin-top:13px; line-height:1.7; }
  .split { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin:22px 0; }
  .metric { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:20px; }
  .metric strong { display:block; font-size:30px; font-weight:600; margin:6px 0; }
  .metric-label,.metric small { font-size:12px; color:var(--dim); }
  .details { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:0; }
  .details dt { color:var(--dim); font-size:12px; }
  .details dd { margin:4px 0 0; overflow-wrap:anywhere; }
  .filters { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:12px; }
  .filters label { color:var(--dim); font-size:12px; }
  td.num,th.num { text-align:right; }
  .dim,.no { color:var(--dim); }
  .no { text-decoration:line-through; }
  .ok { color:var(--ok); }
  .pin { color:var(--accent); }
  .warnt,.blocked { color:var(--warn); }
  .badt { color:var(--bad); }
  .empty { color:var(--dim); padding:28px; text-align:center; }
  .history { height:90px; display:flex; align-items:end; gap:3px; margin:20px 0 12px; }
  .history i { flex:1; background:var(--accent); border-radius:3px 3px 0 0; min-height:2px; }
  .history-label { color:var(--dim); font-size:12px; }
  #err,#note,#problems { display:none; margin:0 0 20px; font-size:13px; }
  #err { border:1px solid #68503c; background:#282019; padding:14px 17px; border-radius:8px; color:var(--warn); }
  #problems>div { border:1px solid #5a4a1e; border-left-width:3px; background:var(--grade-near-soft); padding:12px 17px 12px 14px; border-radius:8px; margin-bottom:9px; color:var(--grade-near-ink); }
  #problems>div[data-provider] { border-left-color:var(--other); }
  #problems>div[data-provider="anthropic"] { border-left-color:var(--claude); }
  #problems>div[data-provider="codex"] { border-left-color:var(--codex); }
  #problems .pv { font-weight:700; }
  #problems>div[data-provider="anthropic"] .pv { color:var(--claude); }
  #problems>div[data-provider="codex"] .pv { color:var(--codex); }
  #problems>.bad { border-color:#6b2f3c; background:var(--grade-at-soft); color:var(--grade-at-ink); }
  #note { padding:13px 17px; border:1px solid var(--line); border-radius:8px; }
  #note.warn,.dialog-result.warn { color:var(--warn); } #note.error,.dialog-result.error { color:var(--bad); }
  .stale .route-strip,.stale .provider-routing { opacity:.6; }
  .stale .bar i { background:#7f8799; background-image:none; }
  #keybox { display:none; max-width:440px; margin:12vh auto; padding:30px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  #keybox input { width:100%; min-height:44px; margin:8px 0 16px; }
  #keybox label { display:block; margin-top:22px; }
  #keybox button { width:100%; }
  #loginError { color:var(--bad); margin-top:12px; }
  .primary { background:#c0cfff; color:#172239; border-color:#c0cfff; font-weight:600; }
  dialog { width:550px; max-width:calc(100% - 32px); max-height:calc(100dvh - 40px); color:var(--text); background:#171c24; border:1px solid #3a4556; border-radius:14px; padding:27px; }
  dialog::backdrop { background:#03060aba; backdrop-filter:blur(3px); }
  dialog[data-provider="anthropic"] { border-top:3px solid var(--claude); }
  dialog[data-provider="codex"] { border-top:3px solid var(--codex); }
  .dialog-head { display:flex; align-items:start; justify-content:space-between; gap:20px; margin-bottom:15px; }
  .dialog-head h2 { font-size:22px; overflow-wrap:anywhere; }
  .dialog-head button { padding:5px 12px; min-height:40px; }
  .dialog-help { color:var(--dim); font-size:13px; margin:14px 0 20px; }
  dialog label { display:block; font-size:12px; margin:18px 0 8px; }
  dialog select { width:100%; min-height:44px; border-left:4px solid var(--line); }
  dialog select[data-provider="anthropic"] { border-left-color:var(--claude); }
  dialog select[data-provider="codex"] { border-left-color:var(--codex); }
  .explain { background:#202631; border:1px solid #354050; border-radius:8px; padding:14px 17px; color:#c5cedd; font-size:12px; margin:18px 0; }
  .explain ul { margin:9px 0 0; padding-left:18px; }
  .explain li+li { margin-top:8px; }
  fieldset { border:1px solid var(--line); border-radius:8px; margin:20px 0 0; padding:6px 15px 14px; }
  legend { color:var(--dim); font-size:12px; padding:0 6px; }
  .force-modes label { display:flex; align-items:center; gap:9px; margin:10px 0 0; font-size:13px; }
  .force-modes input { width:16px; height:16px; padding:0; flex:0 0 auto; accent-color:#c0cfff; }
  .force-modes p { margin:5px 0 0 25px; }
  /* Force controls live in the route's target cell, not a column of their own. */
  .route-actions { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:6px; }
  .route-actions .act { min-height:32px; padding:2px 0; }
  #routes .chip { display:inline-block; }
  #routes .chip.chip-line { display:block; margin-top:4px; }
  #routes tr[data-provider] td:first-child { border-left:3px solid var(--other); padding-left:13px; }
  #routes tr[data-provider="anthropic"] td:first-child { border-left-color:var(--claude); }
  #routes tr[data-provider="codex"] td:first-child { border-left-color:var(--codex); }
  .dialog-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:23px; }
  .dialog-result { font-size:13px; padding:13px 0; }
  #accountDetails .quota { margin:18px 0; }
  #accountDetails .quota-reset { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  #accountDetails .quota .lbl { font-size:13px; }
  .section-body>h2,#routesWrap>h2 { margin:26px 0 12px; }
  footer { color:var(--dim); font-size:11px; margin-top:28px; }
  @media(max-width:1150px) { .main-content { padding:26px; } #app { grid-template-columns:175px minmax(0,1fr); } .sidebar { padding:28px 12px; } .section-head { align-items:start; } .account-tools { justify-content:flex-end; } .account-table th:first-child { width:24%; } .account-table th:last-child { width:68px; } th,td { padding:14px 12px; } .strip-line { grid-template-columns:120px minmax(0,1fr); } }
  @media(max-width:900px) { #app { grid-template-columns:minmax(0,1fr); } .sidebar { border-right:0; border-bottom:1px solid var(--line); padding:20px 24px 12px; } .nav-label { display:none; } nav { flex-direction:row; overflow:auto; margin-top:18px; } nav a { white-space:nowrap; flex-shrink:0; } .main-content { padding:24px; } .topline { flex-wrap:wrap; gap:16px; } .toolbar { width:100%; } .live { margin-right:auto; } .split { grid-template-columns:1fr; }
    #routes thead { display:none; } #routes,#routes tbody,#routes tr,#routes td { display:block; width:100%; } #routes tr { padding:12px 0; border-bottom:1px solid var(--line); } #routes tr:last-child { border-bottom:0; } #routes tr[data-provider] { border-left:3px solid var(--other); } #routes tr[data-provider="anthropic"] { border-left-color:var(--claude); } #routes tr[data-provider="codex"] { border-left-color:var(--codex); } #routes tr[data-provider] td:first-child { border-left:0; padding-left:16px; } #routes td { border:0; padding:3px 16px; } #routes td[data-label]::before { content:attr(data-label) ": "; color:var(--dim); } #routes .route-actions { padding-top:4px; gap:0 8px; } #routes .route-actions .chip { flex-basis:100%; } #routes .route-actions .act { min-height:44px; } }
  @media(max-width:650px) { .main-content { padding:23px 17px; } .sidebar { padding:20px 17px 10px; } .brand { padding:0; } h1 { font-size:27px; } .eyebrow { font-size:10px; } .section-head { flex-direction:column; align-items:stretch; } .account-tools { justify-content:space-between; } .search { flex:1; min-width:145px; width:auto; } .quota-toggle button { min-height:38px; padding:6px 13px; } .route-panel .section-head,.route-strip .section-head { flex-direction:row; flex-wrap:wrap; } .strip-line { grid-template-columns:1fr; gap:4px; } .provider-routing { grid-template-columns:1fr; } .provider-card { border-right:0; border-bottom:1px solid var(--line); } .provider-card:last-child { border-bottom:0; } .account-table-wrap { border:0; border-radius:0; background:none; overflow:visible; } .account-table,.account-table tbody,.account-table tr,.account-table td { display:block; width:100%; } .account-table thead { display:none; } .account-table .provider-heading th { display:block; width:100%; border-radius:8px; padding:10px 14px; margin-bottom:10px; } .account-table .account-row { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 16px 16px 0; margin-bottom:14px; border-left-width:3px; border-left-color:var(--other); } .account-table .account-row[data-provider="anthropic"] { border-left-color:var(--claude); } .account-table .account-row[data-provider="codex"] { border-left-color:var(--codex); } .account-table .account-row td:first-child { border-left:0; } .account-table td { border:0; padding:0 0 16px 14px; } .account-table td:last-child { padding:0 0 0 14px; } .account-table td[data-label]::before { content:attr(data-label); display:block; font-size:12px; color:var(--dim); margin-bottom:8px; } .account-table .quota-reset { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 10px; } .account-name { font-size:14px; } .quota .lbl,.account-meta,.quota-reset { font-size:12px; } .quota .val { font-size:13px; } .act { width:100%; border-top:1px solid var(--line); padding-top:12px; text-align:left; } .route-actions .act { width:auto; border-top:0; padding:2px 0; } .account-foot { flex-direction:column; gap:7px; } .stats { grid-template-columns:1fr; } dialog { padding:22px; } .dialog-actions button { min-height:44px; } }
  @media(max-width:650px) { .reset-table thead { display:none; } .reset-table,.reset-table tbody,.reset-table tr,.reset-table td { display:block; width:100%; } .reset-table tr { padding:10px 0; border-bottom:1px solid var(--line); } .reset-table td { border:0; padding:2px 16px; } .reset-table td[data-label]::before { content:attr(data-label) ': '; color:var(--dim); } .reset-table tr[data-provider] { border-left:3px solid var(--other); } .reset-table tr[data-provider="anthropic"] { border-left-color:var(--claude); } .reset-table tr[data-provider="codex"] { border-left-color:var(--codex); } .reset-table tr[data-provider] td:first-child { border-left:0; padding-left:16px; } .mini { grid-template-columns:90px minmax(0,1fr) 96px; } .reveal { width:100%; min-height:44px; } }
</style>
</head>
<body>
<a class="skip" href="#mainContent">Skip to dashboard</a>
<div id="keybox">
  <div class="eyebrow">Private workspace</div><h1>TeamClaude</h1>
  <p class="sub" id="loginHelp">Enter your proxy key to view status.</p>
  <label for="key" id="keyLabel">Proxy key</label><input id="key" type="password" autocomplete="current-password">
  <button id="go" class="primary">Sign in</button><p id="loginError" role="alert"></p>
</div>
<div id="app" style="display:none">
  <aside class="sidebar"><a class="brand" href="#overview"><i class="brand-mark" aria-hidden="true"></i>TeamClaude</a>
    <p class="nav-label">Monitor</p>
    <nav aria-label="Dashboard sections"><a href="#overview" data-view="overview" aria-current="page">Overview</a><a href="#accounts" data-view="accounts">Accounts</a><a href="#activity" data-view="activity">Activity</a><a href="#routing" data-view="routing">Routing</a><a href="#resets" data-view="resets">Resets</a><a href="#forecast" data-view="forecast">Forecast</a><a href="#diagnostics" data-view="diagnostics">Diagnostics</a></nav>
  </aside>
  <main id="mainContent" class="main-content">
    <header class="topline"><div><div class="eyebrow" id="breadcrumb">Dashboard / Overview</div><h1 id="pageTitle">Routing & capacity</h1><p class="sub" id="summary">Where requests are expected to go. How much quota each account has used.</p></div><div class="toolbar"><span class="live" id="connection" role="status">Connecting</span><button id="refresh">Refresh</button><button id="reload" type="button">Reload config</button><button id="probe" type="button">Probe quotas</button><button id="logout">Sign out</button></div></header>
    <div id="err" role="alert"></div><div id="problems" role="status"></div><div id="note" role="status"></div>
    <section aria-labelledby="routeStripTitle" id="routeStrip" class="route-strip" data-section="overview">
      <div class="section-head"><div><h2 id="routeStripTitle">Next request goes to</h2><p class="sub">Where each provider's representative models land, from the latest router status</p></div><button id="manualSelection">Manual selection</button></div>
      <div id="routeStripLines"></div><p class="routing-help">Routing forecast, not live traffic. Sessions, request pins and retries can use another account. Per-model targets and configured routes are under Routing.</p>
    </section>
    <section id="accountSection" data-section="overview accounts">
      <div class="section-head"><div><h2>Account capacity <span class="tag" id="accountCount"></span></h2><p class="sub" id="quotaHelp">Bars and percentages show quota spent.</p></div><div class="account-tools"><div class="quota-toggle" role="group" aria-label="Quota display"><button id="quotaSpent" aria-pressed="true">Spent</button><button id="quotaLeft" aria-pressed="false">Left</button></div><input class="search" id="accountSearch" type="search" aria-label="Find an account" placeholder="Find an account"></div></div>
      <div id="accounts"></div><div class="account-foot"><span id="quotaTimezone"></span><span>▸ marks the limit the router gates on. Requests, tokens and account controls are in Details.</span></div>
    </section>
    <section data-section="activity" hidden class="section-body">
      <div id="overview" class="stats"></div><div class="split"><section><h2>Request activity</h2><div class="card"><p class="usage">Requests observed while this page is open</p><div class="history" id="history" role="img" aria-label="Request activity"></div><p class="history-label" id="historyLabel">Collecting the first sample...</p></div></section><section><h2>Token accounting</h2><div class="card" id="tokens"></div></section></div>
      <div id="clientsWrap"><h2>Clients</h2><div class="card"><table id="clients"></table></div></div><div id="dimensionsWrap"></div>
      <section id="sessionsWrap"><h2>Claude session activity</h2><p class="sub" id="sessionActivity"></p><p class="usage" id="sessionKnown"></p><p class="usage">Counts only requests carrying a Claude session ID. A session remains recent for two minutes after a request, or while a request is running. Codex and requests without a session ID are not included. This does not count open apps or terminals.</p><div class="card"><div class="filters"><label>Project <select id="fProject"></select></label><label>Client <select id="fClient"></select></label><span class="hint" id="sessionCount"></span></div><table id="sessions"></table></div></section>
    </section>
    <section data-section="routing" hidden class="section-body">
      <section aria-labelledby="modelRoutingTitle" id="modelRouting" class="route-panel" data-section="routing">
        <div class="section-head"><div><h2 id="modelRoutingTitle">Expected routing per model</h2><p class="sub">Representative models, based on the latest router status</p></div><button id="routingManualSelection">Manual selection</button></div>
        <div class="provider-routing" id="providerRouting"></div><p class="routing-help">Routing forecast, not live traffic. Existing sessions, request pins, and retries can use another account.</p>
      </section>
      <div id="routesWrap"><h2>Configured routes</h2><div class="card"><table id="routes"></table></div><p class="routing-help" id="forceBlocked" hidden></p></div></section>
    <section data-section="resets" hidden class="section-body" id="resetsSection"><h2>Watched limits</h2><p class="usage" id="resetSummary"></p><div class="split" id="resetAccounts"></div><h2>Reset history</h2><div class="card"><table id="resetEvents" class="reset-table"></table><div id="resetReveal"></div></div><p class="usage" id="resetHistoryNote"></p></section>
    <section data-section="forecast" hidden class="section-body" id="forecastSection">
      <div class="section-head"><div><h2>Subscription forecasts</h2><p class="sub">Account usage includes every machine using that subscription.</p></div><label>Work horizon <select id="forecastHorizon"><option value="2">2 hours</option><option value="8" selected>8 hours</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option></select></label></div>
      <div class="card"><p id="forecastSummary" role="status"></p><p class="usage" id="forecastCoverage"></p><p class="usage" id="forecastAssumptions"></p></div>
      <div id="forecastAccounts"></div><h2>Model alternatives</h2><div id="forecastAdvice" class="card"></div>
    </section>
    <section data-section="diagnostics" hidden class="section-body" id="diagnostics"><h2>Server diagnostics</h2><div class="split"><div class="card" id="serverInfo"></div><div class="card" id="routingInfo"></div></div><h2>Quota probes and warmup</h2><div class="card"><table id="jobs"></table></div></section>
    <footer id="foot"></footer>
  </main>
</div>
<dialog id="accountDialog" aria-labelledby="accountDialogTitle"><div class="dialog-head"><h2 id="accountDialogTitle">Account details</h2><button data-close="accountDialog" aria-label="Close account details">×</button></div><div id="accountDetails"></div><div class="dialog-actions"><button data-close="accountDialog">Close</button><button id="accountManual">Manual selection</button></div></dialog>
<dialog id="switchDialog" aria-labelledby="switchTitle"><div class="dialog-head"><div><div class="eyebrow">Routing control</div><h2 id="switchTitle">Select starting account</h2></div><button data-close="switchDialog" aria-label="Close manual selection">×</button></div><p class="dialog-help">Rotation continues from the selected account. Eligibility and model routes can select another account immediately.</p><label for="switchAccount">Account</label><select id="switchAccount"></select><div class="explain"><strong>What changes</strong><ul><li>The router records this starting account for rotation.</li><li>It does not pin a model or change account priority.</li><li>Existing sessions, model routes, and request pins still apply.</li></ul></div><p id="switchHelp" class="dialog-help"></p><div id="switchResult" class="dialog-result" role="status"></div><div class="dialog-actions"><button data-close="switchDialog">Close</button><button id="applySwitch" class="primary" disabled>Set starting account</button></div></dialog>
<dialog id="forceDialog" aria-labelledby="forceTitle"><div class="dialog-head"><div><div class="eyebrow">Routing control</div><h2 id="forceTitle">Force a route to one account</h2></div><button data-close="forceDialog" aria-label="Close force route">×</button></div><p class="dialog-help" id="forceRouteHelp"></p><label for="forceAccount">Account</label><select id="forceAccount"></select><fieldset class="force-modes"><legend>When it runs out of usage</legend><label for="forceFallback"><input type="radio" name="forceWhenSpent" id="forceFallback" value="fallback" checked>Fall back to automatic routing</label><p class="dialog-help">The other members of this route serve it until the forced account is eligible again.</p><label for="forceHold"><input type="radio" name="forceWhenSpent" id="forceHold" value="hold">Hold on it</label><p class="dialog-help">No other member serves this route. Requests get a 429 with a retry-after until the forced account is eligible again.</p></fieldset><div class="explain"><strong>What changes</strong><ul><li>Every request matching this route goes to the selected account.</li><li>It stays forced until you clear it. There is no timer.</li><li>Sessions pinned with TC_ACCT bypass routes and are not affected.</li></ul></div><p id="forceHelp" class="dialog-help"></p><div id="forceResult" class="dialog-result" role="status"></div><div class="dialog-actions"><button data-close="forceDialog">Cancel</button><button id="forceUseCurrent" hidden>Use current</button><button id="applyForce" class="primary" disabled>Apply</button></div></dialog>
<script>
(function () {
  'use strict';
  var SESSION_AUTH = false;
  var KEY = 'teamclaude-dashboard-key';
  var quotaMode = 'spent';
  try { if (localStorage.getItem('teamclaude-quota-display') === 'left') quotaMode = 'left'; } catch {}
  var detailAccount = null;
  var switchPending = false;
  var forceRoute = null;
  var forceOpener = null;
  var forceBaseline = null;
  var forcePending = false;
  var forceConflictRow = null;
  var forceFocusRoute = null;
  var clearConfirmRoute = null;
  var clearConfirmFocus = false;
  var restoreClearFocus = null;
  var routeFocus = null;
  var connected = false;
  var lastUpdated = null;
  var history = [];
  var previousSample = null;
  var polling = false;
  var pollAgain = false;
  var authGeneration = 0;
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  // The reset history opens on its newest rows (FR 22); the reveal is page
  // state kept out here so the 5 s full re-render does not collapse it.
  var RESET_HISTORY_DEFAULT = 20;
  var resetHistoryExpanded = false;
  var resetShowAll = null;

${SHARED_CONSTS}

${SHARED_HELPERS}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // "switch at 98%" / "cap 60%": the number a bar is graded against, worded by
  // which of the two limits binds. Rounded like the threshold badge.
  function limitPct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  function limitText(kind, limit) { return (kind === 'cap' ? 'cap ' : 'switch at ') + limitPct(limit); }
  function resetIn(resetAt) {
    var ts = parseTs(resetAt);
    if (isNaN(ts)) return 'reset time not reported';
    return ts > Date.now() ? 'resets in ' + fmtIn((ts - Date.now()) / 1000) : 'reset time passed';
  }

  // The graded meter for one bucket (FR 4-6), shared by the account table and
  // the Resets view's mini bars. The fill follows the Spent/Left toggle; the
  // grade and the screen-reader text stay on the spent ratio.
  function gradedBar(label, ratio, lim, grade, reset) {
    var value = quotaDisplay(ratio, quotaMode);
    var bar = el('div', 'bar');
    bar.setAttribute('data-grade', grade);
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', label + ', quota ' + quotaMode);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(value));
    bar.setAttribute('aria-valuetext', quotaDisplay(ratio, 'spent') + '% spent, ' + grade + ', ' + limitText(lim.kind, lim.limit) + ', ' + reset);
    var fill = el('i', grade); fill.style.width = value + '%'; bar.appendChild(fill);
    // The tick sits where the router gates; a fill may run past a cap tick, so a bar can be at well short of full (FR 6).
    var tick = el('b', lim.kind === 'cap' ? 'cap' : ''); tick.style.left = limitPct(lim.limit); tick.title = limitText(lim.kind, lim.limit); bar.appendChild(tick);
    return bar;
  }

  // One bucket of one account: label, value, the graded bar with its limit
  // tick, and the reset. binding marks the bucket bindingLimit() named for
  // this account (FR 18). Grade is computed on the spent ratio whatever the
  // toggle shows, so Left changes the number and the fill, never the color.
  function quotaRow(q, a, s, binding) {
    var row = el('div', 'quota');
    var head = el('div', 'quota-head');
    head.appendChild(el('span', 'lbl' + (binding ? ' binding-mark' : ''), q.label));
    var value = quotaDisplay(q.ratio, quotaMode);
    if (value == null) {
      head.appendChild(el('span', 'quota-unknown', 'Not reported'));
      row.appendChild(head);
      return row;
    }
    // A Codex per-model row has no bucket key and grades against the account's default limit (FR 4).
    var lim = effectiveLimit(a, q.bucket || 'default', s.switchThreshold, s.switchThresholds);
    var grade = quotaGrade(q.ratio, lim.limit);
    row.setAttribute('data-grade', grade);
    var val = el('span', 'val', value + '% ');
    val.appendChild(el('small', '', quotaMode));
    val.appendChild(el('span', 'g', grade));
    head.appendChild(val); row.appendChild(head);
    var reset = resetIn(q.resetAt);
    row.appendChild(gradedBar(q.label, q.ratio, lim, grade, reset));
    var resetLine = el('div', 'quota-reset');
    resetLine.appendChild(el('span', '', reset.charAt(0).toUpperCase() + reset.slice(1)));
    var ts = parseTs(q.resetAt);
    if (!isNaN(ts)) resetLine.appendChild(el('span', 'quota-date', new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })));
    row.appendChild(resetLine);
    return row;
  }

  // The one line to read per account (FR 9): the bucket that gates routing
  // soonest, how far along it is, and the number it is measured against.
  function bindingLine(b) {
    var line = el('div', 'binding');
    var dot = el('span', 'dot'); dot.setAttribute('aria-hidden', 'true'); line.appendChild(dot);
    if (!b) { line.setAttribute('data-grade', 'none'); line.appendChild(el('span', '', 'No quota reported')); return line; }
    line.setAttribute('data-grade', b.grade);
    var main = el('span');
    main.appendChild(el('b', '', b.label));
    main.appendChild(el('span', '', ' ' + quotaDisplay(b.ratio, quotaMode) + '% ' + quotaMode + ' · '));
    main.appendChild(el('span', 'g', b.grade));
    line.appendChild(main);
    line.appendChild(el('span', 'sub2', limitText(b.limitKind, b.limit) + ' · ' + resetIn(b.resetAt)));
    return line;
  }

  // Only the states that want a reader (FR 11); a healthy account has no
  // status badge. Kinds are the grade palette: a self-clearing hold is near,
  // a refusal is at, an empty bucket is spent, a broken login error.
  function accountBadge(a) {
    var text = null, kind = '';
    if (a.disabled) { text = 'Disabled'; kind = 'error'; }
    else if (a.unavailable) { text = UNAVAILABLE_TEXT[a.unavailable] || a.unavailable; kind = a.unavailable === 'throttled' || a.unavailable === 'entitlement' ? 'near' : 'at'; }
    else if (a.status === 'error') { text = 'Sign-in needed'; kind = 'error'; }
    else if (a.status === 'throttled') { text = 'Rate limited'; kind = 'near'; }
    else if (a.status === 'exhausted') { text = 'Quota exhausted'; kind = 'spent'; }
    else {
      var groups = accountQuotaGroups(a);
      var spent = groups.shared.concat(groups.session, groups.models).filter(function (q) { return q.ratio >= 1; });
      if (spent.length) { text = spent.map(function (q) { return q.label; }).join(', ') + ' exhausted'; kind = 'spent'; }
    }
    return text ? el('span', 'badge ' + kind, text) : null;
  }

  // Group order for the account table (FR 3), the same providerOrder routeRows
  // uses for its default rows. An account with no provider groups last under
  // the neutral tint.
  function providerKeys(accounts) {
    var keys = [];
    accounts.forEach(function (a) { var p = a.provider || ''; if (keys.indexOf(p) === -1) keys.push(p); });
    return keys.sort(providerOrder);
  }

  function accountBadgeRow(a, s) {
    var row = el('div', 'badges');
    var status = accountBadge(a);
    if (status) row.appendChild(status);
    var showProvider = providerKeys(s.accounts || []).length > 1;
    var badges = accountBadges(a, s.currentAccount, s.currentAccounts || null, null, s.switchThreshold, s.switchThresholds);
    ['current', 'provider', 'meta threshold'].forEach(function (kind) {
      var badge = badges.filter(function (item) {
        if (kind === 'provider') return showProvider && item.cls.indexOf('provider ') === 0;
        return item.cls === kind;
      })[0];
      if (badge) row.appendChild(el('span', 'badge ' + badge.cls, badge.text));
    });
    var cap = capBadgeText(a.maxUsage);
    if (cap) row.appendChild(el('span', 'badge meta cap', cap));
    return row;
  }

  function renderAccounts(s) {
    var wrap = document.getElementById('accounts'); wrap.textContent = '';
    var query = document.getElementById('accountSearch').value.toLowerCase();
    var accounts = s.accounts || [];
    var visible = accounts.filter(function (a) { return (a.name + ' ' + a.type + ' ' + providerLabel(a.provider)).toLowerCase().indexOf(query) !== -1; });
    document.getElementById('accountCount').textContent = visible.length + (query ? ' of ' + accounts.length : '') + ' accounts';
    document.getElementById('quotaSpent').setAttribute('aria-pressed', String(quotaMode === 'spent'));
    document.getElementById('quotaLeft').setAttribute('aria-pressed', String(quotaMode === 'left'));
    document.getElementById('quotaHelp').textContent = 'Bars and percentages show quota ' + quotaMode + '. Fill color grades distance to the limit the router gates on; the tick is that limit.';
    if (!visible.length) { wrap.appendChild(el('div', 'empty', query ? 'No matching accounts.' : 'No accounts configured on the proxy.')); return; }
    var scroll = el('div', 'account-table-wrap');
    var table = el('table', 'account-table'); table.setAttribute('aria-label', 'Account capacity');
    var thead = el('thead'), header = el('tr');
    ['Account', 'Weekly / total quota', '5-hour quota', 'Model-specific weekly quota', ''].forEach(function (label) { var th = el('th', '', label); th.scope = 'col'; header.appendChild(th); });
    thead.appendChild(header); table.appendChild(thead);
    providerKeys(visible).forEach(function (provider) {
      var body = el('tbody'); table.appendChild(body);
      var members = visible.filter(function (a) { return (a.provider || '') === provider; });
      var group = el('tr', 'provider-heading'); group.setAttribute('data-provider', provider || 'unknown');
      var title = el('th'); title.colSpan = 5; title.scope = 'rowgroup';
      title.appendChild(el('b', '', providerLabel(provider)));
      title.appendChild(el('span', '', ' · ' + members.length + (members.length === 1 ? ' account' : ' accounts')));
      group.appendChild(title); body.appendChild(group);
      members.forEach(function (a) {
        var tr = el('tr', 'account-row'); tr.setAttribute('data-provider', a.provider || 'unknown');
        var binding = bindingLimit(a, s.switchThreshold, s.switchThresholds);
        var identity = el('td'); identity.appendChild(el('span', 'account-name', a.name)); identity.appendChild(accountBadgeRow(a, s));
        identity.appendChild(bindingLine(binding));
        identity.appendChild(el('div', 'account-meta', a.type === 'oauth' ? 'Subscription' : a.type === 'api_key' ? 'API account' : a.type));
        var probe = ((s.probe || {}).accounts || []).filter(function (p) { return p.name === a.name; })[0];
        identity.appendChild(el('div', 'account-meta', probe && probe.lastProbedAt ? 'Last probe ' + fmtAgo(probe.lastProbedAt) + (probe.error ? ' · Failed' : '') : 'Quota reading time not reported'));
        tr.appendChild(identity);
        var groups = accountQuotaGroups(a);
        ['shared', 'session', 'models'].forEach(function (key, index) {
          var td = el('td'); td.setAttribute('data-label', ['Weekly / total quota','5-hour quota','Model-specific weekly quota'][index]);
          groups[key].forEach(function (q) { td.appendChild(quotaRow(q, a, s, !!binding && binding.bucket === q.bucket)); });
          if (!groups[key].length) td.appendChild(el('span', 'quota-unknown', key === 'shared' ? 'Not reported' : 'No window reported'));
          tr.appendChild(td);
        });
        var action = el('td'); var btn = el('button', 'act', 'Details →'); btn.setAttribute('aria-label', 'Details for ' + a.name); btn.addEventListener('click', function () { showAccount(a.name); }); action.appendChild(btn); tr.appendChild(action); body.appendChild(tr);
      });
    });
    scroll.appendChild(table); wrap.appendChild(scroll);
  }

  function renderAccountDetails() {
    var a = ((lastStatus || {}).accounts || []).filter(function (a) { return a.name === detailAccount; })[0];
    var wrap = document.getElementById('accountDetails'); wrap.textContent = '';
    var dialog = document.getElementById('accountDialog');
    document.getElementById('accountManual').disabled = !connected || !a;
    if (!a) { dialog.removeAttribute('data-provider'); wrap.appendChild(el('p', 'usage', 'This account is no longer in the latest status.')); return; }
    dialog.setAttribute('data-provider', a.provider || 'unknown');
    document.getElementById('accountDialogTitle').textContent = a.name;
    var s = lastStatus || {};
    wrap.appendChild(accountBadgeRow(a, s));
    if (!connected) { var warning = el('p', 'warnt', 'Connection lost. These quota values may be stale.'); warning.setAttribute('role', 'status'); wrap.appendChild(warning); }
    var binding = bindingLimit(a, s.switchThreshold, s.switchThresholds);
    wrap.appendChild(bindingLine(binding));
    wrap.appendChild(el('p', 'usage', providerLabel(a.provider) + ' · ' + a.type + ' · Priority ' + (a.priority || 0)));
    var groups = accountQuotaGroups(a);
    groups.shared.concat(groups.session, groups.models).forEach(function (q) { wrap.appendChild(quotaRow(q, a, s, !!binding && binding.bucket === q.bucket)); });
    var q = a.quota || {}, u = a.usage || {};
    if (a.provider === 'anthropic') wrap.appendChild(el('p', 'usage', 'Recent Claude session IDs: ' + (typeof a.sessions === 'number' ? a.sessions : 'not reported') + '. Only IDs active within two minutes or with a request in flight are counted.'));
    if (q.planType) wrap.appendChild(el('p', 'usage', 'Plan: ' + q.planType));
    wrap.appendChild(el('p', 'usage', (u.totalRequests || 0) + ' requests · ' + fmtNum(accountTokens(u)) + ' tokens reported. Cumulative account counters.'));
    wrap.appendChild(el('p', 'usage', u.lastUsed ? 'Last request ' + fmtAgo(u.lastUsed) : 'No requests recorded.'));
    if (q.spend) { var spend = q.spend; wrap.appendChild(el('p', 'usage', 'Extra usage ' + (spend.enabled ? 'enabled' : 'disabled') + ' · ' + (spend.currency || 'USD') + ' ' + ((spend.usedMinor || 0) / Math.pow(10, spend.exponent == null ? 2 : spend.exponent)).toFixed(2) + ' spent this month')); }
    if (a.pausedUntil || a.rateLimitedUntil) wrap.appendChild(el('p', 'usage', 'Paused until ' + resetDate(a.pausedUntil || a.rateLimitedUntil)));
  }

  function showAccount(name) {
    detailAccount = name; renderAccountDetails(); document.getElementById('accountDialog').showModal();
  }

  function emptyTable(id, text) {
    var table = document.getElementById(id); table.textContent = '';
    var row = el('tr'); row.appendChild(el('td', 'usage', text)); table.appendChild(row);
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = ''; emptyTable('clients', 'No client-attributed usage yet. Requests using the shared proxy key are unattributed.'); return; }
    wrap.style.display = '';
    names.sort(function (a, b) {
      var ca = clients[a], cb = clients[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'WebSockets', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
      tr.appendChild(el('td', 'num', fmtNum(c.connections || 0)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens)));
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  // Header cells that re-sort in place. The sort is state, not a re-fetch, so
  // it survives the 5s poll: re-rendering re-reads sortState below.
  function addSortableHeader(tr, table, label, key, numeric) {
    var th = el('th', (numeric ? 'num ' : '') + 'sortable', label + (sortState[table].key === key ? (sortState[table].dir === 'asc' ? ' ▲' : ' ▼') : ''));
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    th.setAttribute('aria-sort', sortState[table].key === key ? (sortState[table].dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); } });
    th.addEventListener('click', function () {
      var st = sortState[table];
      if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = key; st.dir = numeric ? 'desc' : 'asc'; }
      if (lastStatus) render(lastStatus);
    });
    tr.appendChild(th);
  }

  // Session and conversation are two columns rather than one composite: sorting
  // by Session brings a fan-out's rows together (the sort is stable, so they
  // stay in recency order inside it) and Conv is the only column that differs
  // between them. Narrow on purpose — it is a digest, not a name.
  var SESSION_COLUMNS = [
    { key: 'session', label: 'Session' },
    { key: 'conversation', label: 'Conv' },
    { key: 'client', label: 'Client' },
    { key: 'project', label: 'Project' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'requests', label: 'Req', num: true },
    { key: 'cacheRead', label: 'Cache read', num: true },
    { key: 'cacheCreation', label: 'Cache write', num: true },
    { key: 'input', label: 'Input', num: true },
    { key: 'output', label: 'Output', num: true },
    { key: 'context', label: 'Context', num: true },
    { key: 'lastSeen', label: 'Last seen', num: true },
  ];

  function renderSessions(sessions) {
    var wrap = document.getElementById('sessionsWrap');
    document.getElementById('sessionActivity').textContent = sessionActivityText(sessions);
    document.getElementById('sessionKnown').textContent = sessions && typeof sessions.known === 'number' ? 'The tracker remembers ' + sessions.known + ' session IDs. Idle IDs expire after one hour.' : '';
    if (!sessions || !sessions.items) { wrap.style.display = ''; document.querySelector('#sessionsWrap .filters').style.display = 'none'; emptyTable('sessions', 'Session details are disabled on the proxy. The count above still covers only recent Claude session IDs.'); return; }
    wrap.style.display = '';

    document.querySelector('#sessionsWrap .filters').style.display = '';
    var all = sessionRows(sessions);
    var projectSel = document.getElementById('fProject');
    var clientSel = document.getElementById('fClient');
    fillFilter(projectSel, uniqSorted(all.map(function (r) { return r.project; })), sessionFilters.project);
    fillFilter(clientSel, uniqSorted(all.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSel.value;
    sessionFilters.client = clientSel.value;

    var rows = sortRows(filterSessionRows(all, sessionFilters), sortState.sessions.key, sortState.sessions.dir);
    // Conversations, not sessions: one client session contributes a row per
    // agent it has in flight, and counting rows as sessions would report a
    // fleet carrying several times the clients it has.
    document.getElementById('sessionCount').textContent = rows.length + ' of ' + all.length + ' conversations';

    var table = document.getElementById('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    if (!rows.length) { var empty = el('tr'); var cell = el('td', '', 'No sessions match these filters.'); cell.colSpan = SESSION_COLUMNS.length; empty.appendChild(cell); table.appendChild(empty); }
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.session));
      tr.appendChild(el('td', r.active ? '' : 'dim', r.conversation || '—'));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', '', r.accounts || '—'));
      ['requests', 'cacheRead', 'cacheCreation', 'input', 'output', 'context'].forEach(function (k) {
        tr.appendChild(el('td', 'num', fmtNum(r[k])));
      });
      tr.appendChild(el('td', 'num', r.lastSeen ? fmtAgo(r.lastSeen) : '—'));
      table.appendChild(tr);
    });
  }

  function fillFilter(select, values, value) {
    select.textContent = '';
    var all = el('option', '', 'All');
    all.value = '';
    select.appendChild(all);
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  // One table per configured usage dimension (proxy.usageDimensions).
  function renderDimensions(dimensions) {
    var wrap = document.getElementById('dimensionsWrap');
    wrap.textContent = '';
    Object.keys(dimensions || {}).forEach(function (name) {
      var entries = dimensions[name] || {};
      var rows = Object.keys(entries).map(function (key) {
        var e = entries[key] || {};
        return {
          name: key,
          requests: e.requests || 0,
          inputTokens: e.inputTokens || 0,
          outputTokens: e.outputTokens || 0,
          lastUsed: e.lastUsed ? Date.parse(e.lastUsed) : 0,
        };
      });
      if (!rows.length) return;
      sortState[name] = sortState[name] || { key: 'inputTokens', dir: 'desc' };
      rows = sortRows(rows, sortState[name].key, sortState[name].dir);

      wrap.appendChild(el('h2', '', name.charAt(0).toUpperCase() + name.slice(1)));
      var card = el('div', 'card');
      card.style.padding = '4px 6px';
      var table = el('table');
      var hr = el('tr');
      [{ key: 'name', label: name.charAt(0).toUpperCase() + name.slice(1) },
        { key: 'requests', label: 'Req', num: true },
        { key: 'inputTokens', label: 'Input tok', num: true },
        { key: 'outputTokens', label: 'Output tok', num: true },
        { key: 'lastUsed', label: 'Last used', num: true }].forEach(function (c) {
        addSortableHeader(hr, name, c.label, c.key, !!c.num);
      });
      table.appendChild(hr);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', '', r.name));
        tr.appendChild(el('td', 'num', fmtNum(r.requests)));
        tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
        tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
        tr.appendChild(el('td', 'num', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
        table.appendChild(tr);
      });
      card.appendChild(table);
      wrap.appendChild(card);
    });
  }

  var CHIP_CLASS = { accent: 'pin', warn: 'warnt', bad: 'badt' };

  // Provider-specific samples use the server's targets and eligibility.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    // Per-provider default rows belong to the Overview strip (FR 13-14).
    var rows = routeRows(s).filter(function (r) { return r.kind === 'route'; });
    var blockedNote = document.getElementById('forceBlocked');
    var forceBlocked = !!(s || {}).forceBlocked;
    blockedNote.hidden = !forceBlocked;
    blockedNote.textContent = forceBlocked
      ? 'Forcing is off while accounts still use the deprecated models setting. Replace it with a route.' : '';
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var head = el('thead'), hr = el('tr');
    ['Route / sample', 'Target preview', 'Can serve sample'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    head.appendChild(hr); table.appendChild(head);
    var body = el('tbody'); table.appendChild(body);
    // A route with two globs previews twice. The override belongs to the route,
    // not the sample, so its controls go on the route's first row only.
    var controlled = Object.create(null);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.setAttribute('data-provider', r.provider || '');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      fam.setAttribute('data-label', 'Route');
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
      if (r.sampleModel) fam.title = 'Representative model: ' + r.sampleModel;
      var first = !r.autocreated && !controlled[r.name];
      if (first) controlled[r.name] = true;
      if (first && r.override && r.override.account) {
        fam.appendChild(el('div', 'hint', 'Stays forced until you clear it. Sessions pinned with TC_ACCT are not affected.'));
      }
      tr.appendChild(fam);
      var to = el('td', r.blocked ? 'badt' : '', r.blocked ? 'blocked' : (r.target || '—'));
      to.setAttribute('data-label', 'Target');
      if (r.pinned) to.appendChild(el('span', 'pin', ' · pinned to ' + r.pinned));
      if (r.pinMismatch) to.appendChild(el('span', 'warnt', ' (not eligible)'));
      if (r.provider) to.appendChild(el('span', 'tag', ' · ' + providerLabel(r.provider)));
      var chip = chipFor(r);
      // The route's first row carries the chip inside its controls; a second
      // sample of the same route keeps it inline so the state still reads.
      if (chip && !first) to.appendChild(el('div', 'chip chip-line ' + (CHIP_CLASS[chip.kind] || ''), chip.text));
      if (first) to.appendChild(routeActions(r, chip, forceBlocked));
      tr.appendChild(to);
      var can = el('td');
      can.setAttribute('data-label', 'Can serve');
      if (r.blocked) can.textContent = '—';
      else if (!r.eligible.length && !r.ineligible.length) can.textContent = '—';
      else {
        can.appendChild(el('span', 'ok', r.eligible.length + ' of ' + (r.eligible.length + r.ineligible.length) + (r.ineligible.length ? ' ' : '')));
        if (r.ineligible.length) can.appendChild(el('span', 'no', r.ineligible.join(', ')));
      }
      tr.appendChild(can);
      body.appendChild(tr);
    });
    // Focus only once the rows are in the document: a detached button ignores focus().
    if (routeFocus) { routeFocus.focus(); routeFocus = null; }
  }

  // The Force controls for a configured route's first row, inline at the foot
  // of its target cell (FR 16): the chip and Change…/Clear force when forced,
  // Force… otherwise, or the Clear/Keep confirm in their place.
  function routeActions(r, chip, forceBlocked) {
    var cell = el('div', 'route-actions');
    var forced = !!(r.override && r.override.account);
    if (clearConfirmRoute === r.name) {
      cell.appendChild(el('span', 'hint', 'Clear force on ' + r.name + '?'));
      var yes = el('button', 'act', 'Clear');
      yes.addEventListener('click', function () {
        clearConfirmRoute = null;
        sendOverride(r.name, expectedFor(r), { clear: true }, null);
      });
      var keep = el('button', 'act', 'Keep');
      keep.addEventListener('click', function () {
        clearConfirmRoute = null; restoreClearFocus = r.name;
        if (lastStatus) renderRoutes(lastStatus);
      });
      cell.appendChild(yes); cell.appendChild(keep);
      if (clearConfirmFocus) { clearConfirmFocus = false; routeFocus = yes; }
      return cell;
    }
    if (chip) {
      var chipEl = el('span', 'chip ' + (CHIP_CLASS[chip.kind] || ''), chip.text);
      chipEl.tabIndex = -1;
      cell.appendChild(chipEl);
      // After a successful Apply the page moves the reader to the answer:
      // what the router now says about the route it just changed.
      if (forceFocusRoute === r.name) { forceFocusRoute = null; routeFocus = chipEl; }
    }
    var open = el('button', 'act', forced ? 'Change…' : 'Force…');
    open.setAttribute('aria-haspopup', 'dialog');
    open.setAttribute('aria-label', (forced ? 'Change the forced account for route ' : 'Force route ') + r.name);
    // Ownership claims make membership depend on the request's model, so the
    // server refuses to force a route while any account still carries one.
    open.disabled = !connected || forceBlocked;
    open.addEventListener('click', function () { showForce(r.name, open); });
    cell.appendChild(open);
    // A cleared route has no chip to move to, and the button the confirm
    // replaced is gone, so focus lands here instead of on the document.
    if (forceFocusRoute === r.name) { forceFocusRoute = null; routeFocus = open; }
    if (forced) {
      // Clearing is exempt from the ownership-claim refusal: a route that
      // cannot be un-forced would be a trap.
      var clear = el('button', 'act', 'Clear force');
      clear.setAttribute('aria-label', 'Clear force on route ' + r.name);
      clear.disabled = !connected;
      clear.addEventListener('click', function () {
        clearConfirmRoute = r.name; clearConfirmFocus = true;
        if (lastStatus) renderRoutes(lastStatus);
      });
      cell.appendChild(clear);
      if (restoreClearFocus === r.name) { restoreClearFocus = null; routeFocus = clear; }
    }
    return cell;
  }

  // Top of the page and only when something is wrong: a banner that is always
  // on is a banner nobody reads.
  function renderProblems(s) {
    var wrap = document.getElementById('problems');
    var list = problems(s);
    wrap.textContent = '';
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    list.forEach(function (p) {
      var line = el('div', p.severity);
      // An account line leads with its provider word and wears its tint (RT 1);
      // session lines name no account and stay neutral.
      if (p.kind === 'account') {
        line.setAttribute('data-provider', p.provider || '');
        line.appendChild(el('span', 'pv', providerLabel(p.provider)));
        line.appendChild(el('span', '', ' · ' + p.text));
      } else line.textContent = p.text;
      wrap.appendChild(line);
    });
  }


  function renderProviderRouting(s) {
    var wrap = document.getElementById('providerRouting'); wrap.textContent = '';
    var cards = routingCards(s);
    if (!cards.length) { wrap.appendChild(el('p', 'empty', 'Provider routing is unavailable on this proxy.')); return; }
    cards.forEach(function (provider) {
      provider.groups.forEach(function (group) {
        var card = el('div', 'provider-card'); card.setAttribute('data-provider', provider.provider);
        var h = el('h3'); h.appendChild(el('b', '', providerLabel(provider.provider))); h.appendChild(el('span', '', ' · ' + group.labels.join(', ')));
        card.appendChild(h);
        card.appendChild(el('div', 'provider-target' + (group.target ? '' : ' warnt'), group.target || (group.blocked ? 'Blocked by policy' : 'No eligible account')));
        var models = el('div', 'provider-models', group.models.join(', ')); models.title = 'Representative models'; card.appendChild(models);
        wrap.appendChild(card);
      });
    });
  }

  // Overview's one line per provider (FR 13). The wording is routeStripLines';
  // this only lays it out.
  function renderRouteStrip(s) {
    var wrap = document.getElementById('routeStripLines'); wrap.textContent = '';
    // An empty fleet still reports providerRouting entries (all Unavailable);
    // the honest line is that there is nothing to route to.
    var lines = (s.accounts || []).length ? routeStripLines(s) : [];
    if (!lines.length) {
      wrap.appendChild(el('p', 'empty', (s.accounts || []).length ? 'Provider routing is unavailable on this proxy.' : 'No accounts configured on the proxy.'));
      return;
    }
    lines.forEach(function (line) {
      var row = el('div', 'strip-line'); row.setAttribute('data-provider', line.provider || '');
      var who = el('div', 'strip-provider');
      who.appendChild(el('b', '', line.label));
      who.appendChild(el('small', '', line.accounts + (line.accounts === 1 ? ' account' : ' accounts')));
      row.appendChild(who);
      var what = el('div');
      var target = el('div', 'strip-target' + (line.resolved ? '' : ' warnt'), line.headline);
      if (line.tag) target.appendChild(el('span', 'badge meta', line.tag));
      what.appendChild(target);
      line.why.forEach(function (w) { what.appendChild(el('div', 'strip-why' + (w.warn ? ' warnt' : ''), w.text)); });
      row.appendChild(what);
      wrap.appendChild(row);
    });
  }

  function renderOverview(s) {
    var accounts = s.accounts || [];
    var requests = accounts.reduce(function (sum, a) { return sum + ((a.usage || {}).totalRequests || 0); }, 0);
    var tokens = accounts.reduce(function (sum, a) { return sum + accountTokens(a.usage); }, 0);
    var wrap = document.getElementById('overview'); wrap.textContent = '';
    [['Requests', fmtNum(requests), 'Cumulative account counters'],
      ['Tokens reported', fmtNum(tokens), 'Includes cache reads and writes'],
      ['Requests in progress', s.upstreamPool && s.upstreamPool.active != null ? String(s.upstreamPool.active) : 'Unknown', 'Upstream requests currently in flight']].forEach(function (m) {
        var card = el('div', 'metric'); card.appendChild(el('div', 'metric-label', m[0])); card.appendChild(el('strong', '', m[1])); card.appendChild(el('small', '', m[2])); wrap.appendChild(card);
      });
    var totals = { totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0 };
    accounts.forEach(function (a) { Object.keys(totals).forEach(function (k) { totals[k] += (a.usage || {})[k] || 0; }); });
    details('tokens', [['Input', fmtNum(totals.totalInputTokens)], ['Output', fmtNum(totals.totalOutputTokens)], ['Cache read', fmtNum(totals.totalCacheReadTokens)], ['Cache write', fmtNum(totals.totalCacheCreationTokens)]]);
    document.getElementById('tokens').appendChild(el('p', 'usage', tokens ? 'Only tokens reported by upstream responses are counted.' : 'No token usage reported yet. Request counts can increase without token reports.'));
  }

  function details(id, rows) {
    var wrap = document.getElementById(id); wrap.textContent = '';
    var list = el('dl', 'details');
    rows.forEach(function (r) { var item = el('div'); item.appendChild(el('dt', '', r[0])); item.appendChild(el('dd', '', r[1] == null ? 'Unknown' : String(r[1]))); list.appendChild(item); });
    wrap.appendChild(list);
  }

  function resetDate(value) {
    return value ? new Date(value).toLocaleString() : 'Unknown';
  }

  function shortDate(value) {
    var t = parseTs(value);
    return isNaN(t) ? 'unknown time' : new Date(t).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function pct(reading) { return Math.round(reading.utilization * 100); }

  // One mini bar per limit the tracker is watching on an account (FR 21),
  // graded against the same limit as that bucket's account bar. A window whose
  // reset time has passed is the held pre-expiry reading (see reset-tracker):
  // the account has not been used since, so it reads "ended".
  function miniRow(key, w, a, s) {
    var row = el('div', 'mini');
    row.appendChild(el('span', 'lbl', w.label));
    var shown = quotaDisplay(w.utilization, quotaMode);
    var due = parseTs(w.resetAt);
    var ended = !isNaN(due) && due <= Date.now();
    var when = isNaN(due) ? 'reset not reported' : ended ? 'ended' : fmtIn((due - Date.now()) / 1000);
    if (shown == null) {
      row.appendChild(el('span', 'bar'));
      row.appendChild(el('span', 'num', 'unknown · ' + when));
      return row;
    }
    var lim = effectiveLimit(a, RESET_WINDOW_BUCKETS[key] || 'default', s.switchThreshold, s.switchThresholds);
    var grade = quotaGrade(w.utilization, lim.limit);
    row.appendChild(gradedBar(w.label, w.utilization, lim, grade, ended ? 'ended ' + shortDate(due) + ', no new window yet' : resetIn(w.resetAt)));
    var num = el('span', 'num');
    num.appendChild(el('b', '', shown + '%'));
    num.appendChild(el('span', '', ' ' + quotaMode + ' · ' + when));
    if (!isNaN(due)) num.title = (ended ? 'Ended ' : 'Resets ') + shortDate(due);
    row.appendChild(num);
    return row;
  }

  // One count per timing on one line; a non-zero early count reads in near ink.
  function totalsLine(totals) {
    var line = el('p', 'totals');
    [[totals.scheduled, 'on schedule', ''], [totals.early, 'early', 'early'], [totals.uncertain, 'unclear', '']].forEach(function (t, i) {
      if (i) line.appendChild(el('span', 'sep', ' · '));
      var part = el('span', t[2] && t[0] ? t[2] : '');
      part.appendChild(el('b', '', String(t[0] || 0)));
      part.appendChild(el('span', '', ' ' + t[1]));
      line.appendChild(part);
    });
    return line;
  }

  function resetCard(account, s) {
    var card = el('div', 'card');
    card.setAttribute('data-provider', account.provider || 'unknown');
    var head = el('div', 'card-head');
    head.appendChild(el('h3', '', account.name));
    head.appendChild(el('span', 'badge provider ' + (account.provider || 'unknown'), providerLabel(account.provider)));
    card.appendChild(head);
    card.appendChild(totalsLine(account.totals || {}));
    // Names are unique only within a provider, so match on both: a Claude and a
    // Codex account may share a display name and still gate at different limits.
    var provider = account.provider || 'unknown';
    var a = (s.accounts || []).filter(function (x) { return x.name === account.name && (x.provider || 'unknown') === provider; })[0] || {};
    var windows = account.windows || {};
    var keys = Object.keys(windows);
    if (keys.length) keys.forEach(function (key) { card.appendChild(miniRow(key, windows[key], a, s)); });
    else card.appendChild(el('p', 'usage', 'No limit windows reported yet.'));
    (account.pending || []).forEach(function (pending) {
      card.appendChild(el('p', 'warnt', 'Possible early reset on ' + pending.after.label + ', ' + pct(pending.before) + '% → ' + pct(pending.after) + '% spent, waiting for the next probe.'));
    });
    if (account.provider === 'codex' || account.provider === 'anthropic') {
      var inventory = account.credits;
      card.appendChild(el('p', 'usage', inventory ? 'Banked resets: ' + inventory.availableCount + ' available' + (inventory.observedAt ? ', checked ' + fmtAgo(inventory.observedAt) : '') : 'Banked resets: unknown'));
      if (inventory) inventory.credits.filter(function (credit) { return credit.status === 'available'; }).forEach(function (credit) {
        card.appendChild(el('p', 'usage', (credit.title || credit.resetType) + ' · ' + (credit.expiresAt ? (credit.expiresAt <= Date.now() ? 'expired ' : 'expires ') + shortDate(credit.expiresAt) : 'no expiry reported')
          + (credit.source === 'manual' ? ' · entered manually' : '')));
      });
      // Anthropic lists web-issued banked resets to claude.ai sessions only.
      if (inventory && inventory.oauth && !inventory.oauth.eligible) {
        var hidden = el('p', 'usage dim', 'Not listed to the proxy by Anthropic; add them under bankedResets in the config.');
        hidden.title = 'Anthropic lists banked resets to claude.ai sessions only' + (inventory.oauth.reason ? ' (' + inventory.oauth.reason + ')' : '') + '. Copy one from claude.ai Settings > Usage.';
        card.appendChild(hidden);
      }
      if (account.creditError) card.appendChild(el('p', 'warnt', account.creditError + ', showing the last good inventory.'));
    }
    card.appendChild(el('p', 'usage', account.lastObservedAt ? 'Last probed ' + fmtAgo(account.lastObservedAt) : 'Not probed yet'));
    return card;
  }

  function resetHistoryRow(row) {
    var tr = el('tr');
    tr.setAttribute('data-provider', row.provider || 'unknown');
    tr.title = 'Seen between ' + resetDate(row.observed[0]) + ' and ' + resetDate(row.observed[1]) + '. Reset time ' + resetDate(row.resetAt[0]) + ' → ' + resetDate(row.resetAt[1]) + '.';
    [['When', shortDate(row.when), ''], ['Account', row.account, ''], ['Limit', row.window, ''],
      ['What happened', row.what, row.kind === 'warn' ? 'warnt' : row.kind === 'dim' ? 'dim' : ''],
      ['Spent before → after', row.before + '% → ' + row.after + '%', '']].forEach(function (cell) {
      var td = el('td', cell[2], cell[1]); td.setAttribute('data-label', cell[0]); tr.appendChild(td);
      // The probe pair that bounds the detection, visible rather than hover-only.
      if (cell[0] === 'When') td.appendChild(el('small', 'dim', 'probes ' + shortDate(row.observed[0]) + ' and ' + shortDate(row.observed[1])));
      // The provider word follows the account name (FR 1); the rail carries the tint.
      if (cell[0] === 'Account') { var tag = el('span', 'tag', ' · '); tag.appendChild(el('span', 'pv', providerLabel(row.provider))); td.appendChild(tag); }
    });
    return tr;
  }

  // The reveal under the history (FR 22). One button lives for as long as the
  // history outgrows the cap: the table re-renders around it on every poll,
  // but the button itself is never detached, so it keeps keyboard focus.
  function syncResetReveal(total) {
    var reveal = document.getElementById('resetReveal');
    if (total <= RESET_HISTORY_DEFAULT) { reveal.textContent = ''; resetShowAll = null; return; }
    if (!resetShowAll) {
      resetShowAll = el('button', 'reveal');
      resetShowAll.setAttribute('id', 'resetShowAll'); resetShowAll.setAttribute('type', 'button');
      resetShowAll.setAttribute('aria-controls', 'resetEvents');
      resetShowAll.addEventListener('click', function () { resetHistoryExpanded = !resetHistoryExpanded; if (lastStatus) renderResets(lastStatus); });
      reveal.textContent = ''; reveal.appendChild(resetShowAll);
    }
    resetShowAll.textContent = resetHistoryExpanded ? 'Show the latest ' + RESET_HISTORY_DEFAULT : 'Show all ' + total + ' rows';
    resetShowAll.setAttribute('aria-expanded', String(resetHistoryExpanded));
  }

  function renderResets(s) {
    var data = (s.probe || {}).resets;
    var summary = document.getElementById('resetSummary');
    var accounts = document.getElementById('resetAccounts'); accounts.textContent = '';
    var history = document.getElementById('resetEvents'); history.textContent = '';
    var note = document.getElementById('resetHistoryNote'); note.textContent = '';
    if (!data) { summary.textContent = 'Reset tracking is unavailable on this proxy.'; syncResetReveal(0); return; }
    var probe = s.probe || {}, notifications = data.notifications || {};
    summary.textContent = (probe.enabled ? 'Each account is probed every ' + fmtIn(probe.intervalSeconds) + '. ' : 'Quota probes are off, so nothing here updates. ')
      + 'Tracking since ' + shortDate(data.startedAt) + '. '
      + (notifications.enabled ? 'Early resets go to Google Chat' + (notifications.pending ? ' (' + notifications.pending + ' waiting to send)' : '') + '.' : 'Google Chat alerts are off.')
      + (data.error ? ' ' + data.error : '') + (notifications.error ? ' ' + notifications.error : '');
    (data.accounts || []).forEach(function (account) { accounts.appendChild(resetCard(account, s)); });
    if (!(data.accounts || []).length) accounts.appendChild(el('p', 'usage', 'Waiting for the first successful quota probe.'));
    var rows = resetHistoryRows(data.events);
    var head = el('thead'), headRow = el('tr');
    ['When', 'Account', 'Limit', 'What happened', 'Spent before → after'].forEach(function (label) { headRow.appendChild(el('th', '', label)); });
    head.appendChild(headRow); history.appendChild(head);
    var body = el('tbody');
    if (!rows.length) { var emptyRow = el('tr'), empty = el('td', 'empty', 'No resets seen yet.'); empty.colSpan = 5; emptyRow.appendChild(empty); body.appendChild(emptyRow); }
    // Newest first, capped until the reader asks for the rest (FR 22, RT 2).
    (resetHistoryExpanded ? rows : rows.slice(0, RESET_HISTORY_DEFAULT)).forEach(function (row) { body.appendChild(resetHistoryRow(row)); });
    history.appendChild(body);
    syncResetReveal(rows.length);
    note.textContent = 'Resets are inferred from probe readings, so a small drop or a long gap between probes can be missed.'
      + ((data.events || []).length >= 500 ? ' Showing the latest 500 events; the account counts include older ones.' : '');
  }

  function renderDiagnostics(s) {
    var server = s.server || {}, loop = server.eventLoop || {}, pool = s.upstreamPool || {};
    details('serverInfo', [['Proxy uptime', server.uptimeSeconds == null ? null : fmtIn(server.uptimeSeconds)], ['Proxy port', server.port], ['Event loop lag', loop.lastLagMs == null ? null : loop.lastLagMs + ' ms'], ['Worst lag', loop.maxLagMs == null ? null : loop.maxLagMs + ' ms'], ['Active upstream requests', pool.active], ['Queued upstream requests', pool.queued]]);
    details('routingInfo', [['Switch threshold', s.switchThreshold == null ? null : Math.round(s.switchThreshold * 100) + '%'], ['Session distribution', (s.sessions || {}).mode || 'off'], ['Blocked models', (s.blockedModels || []).join(', ') || 'None'], ['Quota probes', s.probe && s.probe.enabled ? 'Every ' + fmtIn(s.probe.intervalSeconds) : 'Off'], ['Warmup', s.warm && s.warm.enabled ? s.warm.mode || 'On' : 'Off']]);
    var overrides = ((s.fableDepletionRouting || {}).models || []);
    if (overrides.length) { var box = document.getElementById('routingInfo'); box.appendChild(el('p', 'usage', 'Fable depletion overrides')); overrides.forEach(function (r) { box.appendChild(el('p', 'usage', r.model + ' → ' + (r.target || 'None') + ' · ' + r.reason)); }); }
    var table = document.getElementById('jobs'); table.textContent = '';
    var hr = el('tr'); ['Account', 'Quota probe', 'Last checked', 'Warmup', 'Details'].forEach(function (h) { hr.appendChild(el('th', '', h)); }); table.appendChild(hr);
    (s.accounts || []).forEach(function (a) {
      var probe = ((s.probe || {}).accounts || []).filter(function (p) { return p.name === a.name; })[0] || {};
      var warm = ((s.warm || {}).accounts || []).filter(function (p) { return p.name === a.name; })[0] || {};
      var row = el('tr'); [a.name, probe.status || 'Unknown', probe.lastProbedAt ? fmtAgo(probe.lastProbedAt) : 'Never', warm.status || 'Unknown', probe.error || warm.error || (probe.durationMs == null ? 'No measurement' : probe.durationMs + ' ms')].forEach(function (v) { row.appendChild(el('td', '', v)); }); table.appendChild(row);
    });
  }

  function recordActivity(s) {
    var total = (s.accounts || []).reduce(function (n, a) { return n + ((a.usage || {}).totalRequests || 0); }, 0);
    var now = Date.now(), started = (s.server || {}).startedAt;
    if (previousSample && previousSample.started === started && total >= previousSample.total) {
      history.push({ count: total - previousSample.total, seconds: (now - previousSample.time) / 1000 });
      if (history.length > 60) history.shift();
    } else history = [];
    previousSample = { total: total, time: now, started: started };
    var chart = document.getElementById('history'); chart.textContent = '';
    var max = Math.max.apply(null, [1].concat(history.map(function (h) { return h.count / h.seconds; })));
    history.forEach(function (h) { var bar = el('i'); bar.style.height = Math.max(2, h.count / h.seconds / max * 100) + '%'; bar.title = h.count + ' requests in ' + Math.round(h.seconds) + 's'; chart.appendChild(bar); });
    var count = history.reduce(function (n, h) { return n + h.count; }, 0), seconds = history.reduce(function (n, h) { return n + h.seconds; }, 0);
    var label = history.length ? count + ' requests over ' + Math.round(seconds) + 's · ' + (count / seconds * 60).toFixed(1) + ' req/min' : 'Collecting the first sample...';
    document.getElementById('historyLabel').textContent = label; chart.setAttribute('aria-label', label);
  }

  function renderForecast(f) {
    f = f || { status: 'Forecast history is disabled', coverage: {}, accounts: [], recommendations: [] };
    var hours = Number(document.getElementById('forecastHorizon').value);
    var windowLabel = function (bucket, durationMs) {
      if (bucket.indexOf('shared:') === 0) return durationMs === 18000000 ? 'Shared five-hour window' : durationMs === 604800000 ? 'Shared weekly window' : 'Shared quota window';
      if (bucket.indexOf('family:') === 0) return bucket.slice(7) + ' weekly window';
      return bucket.replace(/:/g, ' ');
    };
    var end = Date.now() + hours * 3600000;
    var date = function (t) { return t == null ? 'Unknown' : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); };
    var timing = function (t) { return date(t) + (t > Date.now() ? ', in ' + ((t - Date.now()) / 3600000).toFixed(1) + ' hours' : ''); };
    document.getElementById('forecastSummary').textContent = f.status + ' · Target ' + date(end);
    var coverage = f.coverage || {};
    document.getElementById('forecastCoverage').textContent = 'Unique subscriptions: ' + (coverage.subscriptionCount || 0) + '. ' + (coverage.remoteConsumption || 'History begins after forecast collection is enabled.') + (f.observedThrough ? '. Oldest account reading: ' + date(f.observedThrough) : '') + (coverage.historyEvictions ? '. History reached its disk budget and lost evidence; evaluation remains unproven.' : '') + (coverage.limitReached ? '. Displayed history is limited to the most recent retained samples.' : '');
    document.getElementById('forecastAssumptions').textContent = 'Experimental current-pace scenario. Each subscription keeps its observed total workload. Future resets are conditional. Account percentages and times are not added into a pooled balance.';
    var root = document.getElementById('forecastAccounts'); root.replaceChildren();
    (f.accounts || []).forEach(function (a) {
      var card = el('section', 'card'); card.appendChild(el('h3', '', a.name + ' · ' + (a.provider === 'codex' ? 'Codex' : 'Claude')));
      if (a.disabled) card.appendChild(el('p', 'usage', 'Disabled. Excluded from usable capacity.'));
      if (!a.windows.length) card.appendChild(el('p', 'usage', 'No fresh provider windows recorded yet.'));
      var table = el('table'); var head = el('tr'); ['Quota window', 'Spent', 'Pace per hour', 'Provider limit', 'Reported reset'].forEach(function (h) { head.appendChild(el('th', '', h)); }); table.appendChild(head);
      a.windows.forEach(function (w) {
        var row = el('tr');
        var projection = w.status;
        if (w.limitAt != null && w.resetAt > Date.now()) {
          projection = w.limitAt >= w.resetAt ? 'Reset occurs first; continuation conditional' : w.limitAt > end ? 'No limit projected through target' : timing(w.limitAt);
        }
        [windowLabel(w.bucket, w.durationMs), w.utilization == null ? 'Unknown' : (w.utilization * 100).toFixed(1) + '%', w.ratePerHour == null ? 'Not enough evidence' : (w.ratePerHour * 100).toFixed(2) + ' percentage points', projection, date(w.resetAt)].forEach(function (value) { row.appendChild(el('td', '', value)); });
        table.appendChild(row);
        if (w.hardCapAt != null || w.softThresholdAt != null || w.lastEstimate) {
          var notes = el('tr'); var cell = el('td', 'usage'); cell.colSpan = 5;
          cell.textContent = (w.hardCapAt != null ? 'Hard account cap: ' + timing(w.hardCapAt) + '. ' : '') + (w.softThresholdAt != null ? 'Routing preference threshold: ' + timing(w.softThresholdAt) + '. This may rotate accounts or fall back. ' : '') + (w.lastEstimate ? 'Last estimate predicted a limit at ' + date(w.lastEstimate.limitAt) + '; usage data stale.' : '');
          notes.appendChild(cell); table.appendChild(notes);
        }
      });
      card.appendChild(table);
      (a.models || []).forEach(function (m) { card.appendChild(el('p', 'usage', m.model + ': ' + (m.eligible ? 'Reported constraints permit this model; existing session restrictions still apply' : m.reason))); });
      root.appendChild(card);
    });
    (coverage.exclusions || []).forEach(function (a) { root.appendChild(el('p', 'usage', a.name + ': ' + a.reason)); });
    var advice = document.getElementById('forecastAdvice'); advice.replaceChildren();
    if (!(f.recommendations || []).length) advice.appendChild(el('p', '', coverage.adviceReason || 'No supported model alternatives yet.'));
    (f.recommendations || []).forEach(function (r) {
      advice.appendChild(el('p', '', r.from + ' to ' + r.to + ' on ' + r.account + ' avoids ' + r.avoidedConstraints.map(windowLabel).join(', ') + '.'));
      advice.appendChild(el('p', 'usage', r.evidence + '. ' + r.gainReason + '. ' + r.tradeoff));
    });
  }

  document.getElementById('forecastHorizon').addEventListener('change', function () { renderForecast(lastStatus && lastStatus.forecast); });

  function render(s) {
    lastStatus = s;
    var probe = s.probe || {};
    var probeButton = document.getElementById('probe');
    probeButton.textContent = probe.running ? 'Probe running…' : 'Probe quotas';
    probeButton.disabled = !!probe.running;
    document.getElementById('reload').disabled = false;
    renderRouteStrip(s);
    renderProviderRouting(s);
    renderAccounts(s);
    if (document.getElementById('accountDialog').open) renderAccountDetails();
    if (document.getElementById('switchDialog').open) updateSwitchHelp();
    if (document.getElementById('forceDialog').open) updateForceHelp();
    renderOverview(s);
    renderDiagnostics(s);
    renderResets(s);
    renderForecast(s.forecast);
    renderProblems(s);
    renderRoutes(s);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    renderSessions(s.sessions);
    document.getElementById('foot').textContent = 'Status refreshes every ' + (POLL_MS / 1000) + 's' + (lastUpdated ? ' · Last received ' + new Date(lastUpdated).toLocaleTimeString() : '') + (s.server && s.server.uptimeSeconds != null ? ' · Proxy uptime ' + fmtIn(s.server.uptimeSeconds) : '');
  }

  function note(kind, text) {
    var n = document.getElementById('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
  }

  function updateSwitchHelp() {
    var name = document.getElementById('switchAccount').value;
    var a = ((lastStatus || {}).accounts || []).filter(function (a) { return a.name === name; })[0];
    document.getElementById('applySwitch').disabled = !a || !connected || switchPending;
    var help = !connected ? 'The proxy is disconnected. Wait for a fresh status before selecting an account.'
      : !a ? 'Choose an account to review it before applying.'
      : a.disabled || a.unavailable || a.status === 'error' ? 'The router may skip this account: ' + (a.disabled ? 'disabled' : UNAVAILABLE_TEXT[a.unavailable] || a.unavailable || 'sign-in needed')
      : 'Recorded starting account: ' + ((lastStatus || {}).currentAccount || 'not reported') + '. Model routes and availability can override this choice.';
    if (a && connected) {
      var exhausted = accountQuotaGroups(a).models.filter(function (q) { return q.ratio >= 1; });
      if (exhausted.length) help += ' ' + exhausted.map(function (q) { return q.label; }).join(', ') + ' exhausted. Selecting this account does not restore those limits.';
      var b = bindingLimit(a, lastStatus.switchThreshold, lastStatus.switchThresholds);
      help += b ? ' Binding limit: ' + b.label + ' ' + quotaDisplay(b.ratio, 'spent') + '% spent · ' + b.grade + ', ' + limitText(b.limitKind, b.limit) + '.' : ' No quota reported.';
    }
    document.getElementById('switchHelp').textContent = help;
    tintSelect('switchAccount', a);
  }

  function showSwitch(name) {
    var select = document.getElementById('switchAccount'); select.textContent = '';
    var placeholder = el('option', '', 'Choose an account'); placeholder.value = ''; select.appendChild(placeholder);
    ((lastStatus || {}).accounts || []).forEach(function (a) {
      var option = el('option', '', providerLabel(a.provider) + ' · ' + a.name + skipSuffix(a)); option.value = a.name;
      option.setAttribute('data-provider', a.provider || ''); select.appendChild(option);
    });
    select.value = name || ''; document.getElementById('switchResult').textContent = '';
    updateSwitchHelp(); document.getElementById('switchDialog').showModal();
  }

  async function doSwitch() {
    var name = document.getElementById('switchAccount').value;
    if (!name || !connected || switchPending) return;
    switchPending = true; updateSwitchHelp();
    var generation = authGeneration;
    var result = document.getElementById('switchResult'); result.className = 'dialog-result'; result.textContent = 'Recording selection...';
    try {
      var r = switchRequest(name, SESSION_AUTH ? '' : localStorage.getItem(KEY));
      var res = await fetch(r.url, Object.assign({}, r.init, { signal: AbortSignal.timeout(12000) }));
      if (generation !== authGeneration) return;
      if (res.status === 401) { if (!SESSION_AUTH) localStorage.removeItem(KEY); showKeybox(); return; }
      var json = await res.json();
      if (generation !== authGeneration) return;
      var out = switchOutcome(json);
      result.className = 'dialog-result ' + out.kind;
      result.textContent = out.text;
      note(out.kind, result.textContent);
      await poll(true);
    } catch (e) {
      if (generation !== authGeneration) return;
      result.className = 'dialog-result error'; result.textContent = 'Could not confirm the selection. Refresh status before retrying. ' + e.message;
    } finally { switchPending = false; updateSwitchHelp(); }
  }

  function forceRowFor(name) {
    return routeRows(lastStatus || {}).filter(function (r) {
      return r.kind === 'route' && !r.autocreated && r.name === name;
    })[0] || null;
  }

  // Each member with what the operator is choosing between: how much of its
  // weekly window is gone and when the rest comes back.
  function memberOption(name, accounts) {
    var a = accounts.filter(function (x) { return x.name === name; })[0] || {};
    var q = a.quota || {};
    var used = quotaDisplay(q.unified7d, 'spent');
    var reset = parseTs(q.unified7dReset);
    var option = el('option', '', providerLabel(a.provider) + ' · ' + name + ' · weekly ' + (used == null ? 'not reported' : used + '% spent') + ' · '
      + (isNaN(reset) ? 'reset time not reported'
        : reset > Date.now() ? 'resets in ' + fmtIn((reset - Date.now()) / 1000) : 'reset time passed') + skipSuffix(a));
    option.value = name;
    option.setAttribute('data-provider', a.provider || '');
    return option;
  }

  // Why the router may skip an account, appended to its dialog option so the
  // choice is visible before it is made. Same wording as #switchHelp.
  function skipSuffix(a) {
    if (!a) return '';
    if (a.disabled) return ' · disabled';
    if (a.unavailable) return ' · ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable);
    return a.status === 'error' ? ' · sign-in needed' : '';
  }

  // The select's left border takes the chosen account's provider tint (FR 28);
  // an option cannot be colored reliably, its container can.
  function tintSelect(id, a) {
    var select = document.getElementById(id);
    if (a && a.provider) select.setAttribute('data-provider', a.provider);
    else select.removeAttribute('data-provider');
  }

  function updateForceHelp() {
    var row = forceRoute ? forceRowFor(forceRoute) : null;
    var account = document.getElementById('forceAccount').value;
    tintSelect('forceAccount', ((lastStatus || {}).accounts || []).filter(function (a) { return a.name === account; })[0]);
    document.getElementById('applyForce').disabled = !row || !account || !connected || forcePending;
    document.getElementById('forceHelp').textContent = !connected
      ? 'The proxy is disconnected. Wait for a fresh status before applying.'
      : !row ? 'This route is no longer in the latest status.'
      : !account ? 'This route has no members to force it to.'
      : 'Matching models: ' + (row.globs || []).join(', ') + '. Members: ' + (row.members || []).join(', ') + '.';
  }

  function showForce(name, opener) {
    var row = forceRowFor(name);
    if (!row) return;
    forceRoute = name; forceOpener = opener || null; forceConflictRow = null;
    forceBaseline = expectedFor(row);
    document.getElementById('forceTitle').textContent = 'Force ' + name + ' to one account';
    document.getElementById('forceRouteHelp').textContent = 'Every request this route matches goes to one account until you clear it.';
    var accounts = (lastStatus || {}).accounts || [];
    var members = row.members || [];
    var select = document.getElementById('forceAccount'); select.textContent = '';
    members.forEach(function (m) { select.appendChild(memberOption(m, accounts)); });
    var current = (row.override || {}).account;
    select.value = current && members.indexOf(current) !== -1 ? current : (forceDefaultAccount(row, accounts) || '');
    document.getElementById((row.override || {}).whenSpent === 'hold' ? 'forceHold' : 'forceFallback').checked = true;
    var result = document.getElementById('forceResult'); result.className = 'dialog-result'; result.textContent = '';
    document.getElementById('forceUseCurrent').hidden = true;
    updateForceHelp();
    document.getElementById('forceDialog').showModal();
  }

  // One path for Apply and for the row's inline Clear. The result argument is
  // the dialog's status line when the dialog is driving; the row's Clear has
  // none, so its answer goes to the page note.
  async function sendOverride(route, expected, extra, result) {
    if (!connected || forcePending) return;
    forcePending = true; updateForceHelp();
    var generation = authGeneration;
    if (result) { result.className = 'dialog-result'; result.textContent = 'Applying...'; }
    try {
      var payload = Object.assign({ route: route, expected: expected }, extra);
      var r = overrideRequest(payload, SESSION_AUTH ? '' : localStorage.getItem(KEY));
      var res = await fetch(r.url, Object.assign({}, r.init, { signal: AbortSignal.timeout(12000) }));
      if (generation !== authGeneration) return;
      if (res.status === 401) { if (!SESSION_AUTH) localStorage.removeItem(KEY); showKeybox(); return; }
      var json = await res.json();
      if (generation !== authGeneration) return;
      var out = overrideOutcome(json);
      var text = out.text;
      if (out.conflict) {
        forceConflictRow = out.row || null;
        var p = (out.row || {}).persisted || null;
        text += ' Now: ' + (p && p.account ? 'forced to ' + p.account + ' (' + (p.whenSpent === 'hold' ? 'hold' : 'falls back when spent') + ')' : 'not forced')
          + '. Matching models: ' + (((out.row || {}).match) || []).join(', ') + '.';
        if (result) document.getElementById('forceUseCurrent').hidden = !out.row;
      }
      if (result) { result.className = 'dialog-result ' + out.kind; result.textContent = text; }
      note(out.kind, text);
      if (out.kind === 'ok') {
        forceFocusRoute = route;
        if (result) document.getElementById('forceDialog').close();
      }
      await poll(true);
    } catch (e) {
      if (generation !== authGeneration) return;
      var failed = 'Could not confirm the change. Refresh status before retrying. ' + e.message;
      if (result) { result.className = 'dialog-result error'; result.textContent = failed; } else note('error', failed);
    } finally { forcePending = false; updateForceHelp(); }
  }

  function applyForce() {
    var account = document.getElementById('forceAccount').value;
    if (!forceRoute || !account) return;
    sendOverride(forceRoute, forceBaseline, {
      account: account,
      whenSpent: document.getElementById('forceHold').checked ? 'hold' : 'fallback',
    }, document.getElementById('forceResult'));
  }

  // Adopt the row the 409 came back with as the new baseline. The draft the
  // operator typed is kept; only what the page claims to have seen moves.
  function useCurrent() {
    if (!forceConflictRow) return;
    forceBaseline = expectedFor(forceConflictRow);
    forceConflictRow = null;
    document.getElementById('forceUseCurrent').hidden = true;
    var result = document.getElementById('forceResult');
    result.className = 'dialog-result';
    result.textContent = 'Using the route as it is now. Check the account and mode, then apply again.';
    updateForceHelp();
  }

  function showView() {
    var name = location.hash.slice(1) || 'overview';
    var views = { overview:['Overview','Routing & capacity','Where requests are expected to go. How much quota each account has used.'], accounts:['Accounts','Account capacity','Compare subscription limits and reset times.'], activity:['Activity','Request activity','Requests and usage observed by this proxy.'], routing:['Routing','Model routing','Server-reported targets and configured routing rules.'], resets:['Resets','Usage resets','When each limit resets, and any reset that came early.'], forecast:['Forecast','Subscription forecasts','Depletion estimates and resets at each account’s observed pace.'], diagnostics:['Diagnostics','Proxy diagnostics','Connection status, quota probes, and background jobs.'] };
    if (!views[name]) name = 'overview';
    document.getElementById('breadcrumb').textContent = 'Dashboard / ' + views[name][0];
    document.getElementById('pageTitle').textContent = views[name][1];
    document.getElementById('summary').textContent = views[name][2];
    document.querySelectorAll('[data-section]').forEach(function (section) { section.hidden = section.getAttribute('data-section').split(' ').indexOf(name) === -1; });
    document.querySelectorAll('[data-view]').forEach(function (link) { if (link.getAttribute('data-view') === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  }

  async function doControl(path, label, button) {
    button.disabled = true;
    var generation = authGeneration;
    try {
      var res = await fetch(path, {
        method: 'POST',
        headers: SESSION_AUTH ? {} : { 'x-api-key': localStorage.getItem(KEY) || '' },
        signal: AbortSignal.timeout(12000),
      });
      if (generation !== authGeneration) return;
      if (res.status === 401) { if (!SESSION_AUTH) localStorage.removeItem(KEY); showKeybox(); return; }
      var json = await res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      if (generation !== authGeneration) return;
      if (json.ok !== true) { note('error', label + ' failed' + (json.error ? ': ' + json.error : '')); return; }
      note('ok', label + ' complete');
      await poll(true);
    } catch (e) {
      if (generation === authGeneration) note('error', label + ' failed: ' + e.message);
    } finally {
      button.disabled = !connected || (path === '/teamclaude/probe' && !!((lastStatus || {}).probe || {}).running);
    }
  }

  function showKeybox() {
    authGeneration++; connected = false;
    document.querySelectorAll('dialog[open]').forEach(function (dialog) { dialog.close(); });
    if (timer) { clearInterval(timer); timer = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').value = '';
    document.getElementById('key').focus();
  }

  async function poll(force) {
    if (polling) { if (force === true) pollAgain = true; return; }
    polling = true;
    var generation = authGeneration;
    try {
      var res = await fetch('/teamclaude/status', { headers: SESSION_AUTH ? {} : { 'x-api-key': localStorage.getItem(KEY) || '' }, signal: AbortSignal.timeout(12000) });
      if (generation !== authGeneration) return;
      if (res.status === 401 || res.status === 403) { if (!SESSION_AUTH) localStorage.removeItem(KEY); showKeybox(); return; }
      if (!res.ok) throw new Error('status ' + res.status);
      var s = await res.json();
      if (generation !== authGeneration) return;
      document.getElementById('keybox').style.display = 'none';
      document.getElementById('app').style.display = '';
      document.getElementById('err').style.display = 'none';
      connected = true; lastUpdated = Date.now(); document.body.classList.remove('stale');
      document.getElementById('manualSelection').disabled = false;
      document.getElementById('routingManualSelection').disabled = false;
      document.getElementById('reload').disabled = false;
      document.getElementById('connection').textContent = 'Connected · 5s refresh';
      recordActivity(s); render(s);
      if (!timer) timer = setInterval(poll, POLL_MS);
    } catch (e) {
      if (generation !== authGeneration) return;
      connected = false; document.body.classList.add('stale');
      document.getElementById('manualSelection').disabled = true;
      document.getElementById('routingManualSelection').disabled = true;
      document.getElementById('reload').disabled = true;
      document.getElementById('probe').disabled = true;
      document.getElementById('accountManual').disabled = true; updateSwitchHelp(); updateForceHelp();
      if (document.getElementById('accountDialog').open) renderAccountDetails();
      if (lastStatus) renderRoutes(lastStatus);
      document.getElementById('connection').textContent = 'Disconnected';
      var err = document.getElementById('err'); err.style.display = 'block';
      if (lastStatus) err.textContent = 'Connection lost. ' + (lastUpdated ? 'Showing status received ' + fmtAgo(lastUpdated) + '. Routing and quota may have changed. ' : '') + e.message;
      else {
        err.textContent = 'Cannot reach the proxy: ' + e.message;
        if (document.getElementById('keybox').style.display !== 'block') document.getElementById('app').style.display = '';
      }
      document.getElementById('loginError').textContent = 'Cannot reach the proxy. Try again shortly.';
    } finally {
      polling = false;
      if (pollAgain) { pollAgain = false; if (generation === authGeneration) poll(); }
    }
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  document.getElementById('go').addEventListener('click', async function () {
    var v = document.getElementById('key').value;
    if (!v) return;
    var button = document.getElementById('go'); button.disabled = true;
    document.getElementById('loginError').textContent = '';
    try {
      if (SESSION_AUTH) {
        var res = await fetch('/teamclaude/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: v }), signal: AbortSignal.timeout(12000) });
        if (!res.ok) { var json = await res.json(); throw new Error(json.error || 'Sign-in failed'); }
      } else localStorage.setItem(KEY, v.trim());
      document.getElementById('key').value = '';
      start();
    } catch (e) { document.getElementById('loginError').textContent = e.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });
  document.getElementById('refresh').addEventListener('click', poll);
  document.getElementById('reload').addEventListener('click', function () { doControl('/teamclaude/reload', 'Config reload', this); });
  document.getElementById('probe').addEventListener('click', function () { doControl('/teamclaude/probe', 'Quota probe', this); });
  window.addEventListener('hashchange', showView);
  showView();
  document.getElementById('quotaTimezone').textContent = 'Reset times shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '.';
  ['spent', 'left'].forEach(function (mode) {
    document.getElementById(mode === 'spent' ? 'quotaSpent' : 'quotaLeft').addEventListener('click', function () {
      quotaMode = mode;
      try { localStorage.setItem('teamclaude-quota-display', mode); } catch {}
      if (lastStatus) { renderAccounts(lastStatus); renderResets(lastStatus); if (document.getElementById('accountDialog').open) renderAccountDetails(); }
    });
  });
  document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { document.getElementById(button.getAttribute('data-close')).close(); }); });
  document.getElementById('manualSelection').addEventListener('click', function () { showSwitch(); });
  document.getElementById('routingManualSelection').addEventListener('click', function () { showSwitch(); });
  document.getElementById('accountManual').addEventListener('click', function () { document.getElementById('accountDialog').close(); showSwitch(detailAccount); });
  document.getElementById('switchAccount').addEventListener('change', updateSwitchHelp);
  document.getElementById('applySwitch').addEventListener('click', doSwitch);
  document.getElementById('forceAccount').addEventListener('change', updateForceHelp);
  document.getElementById('applyForce').addEventListener('click', applyForce);
  document.getElementById('forceUseCurrent').addEventListener('click', useCurrent);
  document.getElementById('forceDialog').addEventListener('close', function () {
    var opener = forceOpener;
    forceRoute = null; forceOpener = null; forceConflictRow = null; forceBaseline = null;
    if (opener && document.contains(opener)) opener.focus();
  });
  document.getElementById('accountSearch').addEventListener('input', function () { if (lastStatus) render(lastStatus); });
  document.getElementById('logout').addEventListener('click', async function () {
    try {
      if (SESSION_AUTH) {
        var res = await fetch('/teamclaude/logout', { method: 'POST', signal: AbortSignal.timeout(12000) });
        if (!res.ok && res.status !== 401) throw new Error('Sign-out failed');
      } else localStorage.removeItem(KEY);
      authGeneration++; lastStatus = null; history = []; previousSample = null; showKeybox();
    } catch (e) { note('error', e.message); }
  });

  ['fProject', 'fClient'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

  if (SESSION_AUTH) {
    document.getElementById('loginHelp').textContent = 'Sign in to monitor account capacity and routing.';
    document.getElementById('keyLabel').textContent = 'Dashboard password';
  }
  document.getElementById('reload').hidden = SESSION_AUTH;
  document.getElementById('probe').hidden = SESSION_AUTH;
  start();
})();
</script>
</body>
</html>
`;

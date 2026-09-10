// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for once and kept in
// localStorage; a 401 (wrong or rotated key) brings the prompt back.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT } from './status-renderer.js';

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

// One row per session, from `sessions.items` (proxy.sessionDetail). The token
// columns are #192's numbers — what each response actually reported, cache
// included — summed across the weekly buckets the session touched. `pins` is a
// bucket→account map rather than one index, because a session spending two
// model families is served by two accounts at the same time.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
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
  if (!res || !res.ok) return { kind: 'error', text: 'switch failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'switched to ' + res.account + ', but rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'switched to ' + res.account };
}

// One row per route the server reports — each model family the fleet meters
// separately, autocreated or configured — plus a trailing row for everything
// else, which goes to the current account. `target` is the server's own answer
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
  if (Array.isArray(s.providerRouting)) {
    return (s.routes || []).flatMap(function (route) {
      return (route.previews || []).map(function (preview) {
        var accounts = preview.accounts || [];
        return { kind: 'route', name: route.name,
          label: (preview.provider === 'codex' ? 'Codex' : 'Claude') + ' / ' + route.name,
          match: preview.label, sampleModel: preview.model,
          target: preview.target || null, pinned: preview.pinned || null,
          pinMismatch: !!preview.pinned && preview.pinned !== preview.target,
          blocked: !!preview.blocked, autocreated: !!route.autocreated,
          eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
          ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }) };
      });
    });
  }
  var blockedModels = s.blockedModels || [];
  var rows = (s.routes || []).map(function (r) {
    var accounts = r.accounts || [];
    var name = r.name || '';
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: 'route',
      name: name,
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
      eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
      ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
    };
  });
  if (rows.length) {
    // The default row is the server's answer too (`defaultTarget`), not an
    // assumption that unrouted traffic lands on the current account: a
    // blocked or outranked current account is skipped by the next request.
    var current = s.currentAccount || null;
    var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
    rows.push({
      kind: 'default', name: '', label: 'Everything else', match: '',
      target: s.defaultTarget || current, current: current,
      currentUnavailable: (cur && cur.unavailable) || null,
      pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
    });
  }
  return rows;
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// session starves at once. Naming all of them would bury the dashboard at the
// moment it matters most; the count carries the scale, three names carry enough
// to go and ask someone.
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
      text: (r.client ? r.client + "'s session " : 'Session ') + String(r.id || '').slice(0, 8)
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more sessions are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      text: 'A session has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
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
    if (why) out.push({ severity: 'warn', kind: 'account', text: 'Account ' + a.name + ' ' + why + '.' });
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
  return Math.round((mode === 'left' ? 1 - spent : spent) * 100);
}

export function accountQuotaGroups(account) {
  var q = account.quota || {};
  var shared = [];
  if (q.unified7d != null) shared.push({ label: 'Weekly', ratio: q.unified7d, resetAt: q.unified7dReset });
  if (q.tokensLimit != null) shared.push({ label: 'Tokens', ratio: q.tokensLimit > 0 && q.tokensRemaining != null ? 1 - q.tokensRemaining / q.tokensLimit : null, resetAt: q.resetsAt });
  var session = q.unified5h == null ? [] : [{ label: '5-hour', ratio: q.unified5h, resetAt: q.unified5hReset }];
  var models = scopedWeeklyRows(q).map(function (row) {
    return { label: row.label + ' weekly', ratio: row.utilization, resetAt: row.resetAt };
  });
  Object.keys(q.codexModelBuckets || {}).forEach(function (slug) {
    var bucket = q.codexModelBuckets[slug];
    models.push({ label: (bucket.name || slug) + ' weekly', ratio: bucket.utilization, resetAt: bucket.resetAt });
  });
  return { shared: shared, session: session, models: models };
}

export function sessionActivityText(sessions) {
  if (!sessions || typeof sessions.active !== 'number') return 'Session tracking unavailable';
  return sessions.active === 0 ? 'No recent Claude session IDs observed'
    : sessions.active + ' recent Claude session ' + (sessions.active === 1 ? 'ID' : 'IDs');
}

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, routingCards, problems, quotaDisplay, accountQuotaGroups, sessionActivityText,
].map(fn => fn.toString()).join('\n\n');

// The threshold rides along: `problems` closes over it, so a page without it
// would ReferenceError on first render.
const SHARED_CONSTS = `var STARVED_MIN = ${STARVED_MIN};\nvar STARVED_LIST_MAX = ${STARVED_LIST_MAX};`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  :root { color-scheme:dark; --bg:#0d1015; --panel:#151920; --line:#2a313d; --text:#f0f2f7; --dim:#a0abba; --accent:#b5c7ff; --ok:#8cd7b0; --warn:#efc17b; --bad:#ffaaa6; }
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
  .eyebrow { color:var(--dim); font-size:11px; letter-spacing:1.4px; text-transform:uppercase; margin-bottom:8px; }
  .sub,.routing-help { color:var(--dim); font-size:13px; margin-top:8px; }
  .toolbar,.account-tools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .live { color:var(--dim); font-size:12px; }
  .route-panel { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .route-panel .section-head { padding:17px 20px; margin:0; border-bottom:1px solid var(--line); }
  .provider-routing { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  .provider-card { padding:18px 20px; border-right:1px solid var(--line); min-width:0; }
  .provider-card:last-child { border-right:0; }
  .provider-card h3 { color:var(--dim); font-size:12px; font-weight:500; margin-bottom:8px; }
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
  .account-table th:first-child { width:25%; }
  .account-table th:last-child { width:94px; }
  .account-table th:nth-child(4) { width:25%; }
  .account-table .provider-heading th { background:#1b2029; color:#dce4f2; padding:10px 16px; font-weight:600; }
  .account-table td { padding-top:20px; padding-bottom:20px; }
  .account-name { font-size:13px; font-weight:600; display:block; overflow-wrap:anywhere; margin-bottom:7px; }
  .account-meta { color:var(--dim); font-size:11px; margin-top:6px; }
  .badge { display:inline-block; font-size:11px; border-radius:5px; border:1px solid var(--line); padding:3px 7px; color:var(--dim); }
  .badge.active { color:var(--ok); background:#192c24; border-color:#2e4c3c; }
  .badge.throttled,.badge.exhausted { color:var(--warn); background:#30271e; border-color:#51412b; }
  .badge.error { color:var(--bad); border-color:#68423f; }
  .quota+.quota { margin-top:18px; }
  .quota-head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:5px 12px; margin-bottom:8px; }
  .quota .lbl { color:var(--dim); font-size:11px; overflow-wrap:anywhere; }
  .quota .val { font-size:12px; font-weight:600; white-space:nowrap; }
  .quota .val small { font-size:11px; color:var(--dim); font-weight:400; }
  .bar { height:5px; border-radius:5px; background:#303744; overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:5px; background:#a4b9eb; }
  .bar i.warn { background:#dbb16a; }
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
  #problems>div { border:1px solid #68503c; background:#282019; padding:12px 17px; border-radius:8px; margin-bottom:9px; color:var(--warn); }
  #problems>.bad { border-color:#6b4142; background:#2b1e21; color:var(--bad); }
  #note { padding:13px 17px; border:1px solid var(--line); border-radius:8px; }
  #note.warn,.dialog-result.warn { color:var(--warn); } #note.error,.dialog-result.error { color:var(--bad); }
  .stale .provider-routing { opacity:.6; }
  .stale .bar i { background:#7f8799; }
  #keybox { display:none; max-width:440px; margin:12vh auto; padding:30px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  #keybox input { width:100%; min-height:44px; margin:8px 0 16px; }
  #keybox label { display:block; margin-top:22px; }
  #keybox button { width:100%; }
  #loginError { color:var(--bad); margin-top:12px; }
  .primary { background:#c0cfff; color:#172239; border-color:#c0cfff; font-weight:600; }
  dialog { width:550px; max-width:calc(100% - 32px); max-height:calc(100dvh - 40px); color:var(--text); background:#171c24; border:1px solid #3a4556; border-radius:14px; padding:27px; }
  dialog::backdrop { background:#03060aba; backdrop-filter:blur(3px); }
  .dialog-head { display:flex; align-items:start; justify-content:space-between; gap:20px; margin-bottom:15px; }
  .dialog-head h2 { font-size:22px; overflow-wrap:anywhere; }
  .dialog-head button { padding:5px 12px; min-height:40px; }
  .dialog-help { color:var(--dim); font-size:13px; margin:14px 0 20px; }
  dialog label { display:block; font-size:12px; margin:18px 0 8px; }
  dialog select { width:100%; min-height:44px; }
  .explain { background:#202631; border:1px solid #354050; border-radius:8px; padding:14px 17px; color:#c5cedd; font-size:12px; margin:18px 0; }
  .explain ul { margin:9px 0 0; padding-left:18px; }
  .explain li+li { margin-top:8px; }
  .dialog-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:23px; }
  .dialog-result { font-size:13px; padding:13px 0; }
  #accountDetails .quota { margin:18px 0; }
  #accountDetails .quota-reset { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  #accountDetails .quota .lbl { font-size:13px; }
  .section-body>h2 { margin:26px 0 12px; }
  footer { color:var(--dim); font-size:11px; margin-top:28px; }
  @media(max-width:1150px) { .main-content { padding:26px; } #app { grid-template-columns:175px minmax(0,1fr); } .sidebar { padding:28px 12px; } .section-head { align-items:start; } .account-tools { justify-content:flex-end; } .account-table th:first-child { width:24%; } .account-table th:last-child { width:68px; } th,td { padding:14px 12px; } }
  @media(max-width:900px) { #app { grid-template-columns:minmax(0,1fr); } .sidebar { border-right:0; border-bottom:1px solid var(--line); padding:20px 24px 12px; } .nav-label { display:none; } nav { flex-direction:row; overflow:auto; margin-top:18px; } nav a { white-space:nowrap; flex-shrink:0; } .main-content { padding:24px; } .topline { flex-wrap:wrap; gap:16px; } .toolbar { width:100%; } .live { margin-right:auto; } .split { grid-template-columns:1fr; } }
  @media(max-width:650px) { .main-content { padding:23px 17px; } .sidebar { padding:20px 17px 10px; } .brand { padding:0; } h1 { font-size:27px; } .eyebrow { font-size:10px; } .section-head { flex-direction:column; align-items:stretch; } .account-tools { justify-content:space-between; } .search { flex:1; min-width:145px; width:auto; } .quota-toggle button { min-height:38px; padding:6px 13px; } .route-panel .section-head { flex-direction:row; flex-wrap:wrap; } .provider-routing { grid-template-columns:1fr; } .provider-card { border-right:0; border-bottom:1px solid var(--line); } .provider-card:last-child { border-bottom:0; } .account-table-wrap { border:0; border-radius:0; background:none; overflow:visible; } .account-table,.account-table tbody,.account-table tr,.account-table td { display:block; width:100%; } .account-table thead { display:none; } .account-table .provider-heading th { display:block; width:100%; background:none; border:0; padding:12px 0; } .account-table .account-row { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:14px; } .account-table td { border:0; padding:0 0 18px; } .account-table td:last-child { padding:0; } .account-table td[data-label]::before { content:attr(data-label); display:block; font-size:12px; color:var(--dim); margin-bottom:8px; } .account-table .quota-reset { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 10px; } .account-name { font-size:14px; } .quota .lbl,.account-meta,.quota-reset { font-size:12px; } .quota .val { font-size:13px; } .act { width:100%; border-top:1px solid var(--line); padding-top:12px; text-align:left; } .account-foot { flex-direction:column; gap:7px; } .stats { grid-template-columns:1fr; } dialog { padding:22px; } .dialog-actions button { min-height:44px; } }
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
    <nav aria-label="Dashboard sections"><a href="#overview" data-view="overview" aria-current="page">Overview</a><a href="#accounts" data-view="accounts">Accounts</a><a href="#activity" data-view="activity">Activity</a><a href="#routing" data-view="routing">Routing</a><a href="#resets" data-view="resets">Resets</a><a href="#diagnostics" data-view="diagnostics">Diagnostics</a></nav>
  </aside>
  <main id="mainContent" class="main-content">
    <header class="topline"><div><div class="eyebrow" id="breadcrumb">Dashboard / Overview</div><h1 id="pageTitle">Routing & capacity</h1><p class="sub" id="summary">Where requests are expected to go. How much quota each account has used.</p></div><div class="toolbar"><span class="live" id="connection" role="status">Connecting</span><button id="refresh">Refresh</button><button id="logout">Sign out</button></div></header>
    <div id="err" role="alert"></div><div id="problems" role="status"></div><div id="note" role="status"></div>
    <section aria-labelledby="modelRoutingTitle" id="modelRouting" class="route-panel" data-section="overview routing">
      <div class="section-head"><div><h2 id="modelRoutingTitle">Expected routing</h2><p class="sub">Representative models, based on the latest router status</p></div><button id="manualSelection">Manual selection</button></div>
      <div class="provider-routing" id="providerRouting"></div><p class="routing-help">Routing forecast, not live traffic. Existing sessions, request pins, and retries can use another account.</p>
    </section>
    <section id="accountSection" data-section="overview accounts">
      <div class="section-head"><div><h2>Account capacity <span class="tag" id="accountCount"></span></h2><p class="sub" id="quotaHelp">Bars and percentages show quota spent.</p></div><div class="account-tools"><div class="quota-toggle" role="group" aria-label="Quota display"><button id="quotaSpent" aria-pressed="true">Spent</button><button id="quotaLeft" aria-pressed="false">Left</button></div><input class="search" id="accountSearch" type="search" aria-label="Find an account" placeholder="Find an account"></div></div>
      <div id="accounts"></div><div class="account-foot"><span id="quotaTimezone"></span><span>Requests, tokens, and account controls are in Details.</span></div>
    </section>
    <section data-section="activity" hidden class="section-body">
      <div id="overview" class="stats"></div><div class="split"><section><h2>Request activity</h2><div class="card"><p class="usage">Requests observed while this page is open</p><div class="history" id="history" role="img" aria-label="Request activity"></div><p class="history-label" id="historyLabel">Collecting the first sample...</p></div></section><section><h2>Token accounting</h2><div class="card" id="tokens"></div></section></div>
      <div id="clientsWrap"><h2>Clients</h2><div class="card"><table id="clients"></table></div></div><div id="dimensionsWrap"></div>
      <section id="sessionsWrap"><h2>Claude session activity</h2><p class="sub" id="sessionActivity"></p><p class="usage">Counts only requests carrying a Claude session ID. A session remains recent for two minutes after a request, or while a request is running. Codex and requests without a session ID are not included. This does not count open apps or terminals.</p><div class="card"><div class="filters"><label>Project <select id="fProject"></select></label><label>Client <select id="fClient"></select></label><span class="hint" id="sessionCount"></span></div><table id="sessions"></table></div></section>
    </section>
    <section data-section="routing" hidden class="section-body"><div id="routesWrap"><h2>Configured routes</h2><div class="card"><table id="routes"></table></div></div></section>
    <section data-section="resets" hidden class="section-body" id="resetsSection"><h2>Usage resets</h2><p class="usage" id="resetSummary"></p><div class="split" id="resetAccounts"></div><h2>Reset history</h2><p class="usage">Historical percentages always show quota spent.</p><div id="resetEvents"></div></section>
    <section data-section="diagnostics" hidden class="section-body" id="diagnostics"><h2>Server diagnostics</h2><div class="split"><div class="card" id="serverInfo"></div><div class="card" id="routingInfo"></div></div><h2>Quota probes and warmup</h2><div class="card"><table id="jobs"></table></div></section>
    <footer id="foot"></footer>
  </main>
</div>
<dialog id="accountDialog" aria-labelledby="accountDialogTitle"><div class="dialog-head"><h2 id="accountDialogTitle">Account details</h2><button data-close="accountDialog" aria-label="Close account details">×</button></div><div id="accountDetails"></div><div class="dialog-actions"><button data-close="accountDialog">Close</button><button id="accountManual">Manual selection</button></div></dialog>
<dialog id="switchDialog" aria-labelledby="switchTitle"><div class="dialog-head"><div><div class="eyebrow">Routing control</div><h2 id="switchTitle">Select starting account</h2></div><button data-close="switchDialog" aria-label="Close manual selection">×</button></div><p class="dialog-help">Rotation continues from the selected account. Eligibility and model routes can select another account immediately.</p><label for="switchAccount">Account</label><select id="switchAccount"></select><div class="explain"><strong>What changes</strong><ul><li>The router records this starting account for rotation.</li><li>It does not pin a model or change account priority.</li><li>Existing sessions, model routes, and request pins still apply.</li></ul></div><p id="switchHelp" class="dialog-help"></p><div id="switchResult" class="dialog-result" role="status"></div><div class="dialog-actions"><button data-close="switchDialog">Close</button><button id="applySwitch" class="primary" disabled>Set starting account</button></div></dialog>
<script>
(function () {
  'use strict';
  var SESSION_AUTH = false;
  var KEY = 'teamclaude-dashboard-key';
  var quotaMode = 'spent';
  try { if (localStorage.getItem('teamclaude-quota-display') === 'left') quotaMode = 'left'; } catch {}
  var detailAccount = null;
  var switchPending = false;
  var connected = false;
  var lastUpdated = null;
  var history = [];
  var previousSample = null;
  var polling = false;
  var authGeneration = 0;
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

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

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function quotaRow(label, ratio, resetAt) {
    var row = el('div', 'quota');
    var head = el('div', 'quota-head');
    head.appendChild(el('span', 'lbl', label));
    var value = quotaDisplay(ratio, quotaMode);
    if (value == null) {
      head.appendChild(el('span', 'quota-unknown', 'Not reported'));
      row.appendChild(head);
      return row;
    }
    var val = el('span', 'val', value + '% ');
    val.appendChild(el('small', '', quotaMode));
    head.appendChild(val); row.appendChild(head);
    var bar = el('div', 'bar');
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', label + ', quota ' + quotaMode);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(value));
    var fill = el('i', ratio >= 1 ? 'warn' : ''); fill.style.width = value + '%'; bar.appendChild(fill); row.appendChild(bar);
    var reset = el('div', 'quota-reset');
    var ts = parseTs(resetAt);
    if (!isNaN(ts)) {
      reset.appendChild(el('span', '', ts > Date.now() ? 'Resets in ' + fmtIn((ts - Date.now()) / 1000) : 'Reset time passed'));
      reset.appendChild(el('span', 'quota-date', new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })));
    } else reset.textContent = 'Reset time not reported';
    row.appendChild(reset);
    return row;
  }

  function accountBadge(a) {
    var text, kind = '';
    if (a.disabled) { text = 'Disabled'; kind = 'error'; }
    else if (a.unavailable) { text = UNAVAILABLE_TEXT[a.unavailable] || a.unavailable; kind = 'throttled'; }
    else if (a.status === 'error') { text = 'Sign-in needed'; kind = 'error'; }
    else if (a.status === 'throttled' || a.status === 'exhausted') { text = a.status === 'throttled' ? 'Rate limited' : 'Quota exhausted'; kind = 'throttled'; }
    else {
      var groups = accountQuotaGroups(a);
      var quotas = groups.shared.concat(groups.session, groups.models);
      var spent = quotas.filter(function (q) { return q.ratio >= 1; });
      if (spent.length) { text = spent.map(function (q) { return q.label; }).join(', ') + ' exhausted'; kind = 'throttled'; }
      else if (quotas.some(function (q) { return quotaDisplay(q.ratio) != null; })) { text = 'Within reported limits'; kind = 'active'; }
      else text = 'Quota unknown';
    }
    return el('span', 'badge ' + kind, text);
  }

  function providerName(a) {
    return a.provider === 'anthropic' ? 'Claude' : a.provider === 'codex' ? 'Codex' : a.provider || 'Other';
  }

  function renderAccounts(s) {
    var wrap = document.getElementById('accounts'); wrap.textContent = '';
    var query = document.getElementById('accountSearch').value.toLowerCase();
    var accounts = s.accounts || [];
    var visible = accounts.filter(function (a) { return (a.name + ' ' + a.type + ' ' + providerName(a)).toLowerCase().indexOf(query) !== -1; });
    document.getElementById('accountCount').textContent = visible.length + (query ? ' of ' + accounts.length : '') + ' accounts';
    document.getElementById('quotaSpent').setAttribute('aria-pressed', String(quotaMode === 'spent'));
    document.getElementById('quotaLeft').setAttribute('aria-pressed', String(quotaMode === 'left'));
    document.getElementById('quotaHelp').textContent = 'Bars and percentages show quota ' + quotaMode + '. Each limit has its own reset.';
    if (!visible.length) { wrap.appendChild(el('div', 'empty', query ? 'No matching accounts.' : 'No accounts configured on the proxy.')); return; }
    var scroll = el('div', 'account-table-wrap');
    var table = el('table', 'account-table'); table.setAttribute('aria-label', 'Account capacity');
    var thead = el('thead'), header = el('tr');
    ['Account', 'Weekly / total quota', '5-hour quota', 'Model-specific weekly quota', ''].forEach(function (label) { var th = el('th', '', label); th.scope = 'col'; header.appendChild(th); });
    thead.appendChild(header); table.appendChild(thead);
    var providers = uniqSorted(visible.map(providerName));
    providers.forEach(function (provider) {
      var body = el('tbody'); table.appendChild(body);
      var members = visible.filter(function (a) { return providerName(a) === provider; });
      var group = el('tr', 'provider-heading'); var title = el('th', '', provider + ' / ' + members.length + ' accounts'); title.colSpan = 5; title.scope = 'rowgroup'; group.appendChild(title); body.appendChild(group);
      members.forEach(function (a) {
        var tr = el('tr', 'account-row');
        var identity = el('td'); identity.appendChild(el('span', 'account-name', a.name)); identity.appendChild(accountBadge(a));
        identity.appendChild(el('div', 'account-meta', a.type === 'oauth' ? 'Subscription' : a.type === 'api_key' ? 'API account' : a.type));
        var probe = ((s.probe || {}).accounts || []).filter(function (p) { return p.name === a.name; })[0];
        identity.appendChild(el('div', 'account-meta', probe && probe.lastProbedAt ? 'Last probe ' + fmtAgo(probe.lastProbedAt) + (probe.error ? ' · Failed' : '') : 'Quota reading time not reported'));
        tr.appendChild(identity);
        var groups = accountQuotaGroups(a);
        ['shared', 'session', 'models'].forEach(function (key, index) {
          var td = el('td'); td.setAttribute('data-label', ['Weekly / total quota','5-hour quota','Model-specific weekly quota'][index]);
          groups[key].forEach(function (q) { td.appendChild(quotaRow(q.label, q.ratio, q.resetAt)); });
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
    document.getElementById('accountManual').disabled = !connected || !a;
    if (!a) { wrap.appendChild(el('p', 'usage', 'This account is no longer in the latest status.')); return; }
    document.getElementById('accountDialogTitle').textContent = a.name;
    wrap.appendChild(accountBadge(a));
    wrap.appendChild(el('p', 'usage', providerName(a) + ' · ' + a.type + ' · Priority ' + (a.priority || 0)));
    var groups = accountQuotaGroups(a);
    groups.shared.concat(groups.session, groups.models).forEach(function (q) { wrap.appendChild(quotaRow(q.label, q.ratio, q.resetAt)); });
    var q = a.quota || {}, u = a.usage || {};
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
    ['Client', 'Requests', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
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

  var SESSION_COLUMNS = [
    { key: 'id', label: 'Session' },
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
    document.getElementById('sessionCount').textContent = rows.length + ' of ' + all.length + ' sessions';

    var table = document.getElementById('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    if (!rows.length) { var empty = el('tr'); var cell = el('td', '', 'No sessions match these filters.'); cell.colSpan = SESSION_COLUMNS.length; empty.appendChild(cell); table.appendChild(empty); }
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.id));
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

  // Provider-specific samples use the server's targets and eligibility.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var hr = el('tr');
    ['Route / sample', 'Target preview', 'Can serve sample'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
      if (r.sampleModel) fam.title = 'Representative model: ' + r.sampleModel;
      tr.appendChild(fam);
      var to = el('td', r.blocked ? 'badt' : '', r.blocked ? 'blocked' : (r.target || '—'));
      if (r.pinned) to.appendChild(el('span', 'pin', ' · pinned to ' + r.pinned));
      if (r.pinMismatch) to.appendChild(el('span', 'warnt', ' (not eligible)'));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'warnt', r.currentUnavailable
          ? ' · current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : ' · outranks the current account ' + r.current));
      }
      tr.appendChild(to);
      var can = el('td', r.kind === 'default' ? 'dim' : '');
      if (r.kind === 'default') can.textContent = 'no route of its own';
      else if (r.blocked) can.textContent = '—';
      else if (!r.eligible.length && !r.ineligible.length) can.textContent = '—';
      else {
        can.appendChild(el('span', 'ok', r.eligible.length + ' of ' + (r.eligible.length + r.ineligible.length) + (r.ineligible.length ? ' ' : '')));
        if (r.ineligible.length) can.appendChild(el('span', 'no', r.ineligible.join(', ')));
      }
      tr.appendChild(can);
      table.appendChild(tr);
    });
  }

  // Top of the page and only when something is wrong: a banner that is always
  // on is a banner nobody reads.
  function renderProblems(s) {
    var wrap = document.getElementById('problems');
    var list = problems(s);
    wrap.textContent = '';
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    list.forEach(function (p) { wrap.appendChild(el('div', p.severity, p.text)); });
  }


  function renderProviderRouting(s) {
    var wrap = document.getElementById('providerRouting'); wrap.textContent = '';
    var cards = routingCards(s);
    if (!cards.length) { wrap.appendChild(el('p', 'empty', 'Provider routing is unavailable on this proxy.')); return; }
    cards.forEach(function (provider) {
      provider.groups.forEach(function (group) {
        var card = el('div', 'provider-card'); card.setAttribute('data-provider', provider.provider);
        card.appendChild(el('h3', '', provider.label + ' · ' + group.labels.join(', ')));
        card.appendChild(el('div', 'provider-target' + (group.target ? '' : ' warnt'), group.target || (group.blocked ? 'Blocked by policy' : 'No eligible account')));
        var models = el('div', 'provider-models', group.models.join(', ')); models.title = 'Representative models'; card.appendChild(models);
        wrap.appendChild(card);
      });
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

  function resetType(value) {
    return value === 'restarted-window' ? 'Restarted window' : 'Quota refill';
  }

  function renderResets(s) {
    var data = (s.probe || {}).resets;
    var summary = document.getElementById('resetSummary');
    var accounts = document.getElementById('resetAccounts'); accounts.textContent = '';
    var history = document.getElementById('resetEvents'); history.textContent = '';
    if (!data) { summary.textContent = 'Reset tracking is unavailable on this proxy.'; return; }
    var notifications = data.notifications || {};
    summary.textContent = 'Tracking since ' + resetDate(data.startedAt) + '. ' +
      ((s.probe || {}).enabled ? 'Unexpected drops need a second probe to confirm. ' : 'Quota probes are off. History is not updating. ') +
      (notifications.enabled ? 'Google Chat enabled. ' + notifications.pending + ' notifications queued.' : 'Google Chat is off.') +
      (notifications.lastSentAt ? ' Last sent ' + resetDate(notifications.lastSentAt) + '.' : '') +
      (data.error ? ' ' + data.error : '') + (notifications.error ? ' ' + notifications.error : '');
    (data.accounts || []).forEach(function (account) {
      var card = el('div', 'card');
      card.appendChild(el('h3', '', account.name));
      var totals = account.totals || {};
      card.appendChild(el('p', '', 'Early resets: ' + (totals.early || 0) + ' · Scheduled rollovers: ' + (totals.scheduled || 0) + ' · Uncertain timing: ' + (totals.uncertain || 0)));
      var types = account.earlyTypes || {};
      card.appendChild(el('p', 'usage', 'Early restarted windows: ' + (types['restarted-window'] || 0) + ' · Early quota refills: ' + (types['quota-refill'] || 0)));
      card.appendChild(el('p', 'usage', 'Last observation: ' + resetDate(account.lastObservedAt)));
      (account.pending || []).forEach(function (pending) {
        card.appendChild(el('p', 'warnt', 'Awaiting confirmation: ' + pending.after.label + ' ' + resetType(pending.type).toLowerCase() + ', ' + Math.round(pending.before.utilization * 100) + '% to ' + Math.round(pending.after.utilization * 100) + '%.'));
      });
      if (account.provider === 'codex') {
        var inventory = account.credits;
        card.appendChild(el('p', '', inventory ? 'Banked resets: ' + inventory.availableCount + ' available at last check' : 'Banked resets: unknown'));
        if (inventory) {
          card.appendChild(el('p', 'usage', 'Credit inventory checked: ' + resetDate(inventory.observedAt)));
          inventory.credits.filter(function (credit) { return credit.status === 'available'; }).forEach(function (credit) {
            card.appendChild(el('p', 'usage', (credit.title || credit.resetType) + ' · ' + (credit.expiresAt ? (credit.expiresAt <= Date.now() ? 'Expired ' : 'Expires ') + resetDate(credit.expiresAt) : 'No expiry reported')));
          });
        }
        if (account.creditError) card.appendChild(el('p', 'warnt', account.creditError + '. Showing the last successful inventory.'));
      } else card.appendChild(el('p', 'usage', 'Banked reset inventory is not reported by this provider.'));
      accounts.appendChild(card);
    });
    if (!(data.accounts || []).length) accounts.appendChild(el('p', 'usage', 'Waiting for the first successful quota probe.'));
    history.appendChild(el('p', 'usage', 'Latest 500 events. Counts include older events. Times use the browser timezone. Detection is inferred from provider readings; small drops and long gaps are not counted.'));
    if (!(data.events || []).length) history.appendChild(el('p', 'usage', 'No resets detected yet.'));
    (data.events || []).forEach(function (event) {
      var card = el('div', 'card');
      card.appendChild(el('h3', '', event.account + ' · ' + (event.timing === 'scheduled' ? 'Scheduled rollover' : event.timing === 'early' ? 'Early reset' : 'Reset with uncertain timing')));
      (event.windows || []).forEach(function (window) {
        card.appendChild(el('p', '', window.after.label + ' · ' + resetType(window.type) + ' · ' + Math.round(window.before.utilization * 100) + '% → ' + Math.round(window.after.utilization * 100) + '%'));
        card.appendChild(el('p', 'usage', 'Observed between ' + resetDate(window.before.at) + ' and ' + resetDate(window.after.at)));
        card.appendChild(el('p', 'usage', 'Reset time: ' + resetDate(window.before.resetAt) + ' → ' + resetDate(window.after.resetAt)));
      });
      history.appendChild(card);
    });
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

  function render(s) {
    lastStatus = s;
    renderProviderRouting(s);
    renderAccounts(s);
    if (document.getElementById('accountDialog').open) renderAccountDetails();
    if (document.getElementById('switchDialog').open) updateSwitchHelp();
    renderOverview(s);
    renderDiagnostics(s);
    renderResets(s);
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
    }
    document.getElementById('switchHelp').textContent = help;
  }

  function showSwitch(name) {
    var select = document.getElementById('switchAccount'); select.textContent = '';
    var placeholder = el('option', '', 'Choose an account'); placeholder.value = ''; select.appendChild(placeholder);
    ((lastStatus || {}).accounts || []).forEach(function (a) { var option = el('option', '', a.name + ' · ' + providerName(a)); option.value = a.name; select.appendChild(option); });
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
      if (res.status === 401) { showKeybox(); return; }
      var json = await res.json();
      if (generation !== authGeneration) return;
      var out = switchOutcome(json);
      result.className = 'dialog-result ' + out.kind;
      result.textContent = out.kind === 'ok' ? 'Starting account recorded: ' + json.account + '. Normal routing still applies.' : out.text;
      note(out.kind, result.textContent);
      await poll();
    } catch (e) {
      if (generation !== authGeneration) return;
      result.className = 'dialog-result error'; result.textContent = 'Could not confirm the selection. Refresh status before retrying. ' + e.message;
    } finally { switchPending = false; updateSwitchHelp(); }
  }

  function showView() {
    var name = location.hash.slice(1) || 'overview';
    var views = { overview:['Overview','Routing & capacity','Where requests are expected to go. How much quota each account has used.'], accounts:['Accounts','Account capacity','Compare subscription limits and reset times.'], activity:['Activity','Request activity','Requests and usage observed by this proxy.'], routing:['Routing','Model routing','Server-reported targets and configured routing rules.'], resets:['Resets','Usage resets','Observed quota resets and banked reset inventory.'], diagnostics:['Diagnostics','Proxy diagnostics','Connection status, quota probes, and background jobs.'] };
    if (!views[name]) name = 'overview';
    document.getElementById('breadcrumb').textContent = 'Dashboard / ' + views[name][0];
    document.getElementById('pageTitle').textContent = views[name][1];
    document.getElementById('summary').textContent = views[name][2];
    document.querySelectorAll('[data-section]').forEach(function (section) { section.hidden = section.getAttribute('data-section').split(' ').indexOf(name) === -1; });
    document.querySelectorAll('[data-view]').forEach(function (link) { if (link.getAttribute('data-view') === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
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

  async function poll() {
    if (polling) return;
    polling = true;
    var generation = authGeneration;
    try {
      var res = await fetch('/teamclaude/status', { headers: SESSION_AUTH ? {} : { 'x-api-key': localStorage.getItem(KEY) || '' }, signal: AbortSignal.timeout(12000) });
      if (generation !== authGeneration) return;
      if (res.status === 401) { if (!SESSION_AUTH) localStorage.removeItem(KEY); showKeybox(); return; }
      if (!res.ok) throw new Error('status ' + res.status);
      var s = await res.json();
      if (generation !== authGeneration) return;
      document.getElementById('keybox').style.display = 'none';
      document.getElementById('app').style.display = '';
      document.getElementById('err').style.display = 'none';
      connected = true; lastUpdated = Date.now(); document.getElementById('app').classList.remove('stale');
      document.getElementById('manualSelection').disabled = false;
      document.getElementById('connection').textContent = 'Connected · 5s refresh';
      recordActivity(s); render(s);
      if (!timer) timer = setInterval(poll, POLL_MS);
    } catch (e) {
      if (generation !== authGeneration) return;
      if (!lastStatus) showKeybox();
      connected = false; document.getElementById('app').classList.add('stale');
      document.getElementById('manualSelection').disabled = true;
      document.getElementById('accountManual').disabled = true; updateSwitchHelp();
      document.getElementById('connection').textContent = 'Disconnected';
      var err = document.getElementById('err'); err.style.display = 'block';
      err.textContent = 'Connection lost. ' + (lastUpdated ? 'Showing status received ' + fmtAgo(lastUpdated) + '. Routing and quota may have changed. ' : '') + e.message;
      document.getElementById('loginError').textContent = 'Cannot reach the proxy. Try again shortly.';
    } finally { polling = false; }
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
  window.addEventListener('hashchange', showView);
  showView();
  document.getElementById('quotaTimezone').textContent = 'Reset times shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '.';
  ['spent', 'left'].forEach(function (mode) {
    document.getElementById(mode === 'spent' ? 'quotaSpent' : 'quotaLeft').addEventListener('click', function () {
      quotaMode = mode;
      try { localStorage.setItem('teamclaude-quota-display', mode); } catch {}
      if (lastStatus) { renderAccounts(lastStatus); if (document.getElementById('accountDialog').open) renderAccountDetails(); }
    });
  });
  document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { document.getElementById(button.getAttribute('data-close')).close(); }); });
  document.getElementById('manualSelection').addEventListener('click', function () { showSwitch(); });
  document.getElementById('accountManual').addEventListener('click', function () { document.getElementById('accountDialog').close(); showSwitch(detailAccount); });
  document.getElementById('switchAccount').addEventListener('change', updateSwitchHelp);
  document.getElementById('applySwitch').addEventListener('click', doSwitch);
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
    start();
  } else if (localStorage.getItem(KEY)) start(); else showKeybox();
})();
</script>
</body>
</html>
`;

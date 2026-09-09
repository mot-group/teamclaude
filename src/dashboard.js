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
export function routeRows(status) {
  var s = status || {};
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

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, problems,
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
  :root {
    --bg: #0d1117; --panel: #151c25; --line: #2b3542;
    --text: #edf1f5; --dim: #a1adba; --accent: #7ed6c4;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; }
  main { max-width: 1360px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 24px 0 8px; }
  .sub { color: var(--dim); margin-bottom: 16px; }
  .sub b { color: var(--text); font-weight: 600; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted { color: var(--bad); border-color: var(--bad); }
  .badge.current { color: var(--accent); border-color: var(--accent); }
  .quota { display: grid; grid-template-columns: 64px 1fr 170px; gap: 8px; align-items: center; margin-top: 6px; }
  .quota .lbl { color: var(--dim); font-size: 12px; }
  .quota .val { color: var(--dim); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: var(--ok); }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .usage { color: var(--dim); font-size: 12px; margin-top: 6px; }
  .blocked { color: var(--warn); font-size: 12px; margin-top: 6px; }
  .act { font: inherit; font-size: 12px; padding: 1px 10px; border-radius: 999px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-left: auto; }
  .act:hover { background: var(--accent); color: var(--bg); }
  .act:disabled { opacity: .5; cursor: default; }
  #note { font-size: 12px; margin: 8px 0; display: none; }
  #note.ok { color: var(--ok); } #note.warn { color: var(--warn); } #note.error { color: var(--bad); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .filters select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 4px 8px; }
  .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  td.dim { color: var(--dim); }
  .ok { color: var(--ok); }
  .no { color: var(--dim); text-decoration: line-through; }
  .pin { color: var(--accent); font-size: 12px; }
  .warnt { color: var(--warn); font-size: 12px; }
  .badt { color: var(--bad); }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #problems { display: none; margin: 0 0 16px; }
  #problems div { border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; font-size: 13px; }
  #problems .bad { background: rgba(248,81,73,.12); border: 1px solid var(--bad); color: var(--bad); }
  #problems .warn { background: rgba(210,153,34,.12); border: 1px solid var(--warn); color: var(--warn); }
  #keybox { display: none; margin: 40px auto; max-width: 420px; text-align: center; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #06121f; font: inherit; font-weight: 600; cursor: pointer; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; }

  html { scroll-behavior: smooth; scroll-padding-top: 24px; }
  body { padding: 36px; }
  h1 { font-size: 30px; letter-spacing: -.04em; font-weight: 650; }
  h2 { font-size: 16px; text-transform: none; letter-spacing: -.01em; color: var(--text); margin-top: 32px; }
  .eyebrow { color: var(--accent); font: 11px ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 10px; }
  .topline { display:flex; justify-content:space-between; align-items:center; gap:20px; }
  .toolbar, nav { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button, input, select { font:inherit; }
  .toolbar button, .search, nav a { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:10px 14px; min-height:44px; }
  button { cursor:pointer; }
  button:hover, nav a:hover { border-color:var(--accent); }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, th:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  nav { margin:20px 0 28px; border-bottom:1px solid var(--line); padding-bottom:18px; }
  nav a { text-decoration:none; font-size:13px; background:transparent; border-color:transparent; }
  .live { color:var(--accent); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin:24px 0; }
  .metric { padding:20px; border:1px solid var(--line); border-radius:10px; background:var(--panel); }
  .metric strong { display:block; font-size:32px; font-weight:600; letter-spacing:-.04em; margin:8px 0; font-variant-numeric:tabular-nums; }
  .metric small { color:var(--dim); font-size:12px; }
  .metric-label { color:var(--dim); font-size:13px; }
  .split { display:grid; grid-template-columns:1.3fr 1fr; gap:20px; }
  #accounts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
  #accounts .card { margin:0; padding:20px; }
  .card { border-radius:10px; overflow-x:auto; }
  .card .name { overflow-wrap:anywhere; }
  .card .row { margin-bottom:16px; }
  .quota { grid-template-columns:58px minmax(40px,1fr) 165px; margin-top:12px; }
  .act { min-height:36px; margin-top:4px; }
  th, td { padding:12px; font-size:13px; }
  th { white-space:nowrap; }
  .section-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:30px 0 14px; }
  .section-head h2 { margin:0; }
  .search { width:220px; }
  .details { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .details dt { color:var(--dim); font-size:12px; }
  .details dd { font-size:14px; overflow-wrap:anywhere; }
  .empty { padding:24px; color:var(--dim); border:1px dashed var(--line); border-radius:8px; }
  #keybox { text-align:left; margin:12vh auto; padding:32px; border:1px solid var(--line); border-radius:14px; background:var(--panel); }
  #keybox h1 { margin-bottom:12px; }
  #keybox button { width:100%; min-height:44px; }
  #loginError { color:var(--bad); margin-top:12px; }
  .history { height:90px; display:flex; align-items:end; gap:3px; margin:20px 0 12px; }
  .history i { flex:1; background:var(--accent); border-radius:3px 3px 0 0; min-height:2px; }
  .history-label { color:var(--dim); font-size:12px; }
  #err { padding:12px; border:1px solid var(--bad); border-radius:8px; }
  .usage { line-height:1.8; margin-top:14px; }
  @media(max-width:1000px) { .split { grid-template-columns:1fr; } .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } #accounts { grid-template-columns:1fr; } }
  @media(max-width:600px) { body { padding:18px; } .topline { align-items:start; flex-direction:column; } h1 { font-size:26px; } .metric { padding:14px; } .metric strong { font-size:27px; } .quota { grid-template-columns:48px minmax(30px,1fr) 150px; gap:5px; } .section-head { align-items:start; flex-direction:column; } nav { gap:0; } nav a { padding:10px; } #keybox { padding:24px; } }
  @media(prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
</style>
</head>
<body>
<main>
  <div id="keybox">
    <div class="eyebrow">Private workspace</div>
    <h1>TeamClaude</h1>
    <p class="sub" id="loginHelp">Enter your proxy key to view status.</p>
    <label for="key" id="keyLabel">Proxy key</label>
    <input id="key" type="password" autocomplete="current-password">
    <button id="go">Sign in</button>
    <p id="loginError" role="alert"></p>
  </div>
  <div id="app" style="display:none">
    <div class="topline">
      <div><div class="eyebrow">Subscription routing / Operations</div><h1>TeamClaude overview</h1></div>
      <div class="toolbar"><span class="live" id="connection" role="status">Connecting</span><button id="refresh">Refresh</button><button id="logout">Sign out</button></div>
    </div>
    <p class="sub" id="summary"></p>
    <nav aria-label="Dashboard sections"><a href="#overview">Overview</a><a href="#accountSection">Accounts</a><a href="#routesWrap">Routing</a><a href="#sessionsWrap">Sessions</a><a href="#diagnostics">Diagnostics</a></nav>
    <div id="overview" class="stats"></div>
    <div id="err"></div>
    <div id="problems"></div>
    <div id="note"></div>
    <div class="split">
      <section><h2>Request activity</h2><div class="card"><p class="usage">Requests observed while this page is open</p><div class="history" id="history" role="img" aria-label="Request activity"></div><p class="history-label" id="historyLabel">Collecting the first sample...</p></div></section>
      <section><h2>Token accounting</h2><div class="card" id="tokens"></div></section>
    </div>
    <div id="routesWrap" style="display:none">
      <h2>Routing</h2>
      <div class="card" style="padding:4px 6px"><table id="routes"></table></div>
    </div>
    <div class="section-head" id="accountSection"><h2>Account capacity</h2><input class="search" id="accountSearch" type="search" aria-label="Search accounts" placeholder="Search accounts"></div>
    <div id="accounts"></div>
    <div id="clientsWrap" style="display:none">
      <h2>Clients</h2>
      <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
    </div>
    <div id="dimensionsWrap"></div>
    <div id="sessionsWrap" style="display:none">
      <h2>Sessions</h2>
      <div class="card" style="padding:0">
        <div class="filters">
          <label>Project <select id="fProject"></select></label>
          <label>Client <select id="fClient"></select></label>
          <span class="hint" id="sessionCount"></span>
        </div>
        <div style="padding:4px 6px"><table id="sessions"></table></div>
      </div>
    </div>
    <section id="diagnostics"><h2>Server diagnostics</h2><div class="split"><div class="card" id="serverInfo"></div><div class="card" id="routingInfo"></div></div><h2>Quota probes and warmup</h2><div class="card"><table id="jobs"></table></div></section>
    <footer id="foot"></footer>
  </div>
</main>
<script>
(function () {
  'use strict';
  var SESSION_AUTH = false;
  var KEY = 'teamclaude-dashboard-key';
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
    row.appendChild(el('span', 'lbl', label));
    var bar = el('div', 'bar');
    var fill = el('i');
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct == null ? 0 : pct * 100) + '%';
    if (pct != null && pct >= 0.9) fill.className = 'bad';
    else if (pct != null && pct >= 0.7) fill.className = 'warn';
    bar.appendChild(fill);
    row.appendChild(bar);
    var resetTs = parseTs(resetAt);
    var reset = !isNaN(resetTs) && resetTs > Date.now()
      ? ' · ' + fmtIn((resetTs - Date.now()) / 1000) + ' · ' + fmtClock(resetTs)
      : '';
    row.appendChild(el('span', 'val', (pct == null ? '?' : Math.round(pct * 100) + '%') + reset));
    return row;
  }

  function renderAccount(a, current) {
    var card = el('div', 'card');
    var head = el('div', 'row');
    head.appendChild(el('span', 'name', a.name));
    head.appendChild(el('span', 'tag', a.type + ' · prio ' + (a.priority || 0)));
    if (a.name === current) head.appendChild(el('span', 'badge current', 'current'));
    head.appendChild(el('span', 'badge ' + (a.status || ''), a.disabled ? 'disabled' : (a.status || 'unknown')));
    if (a.sessions) head.appendChild(el('span', 'tag', a.sessions + ' active session' + (a.sessions > 1 ? 's' : '')));
    // Last in the row so the badges sit in the same place on every card.
    if (a.name !== current) {
      var btn = el('button', 'act', 'switch');
      btn.addEventListener('click', function () { doSwitch(a.name, btn); });
      head.appendChild(btn);
    }
    card.appendChild(head);
    if (a.unavailable) card.appendChild(el('div', 'blocked', 'blocked: ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable)));
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      card.appendChild(quotaRow('Session', q.unified5h, q.unified5hReset));
      card.appendChild(quotaRow('Weekly', q.unified7d, q.unified7dReset));
      // Model-scoped weekly buckets are learned from the usage endpoint rather
      // than declared, so hard-coding the two families that have dedicated
      // fields drew an incomplete picture the moment upstream metered a third.
      scopedWeeklyRows(q).forEach(function (r) { card.appendChild(quotaRow(r.label, r.utilization, r.resetAt)); });
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      card.appendChild(quotaRow('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      card.appendChild(el('div', 'usage', 'Quota not reported by the proxy.'));
    }
    var u = a.usage || {};
    var last = u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '';
    if (q.spend) { var spend = q.spend; card.appendChild(el('div', 'usage', 'Extra usage: ' + (spend.enabled ? 'enabled' : 'disabled') + ' · ' + (spend.currency || 'USD') + ' ' + ((spend.usedMinor || 0) / Math.pow(10, spend.exponent == null ? 2 : spend.exponent)).toFixed(2) + ' spent this month')); }
    card.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + last));
    return card;
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
    // Absent unless proxy.sessionDetail is on — the aggregate counts in the
    // summary line stay either way.
    if (!sessions || !sessions.items) { wrap.style.display = ''; document.querySelector('#sessionsWrap .filters').style.display = 'none'; emptyTable('sessions', 'Session details are disabled on the proxy. Aggregate session counts appear in the overview.'); return; }
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

  // Where each metered family goes right now, and which accounts could take
  // it. The last row is the default: everything without its own route lands
  // on the current account.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var hr = el('tr');
    ['Family', 'Goes to', 'Can serve it'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
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


  function renderOverview(s) {
    var accounts = s.accounts || [];
    var requests = accounts.reduce(function (sum, a) { return sum + ((a.usage || {}).totalRequests || 0); }, 0);
    var tokens = accounts.reduce(function (sum, a) { return sum + accountTokens(a.usage); }, 0);
    var ready = accounts.filter(function (a) { return !a.unavailable && !a.disabled && a.status !== 'error'; }).length;
    var wrap = document.getElementById('overview'); wrap.textContent = '';
    [['Available accounts', ready + ' / ' + accounts.length, 'Eligibility varies by model family'],
      ['Requests', fmtNum(requests), 'Cumulative account counters'],
      ['Tokens reported', fmtNum(tokens), 'Includes cache reads and writes'],
      ['Active sessions', String((s.sessions || {}).active || 0), ((s.sessions || {}).known || 0) + ' sessions tracked']].forEach(function (m) {
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

  function renderDiagnostics(s) {
    var server = s.server || {}, loop = server.eventLoop || {}, pool = s.upstreamPool || {};
    details('serverInfo', [['Proxy uptime', server.uptimeSeconds == null ? null : fmtIn(server.uptimeSeconds)], ['Proxy port', server.port], ['Event loop lag', loop.lastLagMs == null ? null : loop.lastLagMs + ' ms'], ['Worst lag', loop.maxLagMs == null ? null : loop.maxLagMs + ' ms'], ['Active upstream requests', pool.active], ['Queued upstream requests', pool.queued]]);
    details('routingInfo', [['Default target', s.defaultTarget || s.currentAccount || 'None'], ['Switch threshold', s.switchThreshold == null ? null : Math.round(s.switchThreshold * 100) + '%'], ['Session distribution', (s.sessions || {}).mode || 'off'], ['Blocked models', (s.blockedModels || []).join(', ') || 'None'], ['Quota probes', s.probe && s.probe.enabled ? 'Every ' + fmtIn(s.probe.intervalSeconds) : 'Off'], ['Warmup', s.warm && s.warm.enabled ? s.warm.mode || 'On' : 'Off']]);
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
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    sum.appendChild(el('span', '', 'active account '));
    sum.appendChild(el('b', '', s.currentAccount || 'none'));
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known sessions' + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    var query = document.getElementById('accountSearch').value.toLowerCase();
    var visible = (s.accounts || []).filter(function (a) { return (a.name + ' ' + a.type).toLowerCase().indexOf(query) !== -1; });
    visible.forEach(function (a) { acc.appendChild(renderAccount(a, s.currentAccount)); });
    if (!visible.length) acc.appendChild(el('div', 'empty', query ? 'No matching accounts.' : 'No accounts configured on the proxy.'));
    renderOverview(s);
    renderDiagnostics(s);
    renderProblems(s);
    renderRoutes(s);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    renderSessions(s.sessions);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
  }

  function note(kind, text) {
    var n = document.getElementById('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
  }

  // One manual switch. The endpoint is a nudge, not a pin: it sets the current
  // account and normal rotation resumes from there (see the handler's comment
  // in server.js for what "eligible" means).
  function doSwitch(name, btn) {
    btn.disabled = true;
    var r = switchRequest(name, SESSION_AUTH ? '' : localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = switchOutcome(json);
        note(out.kind, out.text);
        // Re-enabled on any non-success, whether the server refused or the
        // fetch threw, so the two failure paths leave the button in one state.
        if (out.kind !== 'ok') btn.disabled = false;
        poll();
      })
      .catch(function (e) { note('error', 'switch failed: ' + e.message); btn.disabled = false; });
  }

  function showKeybox() {
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
      document.getElementById('connection').textContent = 'Live · 5s refresh';
      recordActivity(s); render(s);
      if (!timer) timer = setInterval(poll, POLL_MS);
    } catch (e) {
      document.getElementById('connection').textContent = 'Disconnected';
      var err = document.getElementById('err'); err.style.display = 'block';
      err.textContent = 'Cannot reach the proxy. Displayed values may be stale. ' + e.message;
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

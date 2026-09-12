# Route override: implementation plan

Base: `origin/master` at bebce98. Branch `claude/route-override`. Design and
critique history: `dashboard-routing-configurator.md` in this folder. Decisions
taken by the owner: configured routes only (no auto-row materialisation); hold
answers a 429 immediately and never enters the `holdSeconds` wait; the CLI
cross-process race is documented, not locked.

Master already has provider-aware previews (`previewRouteIndex(model, advisor,
provider)`, `getRoutes()` with per-pattern `previews`, `src/routing-preview.js`)
and a redesigned dashboard with a `<dialog>` pattern (`switchDialog`). Build on
those; do not reintroduce the older dashboard shapes described in the design
doc's UI section.

## Feature, in one paragraph

A route in `config.routes[]` may carry `override: { account, whenSpent, since }`.
While present, every request the route matches is sent to `account`. With
`whenSpent: "fallback"`, when that account cannot serve (over threshold,
rate-limit hold, entitlement cooldown, error, disabled), selection runs the
normal walk over the route's other members and returns to the forced account
as soon as it is eligible. With `whenSpent: "hold"`, no other member may serve
the route; a request that finds the forced account unavailable gets the
synthetic 429 immediately, with a retry-after derived from that account's known
timestamps. The dashboard sets and clears the field through one endpoint. TUI
route pins stay runtime-only and lose to a config override on reload.

## Work packages

Three workers, one worktree (`/home/zi/Code/teamclaude-claude-route-override`),
disjoint files, no commits by workers. The orchestrator commits, pushes, opens
the PR and runs the review loop.

### WP1: engine, normaliser, writers (first, alone)

Files: `src/routes.js` (new), `src/account-manager.js`, `src/tui.js`,
`src/index.js` (routeCommand and the TUI save hook only), `src/account-pairing.js`
(`mergeAccountsForSave` for `models`), `src/sync-accounts.js` (carry `models`),
`test/routes.test.js` (new), `test/route-pin.test.js`, `test/tui-routes.test.js`,
`test/cli-route.test.js`.

1. `src/routes.js`:
   - `ROUTE_BUCKETS = ['unified7d', 'unified7dFable', 'unified7dSonnet']`.
   - `normalizeRoutes(routes, accounts) -> { routes, warnings }`. Total, never
     throws. Coerce `match` to non-empty strings, drop a route with none.
     Duplicate configured names: keep the first, drop later ones, warn.
     `bucket` outside `ROUTE_BUCKETS`: drop the field, warn. `override`:
     `account` must name an existing account that is a member of this route
     (`routeMembers`); `whenSpent` in `['fallback', 'hold']`; `since` a finite
     number or absent. Otherwise drop the override, keep the route, warn. Keep
     unknown fields (`color`, anything else) untouched.
   - `routeMembers(route, accounts)`: accounts named in `route.accounts` (by
     name or index string, the existing convention), or all accounts when the
     list is empty. No model lookup.
   - `pinId(route)` helpers: `configured:<name>` and `auto:<family>`.
2. `AccountManager`:
   - `setRoutes(routes)` runs `normalizeRoutes`, stores the result, returns
     `warnings`. Callers that log: server start and `reloadAccounts` in
     `index.js` (WP1 touches only the logging line there).
   - `routePins`: keyed by pin id. Value `{ index, whenSpent, source, lastServed }`,
     `source` `'config'` or `'tui'`. Update every reader: `_pinnedFor`,
     `_pinnedName`, `getRoutePin`, `removeAccount` (remap `index` and
     `lastServed`, drop entries on the removed account), `setRoutes` cleanup of
     pins whose configured route no longer exists (keep the existing test).
   - Reconciliation in `setRoutes`: delete every `'config'` entry; seed from
     each normalised `override` (`whenSpent` from config, `lastServed: null`);
     a config entry replaces a `'tui'` entry with the same id; other `'tui'`
     entries survive if their route still exists.
   - `setRoutePin(id, index, { whenSpent = 'fallback', source = 'tui' })`:
     validate the account is in `routeMembers` of the id's route (auto ids:
     any account). Returns `{ ok, reason? }`. `clearRoutePin(id)` refuses a
     `'config'` entry with `{ ok: false, reason }` naming the dashboard.
     `clearAnyPin(id)` removes regardless of source. `getRoutePin(id)`.
   - `_pinServes(pin, model, advisorModel, exclude)`: the account exists,
     `_isAvailable(account, model, advisorModel)`, and `!exclude?.has(index)`.
     Use it in the pin fast path (same behaviour as today) and in the
     session-distribution bypass at the top of `_pickActiveAccount`, which
     today tests pin existence only. Add the A/B affinity test and the
     A-excluded/C-affinity test from the design doc.
   - `_routeAllows(account, model)`: existing logic, then if the matching
     route (or auto family) has a live pin with `whenSpent === 'hold'`, only
     `account.index === pin.index` passes. Hold never widens membership.
   - Ramp: when the pin fast path returns account X and `pin.lastServed !== X`,
     call `_joinPolicyRamp(X)` and set `lastServed = X`. When any selection for
     a model whose route has a pin returns an account other than the pin's,
     set `lastServed = null` so the return to the forced account ramps again.
   - `holdRetryAfterMs(model, now = Date.now())`: for the live hold pin on the
     model's route, the earliest known future timestamp on the forced account
     among `rateLimitedUntil`, `entitlementDeniedUntil`, `quota.resetsAt`,
     `quota.unified5hReset`, `quota.unified7dReset`, and the family or scoped
     weekly reset governing `model`; `null` when none is known or no hold pin
     governs. Meaning: next worthwhile recheck.
   - `hasOwnershipClaims()`: true when any live account has a non-empty
     `models` array.
   - `getRoutes()`: each configured row gains `id`, `override` (effective
     runtime pin: `{ account, whenSpent, source, since, state, reason }` with
     `state` in `effective | unavailable | holding | no-target`, computed
     against the override account's provider using the existing preview), and
     `persisted` (`{ account, whenSpent }` from the normalised table, or null).
     Auto rows gain `id` and `override` (runtime TUI pin only), `persisted: null`.
     Status gains `forceBlocked: { reason: 'ownership-claims' } | null` at top
     level (via `getStatus`).
   - Advisor precedence unchanged: the executor's pin decides; the advisor's
     pin only when the executor is unpinned. Hold plus an unroutable advisor
     takes the existing executor-only degradation. One test each.
3. `src/tui.js`: pin ids in switch mode (`_doSwitchSelection` builds
   `configured:`/`auto:` ids, consumes `clearRoutePin`'s result, logs a refusal
   and stays in switch mode). `_routeSave` and `_routeDelete`: inside one
   `atomicConfigUpdate`, re-read disk, find the route by the name captured when
   editing began, spread it, apply the draft (delete `accounts`, `bucket`,
   `color` when the draft clears them; never touch `override`), normalise; after
   the write commits, assign the committed table to `config.routes` and call
   `am.setRoutes`. No publish before commit. The TUI `saveConfig` hook in
   `index.js` stops assigning `diskConfig.routes`.
4. `src/index.js` `routeCommand add`: spread the freshly loaded on-disk route
   so `override` survives. `route list` prints `forced → <account> (<mode>)`.
5. `mergeAccountsForSave` (`src/account-pairing.js`): do not resurrect a
   `models` field that disk no longer has. `syncAccountsFromDisk`: update or
   delete `models` on existing manager accounts from disk.
6. Tests: every bullet above has at least one. Keep all existing tests green.
   `npm test` and `npm run lint` clean.

### WP2: endpoint, hooks, hold 429, LAN dashboard forwarding (after WP1)

Files: `src/server.js`, `src/index.js` (hooks in both `serverCommand` branches,
`reloadAccounts` queue), `src/dashboard-server.js`,
`test/route-override-endpoint.test.js` (new), `test/dashboard-server.test.js`.

1. `POST /teamclaude/routes/override`, same gates as `/switch` (key gate,
   loopback same-origin rule, `readControlBody`):
   ```
   { "route": "<configured route name>", "expected": { "match": [...], "accounts": [...], "persisted": {...}|null },
     "account": "<name>", "whenSpent": "fallback"|"hold" }
   { "route": "<name>", "expected": {...}, "clear": true }
   200 { ok: true, row: <getRoutes() row>, persisted: true, applied: true, warnings: [] }
   400 { ok: false, errors: [{ field, message }] }      // validation, ownership claims (Clear exempt)
   404 { ok: false, error: "no such route" }            // auto rows are 404 too: configured only
   409 { ok: false, error: "changed elsewhere", row }   // expected mismatch
   500 { ok: false, persisted: true|false, applied: false, error: "reload failed; see the proxy log" }
   ```
   `expected` comparison is canonical: `match` as the normalised array,
   `accounts` as the normalised array (index strings kept as strings),
   `persisted` as `{ account, whenSpent }` or null.
2. `hooks.saveOverride({ route, expected, override | null })` in `index.js`,
   wired in both the TUI and headless branches. One in-process promise queue
   serialises `saveOverride` and `reloadAccounts` (wrap `reloadAccounts` so the
   TUI `R` key, the CLI notify and `POST /reload` all go through it). Order:
   `atomicConfigUpdate` (precondition on the re-read normalised table, edit
   `routes[i].override`, set `since`, or delete it; no runtime mutation), then
   on commit `clearAnyPin(id)` for a clear, then `reloadAccounts()`. Reply
   `persisted`/`applied` as above.
3. Hold 429: in `forwardRequest`, when selection returns nothing and
   `accountManager.holdRetryAfterMs(model)` is non-null (a hold pin governs),
   answer the synthetic 429 immediately with that retry-after (seconds,
   clamped to at least 1) and a message saying the route is held on the
   account; never enter the `holdSeconds` wait for a held route. With no hold
   pin, existing behaviour.
4. `src/dashboard-server.js`: allow `POST /teamclaude/routes/override` with
   the same JSON gate as `/switch`; validate shape (route string ≤256,
   account string ≤256 or `clear: true`, `whenSpent` in the two words,
   `expected` object) and forward a re-serialised body.
5. Tests: loopback same-origin POST writes through the hook and reloads; key
   gate with a non-loopback address via the exported gate function; cross-origin
   with a valid key rejected; `Origin` only rejected; 413; 400 invalid JSON; 400
   ownership claims with Clear exempt; 404 for an auto row; 409 on each part of
   `expected`; disk write failure leaves the runtime pin; reload failure answers
   `persisted: true, applied: false`; a queued reload cannot interleave; hold
   429 immediate with the computed retry-after; the LAN dashboard forwards the
   new POST and rejects bad shapes.

### WP3: dashboard UI and docs (parallel with WP2)

Files: `src/dashboard.js`, `test/dashboard.test.js`, `docs/routing.md`,
`docs/usage.md`.

1. Routing table (`renderRoutes`): configured rows get a `Force…` button
   (accessible name "Force route <name>", `aria-haspopup="dialog"`); forced
   rows get `Change…` and `Clear force`. Auto rows get no button. When
   `status.forceBlocked`, buttons are disabled and one line under the table
   explains: forcing is off while accounts still use the deprecated `models`
   setting; replace it with a route.
2. Chip after the target from `override.state`: accent `forced · falls back
   when spent`, accent `forced · held`, warn `forced to X · X is <reason> ·
   serving from Y`, bad `held on X · X is <reason> · requests get 429`, bad
   `forced to X · nothing can serve right now`; suffix ` · from the TUI, until
   restart` when `source === 'tui'`. Helper under a forced row: "Stays forced
   until you clear it. Sessions pinned with TC_ACCT are not affected."
3. `<dialog id="forceDialog">` modelled on `switchDialog`: title "Force
   <route> to one account"; `select` of the route's members with weekly used
   and reset; radios "Fall back to automatic routing" (default) and "Hold on
   it" with one-line explanations; an explain block; result line
   (`role="status"`); `Cancel`, `Apply` (primary, disabled while pending or
   disconnected). Default account: the member whose weekly reset is soonest.
   On Apply: `overrideRequest(draft, expected, key)` → fetch → `overrideOutcome`
   → `note` → `poll(true)`. 409 shows "changed elsewhere" with the current
   values and a `Use current` button that refreshes the draft's `expected`.
   Clear: an inline confirm row on the table row, then the same endpoint with
   `clear: true`. Focus returns to the opener on close; after Apply success,
   focus the row's chip (`tabindex="-1"`).
4. Pure helpers, serialised and covered by the "same implementations" test:
   `chipFor(row)`, `forceDefaultAccount(row, accounts)`, `expectedFor(row)`,
   `overrideRequest(payload, key)`, `overrideOutcome(res)`.
5. Docs: `docs/routing.md` Model routes gains an "Overrides" subsection (the
   field, hold and fallback, manual clear, the probe caveat, TC_ACCT precedence,
   ownership-claim refusal, TUI pins runtime-only and losing to config, the CLI
   cross-process race). `docs/usage.md` dashboard section gains the Force
   dialog and the endpoint.
6. Tests: each helper; `routeRows` carries `override`, `persisted`, `id`; the
   serialised page has no `innerHTML`; hostile names pass through unchanged.

### Integration (orchestrator)

`npm test`, `npm run lint`, read the full diff, one commit per WP or one
squashed commit, push `claude/route-override`, open the PR with the plan
summary, run the `gh-codex-review-loop` skill until LGTM, let the poller
merge (or merge when approved and checks are green), then deploy.

### Deploy (orchestrator, after merge)

Two services on this VM, both from the merged master:

1. Proxy: `npm pack` in a clean checkout of master →
   back up `~/.local/share/teamclaude/npm/lib/node_modules/@karpeleslab/teamclaude`
   to `~/.local/share/teamclaude/backups/pre-route-override-<UTC ts>/` →
   `npm install -g --prefix ~/.local/share/teamclaude/npm --ignore-scripts <tgz>` →
   regenerate `~/.local/share/teamclaude/reviewed-install.sha256` over every
   file in the installed package (`find … -type f | sort | xargs sha256sum`) →
   `systemctl --user restart teamclaude` → `GET /teamclaude/status` shows the
   new `routes[].id` field and the server uptime reset.
2. LAN dashboard: copy the checkout's `package.json` and `src/` to
   `~/.local/share/teamclaude-dashboard/releases/<merge sha>/`, point the
   `current` symlink at it, `systemctl --user restart teamclaude-dashboard`,
   then load the dashboard and confirm the Force button renders.

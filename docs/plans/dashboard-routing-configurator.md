# Dashboard: force a route onto one account

Status: proposal, revision 4, reviewed four times by gpt-6-astra (high) as adversarial critic.
Still REVISE after round 4. Stopped at the round cap; open decisions for the owner are listed at the end. Not implemented.
Mockup: `dashboard-routing-configurator.mockup.html` in this folder.

## Scope

Phase 1, this document: a **Force** control on each row of the dashboard's
Routing card. It sets or clears one field on a route. The ask, verbatim:
"user forces account → model routing", with "auto-activate [automatic routing]
when the forced target account runs out of usage" as an additional option.
So two modes, hold and fallback, and a Clear. Nothing else.

Phase 2, deferred, each with the reason it is not here:

- Timed expiry ("until its weekly reset"). Revision 3 tried a live deadline;
  the critic showed that quota clearing nulls the reset timestamp, upstream
  can advance it before the old one is observed, and reconciliation can
  reactivate a released override. A correct version binds the override to an
  observed window and keeps a terminal released state across reload. Worth
  doing, not needed to force a route. Until then the operator clears by hand.
- Any promise that traffic moves off the account at its reset. Rollover
  preemption is a conditional re-rank after an observed reset jump, with
  documented detection gaps. The UI makes no such promise.
- CLI `route force` / `unforce`. The endpoint is enough for the ask.
- Rule CRUD, ordering, deletion, bucket and colour editing from the page.
- Forcing "Everything else". A provider auto row covers the Codex case.

## Decisions taken by the author

1. **Forcing is refused while any account carries a per-account `models`
   ownership claim.** The claims are deprecated and make membership depend on
   the request's model. The check runs against the manager's live accounts,
   the same objects selection reads, and `syncAccountsFromDisk` starts
   updating `models` on existing accounts so a migrated config lifts the
   refusal on reload. The page shows the refusal on the row before any panel
   opens, with the replacement route the server already logs. Clear is never
   refused.
2. **Clear removes both the persisted override and any runtime pin for the
   row**, whatever its source, and reports separately whether disk and runtime
   each succeeded.
3. **No DOM test harness.** State transitions live in exported pure functions
   and are unit-tested. The DOM glue is verified against a written checklist in
   the PR, including the transitions listed under Tests.
4. **Route identity is `{ kind, name }`**, `kind` being `configured` or
   `auto`, everywhere a pin is stored, looked up, set, cleared or displayed.
   Today pins are keyed by bare name and a configured route named `fable`
   shares a pin with the auto Fable row.

## What exists today

Facts the design has to respect, each checked against the source:

- `routeCommand` (`src/index.js`) and `_routeSave` (`src/tui.js`) build a fresh
  route object from known fields; `_routeSave` publishes to the manager before
  the disk write; the TUI save hook writes the whole in-memory table.
- `_pickActiveAccount` skips session distribution whenever a pin exists, even
  when the pinned account cannot serve; the pin fast path itself requires
  `_isAvailable` and `!exclude.has`.
- `previewRouteIndex` sets no provider, applies no provider exclusion, reads no
  provider cursor, and returns null where selection would degrade to
  executor-only routing.
- `_excludeOtherProviders` excludes foreign **subscription** accounts only; an
  API-key account serves both providers.
- `_routeAllows` resolves the first matching route, then falls back to the
  ownership claim when the list is empty. `sampleModelFor` strips stars from
  the first glob only.
- `computeRetryAfter` (`src/server.js`) reads `rateLimitedUntil`,
  `entitlementDeniedUntil` and `quota.resetsAt` across all accounts; the same
  local `retryAfter` drives the synthetic 429 and the `holdSeconds` wait.
- `unavailableReason` returns one short-circuited word, not a list of blockers.
- `removeAccount` remaps `routePins` values as bare indices.
- `_doSwitchSelection` (`src/tui.js`) ignores `clearRoutePin`'s result.
- Loopback callers skip the key gate and must be same-origin.
  `atomicConfigUpdate` runs the updater, then writes; it serialises writers in
  one process only.

## Config

```json
{
  "name": "codex-default",
  "match": ["gpt-*", "*codex*"],
  "accounts": ["factorlin codex", "codex-2"],
  "override": { "account": "factorlin codex", "whenSpent": "fallback", "since": 1789189000000 }
}
```

- `account`: by name, the convention of `accounts[]`. Must be a member: in
  the list, or any account when the list is empty.
- `whenSpent`: `"fallback"` or `"hold"`. No default; the writer always sets it.
- `since`: epoch ms when it was applied. Display only.

### One normaliser

`normalizeRoutes(routes, accounts) -> { routes, warnings }` in `src/routes.js`.
Total. `AccountManager.setRoutes` calls it and returns the warnings; server
start and `reloadAccounts` log them; the endpoint returns them.

- Coerce `match` to non-empty strings; drop a route with none.
- Duplicate configured names: keep the first, drop the rest with a warning.
  Nothing is rewritten, so disk rows map one-to-one to normalised rows by
  name and position.
- `bucket` in `['unified7d', 'unified7dFable', 'unified7dSonnet']` or dropped.
- `override`: `account` must exist and be a member of **this** route's list;
  `whenSpent` one of the two words; otherwise warning, override dropped, route
  kept. Account removal or rename leaves the override to be dropped this way
  on the next normalisation, like a stale `accounts[]` entry. Logged.

### Writers

- `routeCommand add`: spread the freshly loaded on-disk route, then apply the
  flags. Preserves `override`.
- `_routeSave` (TUI): inside one `atomicConfigUpdate`, re-read disk, find the
  route by the **original name captured when editing began**, spread it,
  apply the draft (a rename keeps the override because the source row was
  found by original name), normalise; after the write commits, publish the
  committed table with `setRoutes` and assign it to `config.routes`. No
  publish before commit. A materialised route present on disk but absent from
  a stale in-memory table survives because disk is the base.
- TUI save hook (`saveConfig` in `serverCommand`): no longer assigns
  `config.routes`. Routes reach disk only through `_routeSave`, `_routeDelete`
  (same pattern), `routeCommand` and the endpoint.

## Rows and identity

`getRoutes()` returns configured rows and auto rows. Auto rows: `fable`,
`sonnet` as today, plus `codex` when any Codex account exists and no
configured route matches `gpt-5-codex`, with `match: ['gpt-*', '*codex*']`.
Every row carries `id: { kind, name }`.

`routePins` is keyed by `"configured:<name>"` or `"auto:<family>"`.
`setRoutePin`, `clearRoutePin`, `_pinnedFor`, the TUI switch mode and
`removeAccount` use the id. `_pinnedFor` checks configured routes first, then
the auto families `fable`, `sonnet`, `codex` in that order, as today plus
`codex`.

Materialising an auto row on Force: inside the transaction, re-check that no
configured route covers the family sample and that the family name is free;
otherwise 409. Append `{ name: <family>, match, override }` at the end of the
table and delete the `auto:<family>` pin. Precedence of configured routes is
unchanged. A model matching two family globs was resolved Fable-first by the
auto branch and is now resolved by table order; the endpoint's reply says
`materialised: true` and the docs state this.

## Engine (`src/account-manager.js`)

Pin value: `{ index, whenSpent, source, lastServed }`, `source` `'config'` or
`'tui'`. `removeAccount` remaps `index` and `lastServed` and drops entries on
the removed account. All readers updated; the existing removal test extended.

Reconciliation in `setRoutes()`: delete every `'config'` entry; seed from
normalised overrides; a config entry replaces a `'tui'` entry with the same
id; other `'tui'` entries survive. `clearRoutePin(id)` from the TUI refuses a
`'config'` entry; `_doSwitchSelection` consumes the result, logs the refusal
and stays in switch mode. `setRoutePin` from the TUI on an id with a config
entry replaces it in memory; the next reload undoes it; the TUI log says so.
`clearAnyPin(id)` (endpoint only) deletes regardless of source.

Membership: `routeMembers(route)` is the route's list, or all accounts when
empty. No model lookup, no first-match resolution. Used by normalisation,
`setRoutePin` validation and the endpoint.

`_pinServes(pin, model, advisorModel, exclude)`: `_isAvailable(account, …)
&& !exclude?.has(account.index)`. Used by the pin fast path (unchanged) and
by the session-distribution bypass (changed from existence to this). The
provider partition reaches every `_pickActiveAccount` caller through
`exclude` from `getActiveAccount`; `_selectForSession`, the draining path and
`_selectProbe` all receive that same `exclude`. Tests cover each.

Allowance:

```
_routeAllows(account, model) {
  const route = _routeForModel(model);            // first match, as today
  if (route?.accounts.length ? !inList : !_accountOwnsModel(account, model)) return false;
  const pin = pinFor(route ? {configured, route.name} : autoIdFor(model));
  return !pin || pin.whenSpent !== 'hold' || account.index === pin.index;
}
```

Hold never widens membership. With ownership claims present, forcing is
refused (decision 1), so the claim branch never combines with a pin.

Ramp: when the pin fast path returns an index other than `lastServed`, call
`_joinPolicyRamp(account)` and record it.

Hold retry: `holdRetryAfterMs(id, now)` is the earliest **known** timestamp on
the forced account among `rateLimitedUntil`, `entitlementDeniedUntil`,
`quota.resetsAt`, `unified5hReset`, `unified7dReset` and the family or scoped
weekly reset for the route's first glob, minus now; `null` when none is known.
Its meaning is "next worthwhile recheck", not predicted eligibility. The server
uses it in place of `computeRetryAfter` when the request's route has a live
hold pin, converting once into the local `retryAfter` that already drives the
429 and the `holdSeconds` loop; `null` keeps the existing 60s default. The
probe path still sends one live probe to the spent account; documented.

Explicit session pins and advisor requests: `TC_ACCT` bypasses routes; the
executor's pin decides, the advisor's only when the executor is unpinned; hold
plus an unroutable advisor takes the existing executor-only degradation and
logs. Tested.

Preview: `previewRouteIndex(model, advisorModel, { provider })` sets
`_selectingProvider`, applies `_excludeOtherProviders(null, provider)`, uses
`providerCursors.get(provider)` as the current index when the global cursor
is on a foreign subscription account and the entry is valid, else the first
member, and mirrors executor-only degradation when nothing serves both models.
No mutation.

Diagnostics per row: `targets`: for each provider, the preview result, or
absent when every member is a foreign subscription account for that provider.
`target`: the override account's provider's entry when forced, else the single
entry when only one exists, else null with `targets` shown per provider.
`override` (effective runtime pin): `{ account, whenSpent, source, since,
state, reason }`, `state` in `effective`, `unavailable`, `holding`,
`no-target`. `persisted`: the canonical disk override `{ account, whenSpent }`
or null, taken from the normalised table, never from the pin. `forceBlocked`:
`{ reason: 'ownership-claims', replacement: [...] }` or null.

## Control plane

```
POST /teamclaude/routes/override
{ "id": { "kind": "configured", "name": "codex-default" },
  "expected": { "match": ["gpt-*","*codex*"], "accounts": ["factorlin codex","codex-2"], "persisted": null },
  "account": "factorlin codex", "whenSpent": "fallback" }
{ "id": …, "expected": …, "clear": true }

200 { "ok": true, "row": <row>, "id": <new id when materialised>, "materialised": false,
      "persisted": true, "applied": true, "warnings": [] }
400 { "ok": false, "errors": [{ "field": "account", "message": "not a member of this route" }] }
404 { "ok": false, "error": "no such route" }
409 { "ok": false, "error": "changed elsewhere", "row": <row> }
500 { "ok": false, "persisted": true|false, "applied": false, "error": "reload failed; see the proxy log" }
```

- `expected` is the row's definition as last seen: `match`, `accounts` and
  the canonical `persisted` override. For an auto row: `{ auto: true, match }`.
  Inside the transaction the disk table is re-read and normalised, the row is
  located by id, and the canonical values compared. Any difference: 409 with
  the current row. A changed scope is a 409, not a silent apply.
- Write-time checks: `account` in `routeMembers`; `whenSpent` valid; no
  ownership claims on the live accounts (400 with `replacement`). Clear skips
  the claims check.
- Order of operations, serialised on one in-process queue shared with
  `reloadAccounts` so no reload interleaves:
  1. `atomicConfigUpdate`: precondition, edit `routes[i].override` or append
     the materialised route, normalise. No runtime mutation here.
  2. On commit: for Clear, `clearAnyPin(id)`; for a materialisation,
     `clearAnyPin(auto id)`. Then `reloadAccounts()`, whose `setRoutes`
     publishes the committed table and seeds the config pin.
  3. If step 1 fails: nothing changed, error reply. If step 2's reload fails:
     `persisted: true, applied: false`, 500, log has the detail.
- Same key gate, loopback and same-origin rules as `/switch`. Body via
  `readControlBody`. Replies carry field errors and warnings only.

## Dashboard

### Row

- `Force…` (accessible name "Force route codex-default", `aria-expanded`).
  Forced: `Change…` and `Clear force`. When `forceBlocked`: the button is
  disabled and a line says "Forcing is off while accounts still use the
  deprecated models setting. Replace it with:" followed by the replacement
  route text.
- Chip after the target, from `override.state`, `tabindex="-1"`:
  - accent `forced · falls back when spent`
  - accent `forced · held`
  - warn `forced to X · X is over its weekly threshold · serving from Y`
  - bad `held on X · X is over its weekly threshold · requests wait`
  - bad `forced to X · nothing can serve right now`
  - dim suffix ` · from the TUI, until restart` when `source` is `tui`.
- Helper under a forced row: "Stays forced until you clear it. Sessions
  pinned with TC_ACCT are not affected."

### Force panel

Inline under the row. Labels with `for`, ids `force-<kind>-<name>-<field>`.

1. **Account** `select`: `routeMembers`, each with weekly used and reset.
   Default: the member whose weekly reset is soonest.
2. **When it runs out of usage**: radios `Fall back to automatic routing`
   (default; "the other members serve it until it is eligible again") and
   `Hold on it` ("no other member serves it; requests wait for its reset or
   get a 429").
3. `Apply`, `Cancel`. Apply disables itself in flight. 400 errors attach with
   `aria-describedby`; 409 shows the current row's values inside the panel
   with a `Use current` button that resets the draft baseline; transport
   errors go to `#note` (`role="status"`).

Two clicks when the default account fits: `Force…`, `Apply`.

`Clear force` swaps in `Clear force on codex-default? [Clear] [Keep]`, focus
on `Clear`; `Keep` returns focus to `Clear force`. Clear sends `expected`.

### Live refresh with a panel open

Rows are DOM nodes keyed by id. On each poll: rows absent from the response
are removed; new rows are inserted at their server position; existing rows
are moved to match server order without being recreated; each row's target,
chip, helpers and members are updated in place. The panel node lives inside
its row node and moves with it. Conflict: if the row's `expected` triple
differs from the snapshot taken when the panel opened, a line in the panel
says what changed ("now forced to X", "cleared elsewhere", "members changed")
and the draft is kept.

Apply success: the page records the id returned by the server (the configured
id after a materialisation) as the panel's row id **before** the next poll can
run, closes the panel, and focuses that row's chip. A poll that arrives
between the POST and its reply may already show the configured row; the
pending-id record is what the success handler uses, so the auto row's
disappearance is not treated as deletion. A row that disappears with no
pending id closes its panel with a note.

### Pure, tested helpers

`chipFor(row)`, `defaultAccount(row)`, `draftReducer(draft, event)`,
`conflict(snapshot, row)`, `overrideRequest(draft, key)`, `applyOutcome(res)`,
`reconcileRows(existingIds, serverRows)` (returns remove, insert and move
operations). All serialised into the page and covered by the existing "same
implementations" test.

## Tests

Engine, `test/route-pin.test.js`:
- hold: other members fail `_routeAllows`; a spent forced account yields null
  outside the probe path; the probe path still probes it; `holdRetryAfterMs`
  returns the earliest known of a throttle, a 5h reset, a weekly reset, and
  null when none is known.
- fallback: unavailable forced account runs the normal walk with session
  affinity (A/B case), with a retry exclusion (A-excluded/C-affinity case),
  with a foreign-provider pin, while draining, and on the probe path.
- identity: a configured `fable` route with an unrelated glob and the auto
  Fable row hold separate pins; materialisation deletes the auto pin.
- reconciliation: config entries replaced on `setRoutes`; a TUI entry survives
  without an override; TUI `clearRoutePin` refuses a config entry and the TUI
  reports it; `clearAnyPin` removes either.
- removal: object values remapped; pin on the removed account dropped.
- ramp joined on transition; advisor precedence and hold degradation.
- preview: owning and borrowing provider, invalid provider cursor, mixed
  subscription and key members, key-only route, advisor degradation mirrored;
  `targets` per provider; each `override.state`; `persisted` from disk when a
  TUI pin has replaced the config pin in memory.
- `codex` auto row appears and disappears.

`test/routes.test.js`: `normalizeRoutes` for every rule, including duplicates
kept-first, unknown account, account outside the route's list, bad
`whenSpent`.

Editors: CLI add keeps `override`; TUI save after a rename keeps it; TUI save
from a stale in-memory table keeps a materialised route; Clear followed by an
unrelated TUI edit stays cleared in memory and on disk; the TUI hook no longer
writes routes.

HTTP, `test/dashboard.test.js`: loopback same-origin POST writes and reloads;
the key gate with a non-loopback address through the exported gate function;
cross-origin with a valid key rejected; `Origin` only rejected; 413; 400
invalid JSON; 400 ownership claims (Clear exempt); 409 on each part of
`expected`; 409 when an auto row's family is covered or its name taken by the
time the transaction runs; disk write failure leaves the runtime pin; reload
failure answers `persisted: true, applied: false`; a queued reload cannot
interleave.

Page helpers: each pure helper; `conflict` ignoring `state` and `reason`;
`reconcileRows` for insert, remove and move.

DOM checklist (decision 3): draft survives three polls with the select open;
Apply success, 400, 409 with `Use current`, transport error; Clear and Keep
focus; row removed with and without a pending id; materialisation of the
`codex` auto row with the panel open; rows reordering under an open panel; a
poll arriving before the POST reply.

## Docs

`docs/routing.md`, Model routes: "Overrides": the field, hold and fallback,
manual clear, the probe caveat, TC_ACCT precedence, ownership-claim refusal,
TUI pins as runtime-only and losing to config, the two-family precedence note
on materialisation. `docs/usage.md`: the panel and the endpoint.

## Order of work

1. `src/routes.js`, `setRoutes` calling it, `routeMembers`, writer changes
   (CLI, `_routeSave`, `_routeDelete`, save hook). Tests.
2. Pin identity and value, `removeAccount`, reconciliation, `clearAnyPin`,
   TUI switch-mode consuming results, `_pinServes`, allowance, ramp join,
   `holdRetryAfterMs`, provider-aware preview, diagnostics, `codex` auto row,
   `models` sync on reload. Tests.
3. Endpoint, queue, hook in both branches, hold retry in the server. Tests.
4. Chips and blocked state.
5. Force panel, Clear, keyed refresh.
6. Docs.

## Critique log

- Revision 1 → gpt-6-astra (high): REVISE, 22 findings. Narrowed to Force.
- Revision 2 → REVISE, 18. Live reset deadline, shared predicate, identity by
  `auto` flag, expected check, one normaliser.
- Revision 3 → REVISE, 1 blocker, 13 major, 4 minor. Removed: timed expiry and
  any reset-movement promise (findings 1, 2, 3), CLI force/unforce, duplicate
  name rewriting (18). Changed: pin identity `{kind, name}` (5), TUI writers
  edit fresh disk by original name and publish after commit, save hook no
  longer writes routes (6), `persisted` separate from the runtime pin and
  `expected` covers the definition (7, 8), runtime mutations after commit on
  one queue with a split success reply (10), removal migration (11), provider
  eligibility through the partition rule with advisor degradation mirrored
  (12), keyed row reconciliation and pending id (13), membership from the
  selected route object (14), overlapping-glob note kept as a documented
  limitation (15), TUI consumes the refusal (16), `models` sync on reload and
  a blocked state before Apply (4), hold retry as earliest known recheck on
  the forced account (9), mockup shows the auto Codex path (17).

- Revision 4 → REVISE, 15 major, 4 minor. No blocker. Decisions 3 and 4
  accepted; 1 and 2 rejected as specified. The remaining findings, grouped:
  - Concurrency and publication (4, 5, 6): TUI writers publish outside the
    queue; reload can restore an old table; `applied: false` can be wrong;
    the CLI runs in another process so `expected` cannot protect against it.
  - Materialisation (11, 12): a materialised family route has no member list,
    so the default can pick a wrong-provider account; a configured family
    route permanently shadows the other auto family for overlapping globs,
    and Clear leaves the route behind.
  - Hold (13, 14): the `holdSeconds` loop keeps the forced account in
    `ctx.tried`, so it never recovers mid-wait; the reset wording is wrong.
  - Ownership claims (1, 2, 17): `mergeAccountsForSave` resurrects a cleared
    `models`; claims and overrides can coexist after reload; the logged
    replacement route is wrong when two accounts claim one model.
  - Baseline and normalisation (7, 8): `expected` needs a server-produced
    canonical form including bucket and preceding routes; dropping duplicate
    names changes unrelated routing.
  - Smaller: TUI pin pruning on route deletion (9), preview borrowing rule
    (10), pending-id ordering and overlapping polls (15), ramp `lastServed`
    after a fallback (16), border contrast and focus on Cancel and Clear
    (18, 19).

## Decisions taken by the owner (12 Sep 2026)

1. **Materialising auto rows.** Findings 11 and 12 show forcing an
   auto-detected family or Codex row changes routing beyond the override and
   cannot be fully undone by Clear. Option A: phase 1 forces configured routes
   only; the Codex row exists on this fleet (`codex-default`). Option B: keep
   materialisation and fix precedence and provider filtering. Recommendation:
   A. The ask is served, and the auto path can come later with rule editing.
2. **Hold semantics.** Finding 13: with `holdSeconds` set, a held request
   never recovers mid-wait. Option A: hold answers a 429 with a retry-after
   and never enters the silent wait. Option B: rework the hold loop's retry
   epochs. Decided: A. Hold answers a 429 with a retry-after and never enters
   the silent wait.
3. **CLI concurrency.** Finding 6: `teamclaude route add` in another process
   can race the endpoint, as it races every other writer today. Option A:
   accept and document. Option B: a file lock shared by CLI and server.
   Decided: A, documented in docs/routing.md.
4. **Continue the critic loop?** Four rounds cost about 90k Codex tokens and
   ten minutes each. Rounds 3 and 4 shifted from design to engine internals
   that are better settled by implementing steps 1 to 3 with tests and
   reviewing the code. Recommendation: stop reviewing the document; build
   the engine slice and put the PR through cross-review. Decided: build it.
   See route-override-implementation.md.

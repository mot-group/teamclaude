# Subscription forecasts

Forecasting uses subscription-level provider usage changes. A reading already includes work from other machines. Local token counters are not added to it or used to infer total burn. Account credentials that identify the same subscription share one history.

The Forecast dashboard view shows current-pace estimates for each observed window, provider-limit dates, reported reset dates, hard account caps, and separate soft routing thresholds. A future reset is conditional. Zero burn, insufficient resolution, changed windows, unsupported durations, stale readings, and unknown identities do not produce a depletion date. The display never adds account percentages or account lifetimes into a fleet total.

The implementation is experimental and opt-in. Enabling history does not enable probes or change their cadence. Only successful existing probes supply observations. Header and cached quota values do not create samples. The endpoint and dashboard are read-only.

## Configuration

After deploying the reviewed code, set this block in the existing TeamClaude config and restart the proxy:

```json
{
  "forecast": {
    "enabled": true,
    "models": ["claude-fable-5-1", "claude-opus-5"],
    "alternatives": []
  }
}
```

Keep the existing `quotaProbeSeconds` value. An owner proxy that is offline or asleep cannot observe remote burn. Missing current coverage makes the forecast unavailable. No process or service changes its polling automatically.

`alternatives` is a list of user-approved `{ "from": "exact-model-id", "to": "exact-model-id" }` pairs. An empty list produces no model-switch recommendation. Advice can explain that an alternative avoids a model-scoped constraint only after two fresh provider observations confirm the relevant limits. All shared limits, known model limits, disabled accounts, held routes, blocklists, and hard account caps still apply. Advice concerns new or restartable work at this proxy and does not promise that an existing pinned session can move.

Codex `metered_feature` slugs do not by themselves prove which exact model IDs use those limits. A verified `forecast.modelScopes` mapping can specify each model's applicable slugs. An absent mapping produces incomplete model coverage. Every reported Codex duration is retained, including additional short windows. Unknown durations remain visible but cannot support a complete-model forecast.

## Storage and runtime support

The forecast owner is the proxy process serving the primary Ubuntu dashboard. Its SQLite file is `<config path>.forecast.sqlite`, with mode 0600. It contains bounded provider observations, forecast snapshots, and fixed-lead evaluation records. It has no tokens, credentials, prompts, responses, private transcript paths, or local session titles.

SQLite operations run in a worker. Node versions with `node:sqlite` use the built-in driver. Node 20 uses an existing `sqlite3` executable through the same worker. The feature does not install that executable. If neither backend is available, history is unavailable and normal proxy service continues. This preserves the repository's zero-runtime-dependency package and Node 20 proxy support. The Node 20 fallback and Node 24 built-in path are covered by the history tests.

Fine observations remain for 30 days. Five-minute historical samples and ordinary forecast records remain for 90 days. Pending predictions and scored evaluation records retain the prediction inputs needed to audit them. They are not automatically promoted into a confidence claim. SQLite limits disk allocation; a storage fault disables history-dependent results and preserves the file for inspection. It does not replace a corrupt database.

Records are deduplicated by stable source event and subscription keys. Rate fitting uses at most one observation per probe interval, with a minimum five-minute interval. Missing identity excludes the entry from the confirmed pool. Claude identity requires both account UUID and organization UUID. Codex uses its subscription account ID. Email, config order, access tokens, and account names are not history keys.

## API

`GET /teamclaude/forecast?hours=8` returns a versioned cached snapshot. The horizon must be greater than zero and at most 168 hours. The LAN dashboard forwards the default endpoint through its existing authenticated session. The same snapshot is included in dashboard status, so the page does not add upstream polling.

`limitAt` is the window's projection at observed total account pace. It is not a session interruption forecast. Dates beyond a scheduled reset cannot predict post-reset capacity. `firstShortfall` and numeric model gains remain null with reasons. Status names and coverage fields explain unavailable results.

## Evaluation and remaining work

Half-hourly snapshots save 30-minute, two-hour, and eight-hour same-window predictions when evidence supports them. Each freezes a last-value and recent-hour linear baseline at the same cutoff. The next eligible provider observation scores the prediction. Changed policy, corrections, resets, and observation gaps produce excluded outcomes. Each outcome contains its subscription-window cluster key. The displayed diagnostic means are not independent-event statistics or a promotion decision.

This release delivers account-level measurement and constraint-based model advice. It does not claim full delivery of the broader PRD's pooled workload simulator, numeric model-switch gains, per-machine continuity, or calibrated probabilities. Those require measured workload transfer, accepted model alternatives, production-policy replay, and the PRD's evidence gates. Local request collectors are not necessary for current account-level depletion forecasts.

No deployment, collector installation, polling change, credit redemption, billing change, or alert configuration is part of this PR. The full PRD and review evidence remain in the local handoff.

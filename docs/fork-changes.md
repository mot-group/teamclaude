# MOT fork changes

This page tracks additions and fixes maintained in [mot-group/teamclaude](https://github.com/mot-group/teamclaude), based on [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude). The upstream npm package retains its original name and publisher. Its version number does not identify which MOT changes are installed. Use the reviewed Git commit to identify a fork deployment.

## Merged features and fixes

| Change | Behavior | Reference |
| --- | --- | --- |
| Fable quota preference | Opt-in `preferFableDepletedAccounts` uses accounts with confirmed depleted Fable quota for recognized non-Fable Claude models within the best eligible priority tier. This preserves Fable-capable accounts for Fable traffic. Explicit pins and eligibility restrictions still apply. | [PR #1](https://github.com/mot-group/teamclaude/pull/1), [routing rules](routing.md#prefer-accounts-with-depleted-fable-quota) |
| LAN dashboard and persistent service | Separate password gate, expiring browser sessions, account capacity, routing, request activity, token accounting, sessions, and diagnostics. A systemd user unit and lingering support startup at boot and operation after logout. | [PR #2](https://github.com/mot-group/teamclaude/pull/2), [setup](lan-dashboard.md) |
| Codex quota probes | Scheduled read-only subscription probes update idle accounts, plan metadata, and model-specific weekly limits. Windows are classified by duration, including weekly primary windows. | [PR #3](https://github.com/mot-group/teamclaude/pull/3), [quota probes](quota.md#codex-subscription-probes) |
| Reset history, banked credits, and Chat alerts | Persistent detected reset events distinguish restarted windows from quota refills and separate scheduled rollovers from early resets. Codex banked credits include availability and expiry. Google Chat receives confirmed early resets and credit availability/expiry alerts. | [PR #4](https://github.com/mot-group/teamclaude/pull/4), [detection and configuration](reset-tracking.md) |

The LAN dashboard also fixes startup through a release symlink by resolving the executable path before checking the main entry point. It restricts its proxy forwarding to status, quota, and account switching. Password checks apply even on loopback. The original proxy listener keeps its existing authentication rules.

The quota prober selects the provider before making a usage request. Codex credentials go to OpenAI's usage endpoint, and a rejected token refreshes through the Codex OAuth flow before one retry. Disabled accounts, rejected refresh-token accounts, and custom-upstream subscription accounts are excluded from these subscription probes. A failed probe preserves the last quota reading. Probes do not increment traffic counters.

Reset detection compares successful provider observations, so clearing a locally expired quota cache cannot produce a reset event. Unexpected drops require a confirming probe. Related windows observed resetting together count as one account event, and scheduled rollovers do not increase the early-reset count. History and the notification outbox survive restarts. Stable Google Chat message IDs prevent duplicate messages on delivery retries.

## Intended Codex Desktop behavior

A desktop login can retain access to a remote target while the target routes model requests through another subscription enrolled in TeamClaude. This was observed with a Mac client and Linux Codex Desktop on 2026-09-09 and explicitly accepted as intended behavior. See [remote access and model routing](codex-remote-access.md) for the account separation and configuration.

## Deployment boundaries and known limits

The features above are merged into this fork. Additional account-listing, account-resolver, and API-command provider guards exist in the maintained Linux installation as reviewed local overlays. Those extra guards are not all merged into this repository. A fresh checkout must not be described as containing them, and a full reinstall must not replace a guarded installation without reviewing and preserving its overlays.

The fork does not publish a separate npm package. For fork deployments, disable npm self-updates with `"autoUpdate": false` or `TEAMCLAUDE_DISABLE_AUTOUPDATE=1`, and deploy reviewed source commits. The explicit `teamclaude update` command still targets the upstream npm package. Do not use it to update a guarded fork deployment.

The LAN listener uses HTTP on a specific local address. It is intended for a trusted LAN. Reset detection is inferred and can miss small drops, missing windows, or resets hidden by heavy use between probes. A sustained provider correction can resemble a reset. Claude has no confirmed banked-reset inventory in this integration. Credit lookup is read-only, with no purchase links or redemption actions. See the individual guides for exact rules.

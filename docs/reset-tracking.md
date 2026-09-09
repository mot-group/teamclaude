# Usage reset tracking

The quota prober records successful subscription usage observations for Claude and Codex. Reset history persists across server restarts. Enable quota probes with `teamclaude probe 300` to update it every five minutes.

The dashboard has a Usage resets section with per-account counts, pending detections, banked Codex reset credits, and the latest 500 events. Counts include older events. Each event records usage and expected reset times before and after, plus the interval between observations. The exact reset time is unknown.

| Detected type | Usage | Expected reset time |
| --- | --- | --- |
| Restarted window | Drops | Advances by more than one minute |
| Quota refill | Drops | Stays within one minute of the previous time |

Timing is separate from type. Scheduled rollovers advance a window whose expected end falls between the probes, allowing one minute of clock tolerance. They appear in history but do not count as early resets or send Chat alerts. A rollover can have higher usage by the next probe.

Unexpected resets require a drop of at least 20 percentage points to 10% usage or less. The following successful probe must retain the new reset time and low usage. Usage can increase by up to 10 percentage points during confirmation, provided it remains at least 20 points below the original reading. An early reset happens more than one minute before the original expected reset time. Other confirmed drops have uncertain timing and do not send alerts.

These are inferred events. A sustained provider correction can resemble a reset. Small resets, rapid usage after a reset, missing timestamps, and multiple resets between probes cannot be reliably counted. The detector skips comparisons across gaps longer than three probe intervals, with a minimum of 15 minutes and maximum of one hour. Missing windows break that window's observation chain. It never interprets locally expired quota caches as provider observations.

Windows that reset over the same observed interval and share a timing classification count as one account event. Early type totals count an event once per affected type, so an event with both types appears in both type totals. Subscription identity separates accounts; changing a credential alone does not reset history.

## Banked Codex resets

The prober also reads Codex's reset credit inventory. It displays the available count, individual credit titles, expiry times, last successful check, and any current lookup error. A lookup failure preserves the previous inventory and does not fail the usage probe. Claude's endpoint does not provide a confirmed banked reset inventory.

This integration only reads inventory. It contains no purchase links or redemption actions.

## Google Chat notifications

Store the incoming webhook URL in a private file outside the repository, with mode `0600`. Set these environment variables on the proxy service, then restart it:

| Variable | Purpose |
| --- | --- |
| `TEAMCLAUDE_CHAT_WEBHOOK_FILE` | File containing the webhook URL; unset disables Chat |
| `TEAMCLAUDE_RESET_DASHBOARD_URL` | Optional dashboard link appended to messages |
| `TEAMCLAUDE_RESET_STATE_FILE` | Optional history path; defaults to the proxy config path plus `.resets.json` |

The proxy sends confirmed early reset events, newly available banked credits, and one alert per credit when its expiry is within 24 hours. The initial inventory establishes a baseline; existing credits only alert if expiring soon. Scheduled rollovers, uncertain detections, and ordinary polling do not send messages. There are no upcoming scheduled-reset reminders.

Notification state is saved before delivery. Failed deliveries retry during later probe cycles with backoff up to one hour. Stable Google Chat custom message IDs suppress duplicates if a request succeeds but its response is lost. A duplicate-ID response completes delivery. The dashboard shows queued messages, delivery errors, and the last successful delivery. Turning probes off also stops delivery retries.

History and the outbox contain account names and usage, but no account credentials or webhook URL. Keep the state file private. Do not share one state file between proxy instances. Back it up with the proxy configuration. Deleting it discards observations, counts, and pending notifications. Malformed history causes startup to fail rather than silently discard it.

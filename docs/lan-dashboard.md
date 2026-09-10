# LAN dashboard

The dashboard runs alongside the proxy as a separate Node process. It shows account quota and reset times, routing targets, usage and cache totals, sessions, quota probes, warmup, and server diagnostics. The request activity chart covers up to 60 samples collected while the page is open. It resets on page reload or proxy restart. It is not a historical database.

The password gate applies to every data request, including localhost. The dashboard stores a salted scrypt password hash on disk and uses random, HttpOnly, SameSite=Strict session cookies. Sessions expire after 12 hours, on logout, or when the dashboard restarts. It rate-limits sign-in attempts. Passwords and proxy keys are not stored in browser storage in this mode.

The LAN listener accepts only status, quota, and account switching after login. It does not forward inference traffic or arbitrary proxy controls. The existing proxy dashboard and API-key authentication remain available separately.

## Start

Requires Node 20 or later and a running TeamClaude proxy on loopback. Create a password once. This prints the generated password, so save it in your password manager.

```bash
node src/dashboard-server.js --init-password
TEAMCLAUDE_DASHBOARD_HOST=192.168.1.20 npm run dashboard
```

Use this machine's LAN address in place of `192.168.1.20`. Open `http://192.168.1.20:3457`. The listener defaults to `127.0.0.1` until you choose a LAN address. Wildcard binds are refused.

This listener uses HTTP. Passwords and session cookies travel unencrypted, so use it on a trusted LAN. For access over untrusted networks, use an encrypted tunnel or an HTTPS deployment. Do not port-forward this listener to the internet.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TEAMCLAUDE_DASHBOARD_HOST` | `127.0.0.1` | Specific local address to listen on |
| `TEAMCLAUDE_DASHBOARD_PORT` | `3457` | Dashboard port |
| `TEAMCLAUDE_DASHBOARD_HOSTNAMES` | Empty | Comma-separated extra hostnames allowed by the Host header check |
| `TEAMCLAUDE_DASHBOARD_PASSWORD_FILE` | `~/.config/teamclaude-dashboard-password.json` | Salted password hash file |
| `TEAMCLAUDE_CONFIG` | `~/.config/teamclaude.json` | Proxy configuration, read at dashboard startup |

The default configuration directory honors `XDG_CONFIG_HOME`. The dashboard uses the proxy port and key from that configuration. Restart the dashboard after changing those values. Account data comes from the live proxy on each refresh.

To rotate the password, stop the dashboard, move the password hash file to a private backup, run `--init-password` again, and restart. The initializer refuses to overwrite an existing hash.

## Persistent Linux service

Deploy a reviewed commit to a separate release directory. From a clean checkout of that commit:

```bash
release="$HOME/.local/share/teamclaude-dashboard/releases/$(git rev-parse HEAD)"
mkdir -p "$release"
git archive HEAD src package.json | tar -x -C "$release"
ln -sfn "$release" "$HOME/.local/share/teamclaude-dashboard/current"
mkdir -p "$HOME/.config/systemd/user"
cp deploy/teamclaude-dashboard.service "$HOME/.config/systemd/user/"
```

The unit expects Node at `~/.local/bin/node`. Adjust `ExecStart` if your Node executable is elsewhere. Create `~/.config/teamclaude-dashboard.env` with your LAN address:

```text
TEAMCLAUDE_DASHBOARD_HOST=192.168.1.20
TEAMCLAUDE_DASHBOARD_PORT=3457
```

Then enable the service and lingering so it starts at boot and survives logout:

```bash
systemctl --user daemon-reload
systemctl --user enable --now teamclaude-dashboard.service
loginctl enable-linger "$USER"
systemctl --user status teamclaude-dashboard.service
```

Logs are available with `journalctl --user -u teamclaude-dashboard.service`. After deploying a new release, restart this service. The proxy service does not need a restart. To roll back, repoint `current` at the previous release and restart the dashboard. If the machine's LAN IP changes, update the environment file and restart.

## Data availability

Unknown quota means the proxy has not reported that quota. It does not mean an account has unlimited capacity. Token totals include only tokens reported by upstream responses. Named clients need `proxy.clientKeys`, and project attribution needs `proxy.usageDimensions`. Session rows need `proxy.sessionDetail: true` in the proxy config. See [configuration](configuration.md) for those options. The dashboard explains these empty states instead of inventing values.

The Usage resets section records detected resets and banked Codex reset credits across server restarts. See [reset tracking](reset-tracking.md) for detection rules and Google Chat configuration.

## Dashboard views

Overview combines the model routing forecast with an account comparison table. Accounts shows the same limits on their own. Activity contains request counters, token accounting, clients, dimensions, and Claude session activity. Routing keeps the configured-route details. Resets and Diagnostics retain reset inventory, history, probes, warmup, and server measurements. The navigation stays available on phones.

The Spent / Left control changes both percentages and bar lengths for current account quota, including account details. The browser remembers the choice. For example, 81% spent becomes 19% left. An unknown reading stays unknown in either mode. Historical reset events always show quota spent, and routing configuration is unaffected.

## Model routing summary

The header groups representative Claude and Codex models by their server-reported target. Blocked models and models with no eligible account have explicit labels. This forecast does not identify a native desktop login or promise which account every running request uses. Request pins, existing session assignments, distribution, advisor constraints, and retries can produce a different destination. Model IDs appear below each target.

Manual selection records a starting account for rotation. It does not set a persistent preference, change priority, or pin a model. The dialog reports whether the server recorded the choice and whether rotation will skip it. The dashboard refreshes the server forecast after selection. A disconnected dashboard disables manual selection until status is available again.

The server applies provider subscription boundaries, route restrictions, pins, priority, quota availability, and the live model blocklist to these previews. Reading status does not move account or route cursors, trigger a quota probe, or send a model request. Older proxies without provider summaries show an unavailable-summary message instead of reusing the global current-account field.

Account badges describe reported quota or an account block, not a guarantee that every model can use the account. Each limit has its own reset date and countdown. Probe timestamps identify the last probe attempt and mark failed attempts. They do not claim that every quota bucket was measured at that time.

## Session activity scope

The dashboard header does not show a global active-session count. The tracker sees only requests carrying Claude's session ID header. A tracked session counts as recent for two minutes after a request, or while a request is still in flight. It is not a count of open apps or terminals. Codex traffic and requests without that header do not contribute.

Activity says "No recent Claude session IDs observed" when that count is zero. Missing tracker data says "Session tracking unavailable". Request counters, token totals, and upstream requests in progress are separate measurements that include traffic outside the session tracker. Detailed rows still require `proxy.sessionDetail: true`.

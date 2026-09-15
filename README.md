# TeamClaude

[![CI](https://github.com/mot-group/teamclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/mot-group/teamclaude/actions/workflows/ci.yml)
[![upstream npm version](https://img.shields.io/npm/v/@karpeleslab/teamclaude.svg)](https://www.npmjs.com/package/@karpeleslab/teamclaude)
[![upstream Node requirement](https://img.shields.io/node/v/@karpeleslab/teamclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Multi-account proxy for [Claude Code](https://claude.ai/claude-code) and [Codex](https://github.com/openai/codex): it pools Claude Max, ChatGPT/Codex, API-key and third-party backend accounts, and rotates on quota.

It sits between the coding agent and the provider's API, holds several accounts, and moves to the next one when the current account gets close to its session or weekly limit. The session keeps running instead of stopping on a 429. Claude accounts serve Claude Code, Codex accounts serve the Codex CLI, and both pools share one proxy.

This is the [MOT fork](https://github.com/mot-group/teamclaude) of [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude). It adds a persistent LAN dashboard, Codex quota probes, reset history, banked reset inventory, Google Chat alerts, and an opt-in Fable quota preference. See [our changes and fixes](docs/fork-changes.md) for merged PRs and deployment limits. The npm badge above refers to the upstream package.

## Added in this fork

| Feature | Details |
| --- | --- |
| [Password-protected LAN dashboard](docs/lan-dashboard.md) | Separate Claude and Codex routing summaries, account capacity, activity, token totals, tracked Claude sessions, and diagnostics. Password gate and a persistent Linux service. |
| [Codex quota probes](docs/quota.md#codex-subscription-probes) | Read-only usage checks for idle subscriptions, including weekly primary windows and model-specific limits. |
| [Reset tracking and Google Chat](docs/reset-tracking.md) | Restarted windows, quota refills, scheduled rollovers, banked Codex credits with expiry, and persistent notification delivery. |
| [Fable quota preference](docs/routing.md#prefer-accounts-with-depleted-fable-quota) | Use Fable-depleted accounts for other Claude models while preserving eligible accounts for Fable. Off by default. |
| [Codex Desktop remote access](docs/codex-remote-access.md) | Intended behavior: retain the native remote-target login while model requests use another subscription through TeamClaude. |

![TeamClaude TUI](screenshots/teamclaude.png)

## Quick start

Node.js 20+ required. The runtime uses Node built-ins only, so no `npm install` step is needed to run a source checkout. Install development dependencies only if you need the lint tooling.

For a new source checkout of this fork:

```bash
git clone https://github.com/mot-group/teamclaude.git
cd teamclaude
node src/index.js login     # browser OAuth, run it once per Claude account
node src/index.js login --codex  # optional Codex subscription
TEAMCLAUDE_DISABLE_AUTOUPDATE=1 node src/index.js server
# In another terminal, from this checkout:
node src/index.js run
```

The command reference uses `teamclaude`; from a source checkout, substitute `node src/index.js`. The upstream `npm install -g @karpeleslab/teamclaude` command does not select this fork. Existing installations with local provider guards must preserve those overlays when updating. See [deployment boundaries](docs/fork-changes.md#deployment-boundaries-and-known-limits).

Already logged into Claude Code? `teamclaude import` takes its credentials instead of a fresh OAuth round. API keys, and one email holding accounts in several orgs, are covered in [docs/accounts.md](docs/accounts.md).

## Make routing automatic for agents and CLIs

These steps configure all projects for your OS user on macOS or Linux. Repeat them on each machine that runs agents or review jobs. The examples use a proxy on the **same machine**, at `http://127.0.0.1:3456`.

### 1. Add accounts and keep the proxy running

After the source checkout above, use `node src/index.js` in place of `teamclaude` unless you already have a fork launcher installed. Add each subscription you want to pool:

```bash
teamclaude login             # select a Claude subscription; repeat per account
teamclaude login --codex     # repeat per Codex account
```

For this fork, merge `"autoUpdate": false` into TeamClaude's config before installing the service. This prevents npm self-updates from replacing the fork. Stop any foreground `teamclaude server` before installing the service on the same port:

```bash
teamclaude service install
teamclaude service status
teamclaude probe 300         # refresh quota every five minutes
teamclaude status
```

The service starts at login through launchd on macOS or systemd on Linux. For unattended Linux jobs that must survive logout, follow the install command's `loginctl enable-linger` guidance. See [service commands](docs/usage.md#command-reference).

### 2. Set Claude Code's user defaults

Merge this `env` object into `~/.claude/settings.json`. Preserve your existing settings and other environment entries:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
    "ANTHROPIC_AUTH_TOKEN": "teamclaude"
  }
}
```

`teamclaude` is a non-secret placeholder for this loopback connection. TeamClaude supplies the selected account's real upstream credential. The placeholder lets Claude CLI use the proxy without depending on an expired local OAuth login. It is not a valid credential for a remote TeamClaude server; remote clients need [proxy authentication](docs/configuration.md#fields).

A fresh plain `claude` invocation now uses these settings. If a launcher excludes user settings or uses another configuration directory, pass both variables explicitly:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=teamclaude claude -p "Your task"
```

This configures base-URL routing. For features that hardcode Anthropic URLs, use `teamclaude run -- <claude arguments>` and the [MITM proxy mode](docs/proxy-modes.md#mitm-proxy-mode-default). A shell alias alone does not configure desktop apps or agents that spawn executables without an interactive shell.

### 3. Set Codex's provider and child-process defaults

Merge the following into `~/.codex/config.toml`. Keep `model_provider` at the top level, before any table headers. Merge existing tables instead of defining them twice:

```toml
model_provider = "teamclaude"

[model_providers.teamclaude]
name = "teamclaude"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true

[shell_environment_policy.set]
ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
ANTHROPIC_AUTH_TOKEN = "teamclaude"
```

Codex CLI and desktop Codex use this user configuration. The provider routes Codex's own requests; `shell_environment_policy.set` also routes Claude CLI commands launched by Codex. `requires_openai_auth = true` lets the local proxy supply Codex credentials. The `/backend-api/codex` suffix is required for subscription traffic. `OPENAI_BASE_URL` is not a substitute for this provider configuration.

If you use `CODEX_HOME`, edit `config.toml` in that directory instead. Preserve the TeamClaude provider when overriding models, reasoning effort, or profiles. Use the unpinned URL above to let the router select accounts.

### 4. Add persistent agent instructions

Add this rule to both `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, preserving their existing contents:

```text
Use TeamClaude for all local Codex and Claude Code invocations, including
delegated tasks and reviews. Preserve Codex's teamclaude provider when changing
models or reasoning settings.

When launching Claude CLI, pass ANTHROPIC_BASE_URL=http://127.0.0.1:3456 and
ANTHROPIC_AUTH_TOKEN=teamclaude. Let TeamClaude select the account by model and
quota. Do not pin an account unless the user requests it.

If the proxy is unavailable, report the failure instead of falling back to a
direct provider. Apply these defaults without asking on each invocation.
```

If `~/.codex/AGENTS.override.md` exists, Codex reads it instead of `AGENTS.md`; put the rule in the active file. Custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` directories also need their own instructions and settings. Start new sessions after editing. Instructions guide future commands; they cannot redirect an already running agent's connection.

### 5. Verify each launch path

```bash
teamclaude status
claude -p --model claude-fable-5-1 "Reply with exactly OK. Do not use tools."
codex exec --skip-git-repo-check "Reply with exactly OK. Do not use tools."
teamclaude status
```

Use a model available to your accounts. These tests consume a small amount of quota. Confirm successful responses and an increase in the corresponding account's request count. For request-level evidence, use the TUI activity view or [activity logging](docs/usage.md#request-logging). A healthy status endpoint alone does not prove the client uses the proxy.

When one Claude account has spent its Fable quota, the live status should select another eligible account for Fable. The global current-account marker can still name the first account. To prefer Fable-depleted accounts for Opus, Sonnet, and Haiku too, merge `"preferFableDepletedAccounts": true` into TeamClaude's config and reload it. That optional preference is off by default; see [Fable quota preservation](docs/routing.md#prefer-accounts-with-depleted-fable-quota).

Test desktop sessions separately. Codex's bundled desktop executable and CLI have been verified with this setup. **Claude desktop Code routing remains unverified**: its launcher can supply its own provider settings, and a successful Claude CLI test does not prove desktop routing. The regular Claude Chat tab does not use these agent instructions. Confirm a real local Code request in TeamClaude before relying on desktop rotation.

### Scheduled jobs and cross-review pollers

Configure the machine and OS user that actually runs the job. launchd, systemd, and `env -i` do not inherit an interactive shell's aliases or exports.

For a Codex reviewer that uses a temporary `HOME`, preserve an absolute `CODEX_HOME` pointing to the configured Codex directory. For a Claude reviewer that clears the environment or excludes user settings, pass both Claude proxy variables explicitly to its process. Check the job's actual launch command and logs, not only a manual terminal invocation.

Verify that the scheduler can execute the script and that requests reach TeamClaude. For example, launchd exit code `126` with `Operation not permitted` means the job failed before inference; changing routing settings will not repair that launch failure. Keep existing schedules on their current host unless you intend to move them.

## What it does

- Rotates to the next account when the 5h session or 7d weekly bucket reaches the threshold (98% by default), preferring the account whose weekly quota resets soonest.
- Tracks the per-model weekly cap separately, so an account out of Fable quota is skipped for Fable requests and still serves Opus and Sonnet.
- Tells a spent quota bucket apart from a per-minute rate limit and only rotates on the first one. Rotating on a rate limit would just move the burst to the next account and drop the warm cache, so it paces the same account instead.
- Paces requests onto a freshly switched account, so a herd of agents failing over at the same instant doesn't throttle it and cascade down the fleet.
- TUI with quota bars, reset countdowns, activity log, and settings you can change while it runs, including adding and removing accounts.
- Catches hardcoded `api.anthropic.com` endpoints (the Claude Design MCP, for one) through a local MITM forward proxy, not only what `ANTHROPIC_BASE_URL` covers.
- Holds the request open until quota resets instead of returning 429 when every account is spent, so an unattended run finishes on its own (`holdSeconds`, off by default).
- Refreshes OAuth tokens before they expire and writes them back to config. Client refreshes pass through untouched.
- Pools OpenAI Codex subscriptions alongside Claude accounts (experimental): the Codex CLI is routed through the same proxy, by config or transparently through the MITM proxy, and rotates on its own quota.
- Takes any Anthropic-compatible API (DeepSeek, GLM) as a low-priority fallback for when the Claude accounts are done.
- No dependencies. Node built-ins only.

## Everyday commands

```bash
teamclaude accounts          # accounts with tier and token status
teamclaude status            # live proxy status, needs a running server
teamclaude disable <name>    # pause an account without removing it
teamclaude priority <name> 1 # rotation order, lower = preferred
teamclaude alias --install   # make plain `claude` go through the proxy
teamclaude help              # everything else
```

Full reference: [docs/usage.md](docs/usage.md).

## Configuration

Config is at `~/.config/teamclaude.json` (`$XDG_CONFIG_HOME` honoured) and is meant to be hand-editable. A proxy API key is generated on first use. Observed quota goes to a separate `teamclaude.state.json` next to it, safe to delete since quota gets re-learned from traffic.

Detected resets and queued Chat notifications use a separate private file, defaulting to `teamclaude.json.resets.json`. Deleting it loses reset counts, history, and pending notifications. Keep the webhook URL in a private runtime file. See [reset configuration](docs/reset-tracking.md#google-chat-notifications).

Every field, plus environment variables and network tuning: [docs/configuration.md](docs/configuration.md).

## How it works

1. Claude Code talks to the local proxy instead of `api.anthropic.com`.
2. The proxy picks an eligible account, injects that account's real token, and rewrites `account_uuid` in the body to match.
3. `anthropic-ratelimit-unified-*` response headers feed the session (5h) and weekly (7d) quota view, which survives a restart.
4. At the threshold, rotation moves on. On a quota 429 the request is resent on another account, so the client never sees the limit while some account still has headroom.
5. Expiring tokens, transient network errors and client token refreshes are handled inside the proxy, so none of them interrupt the session.

Step-by-step lifecycle: [docs/routing.md](docs/routing.md#request-lifecycle).

## Documentation

| Page | Contents |
| --- | --- |
| [Accounts](docs/accounts.md) | OAuth login, import, API keys, multiple orgs, Codex accounts, third-party backends |
| [Usage](docs/usage.md) | Server and TUI, running Claude Code, shell alias, command reference, logging |
| [Routing](docs/routing.md) | Rotation, the two kinds of 429, storm control, model routes, session spreading, pinning, prompt cache |
| [Forecasts](docs/forecast/README.md) | Account-level depletion estimates, reset comparisons, model constraint advice, and history configuration |
| [Quota](docs/quota.md) | Claude and Codex quota probes, keep-warm, holding on exhaustion |
| [LAN dashboard](docs/lan-dashboard.md) | Password gate, persistent service, dashboard deployment and operation |
| [Reset tracking](docs/reset-tracking.md) | Detection rules, banked credits, persistent history, Google Chat configuration |
| [Codex remote access](docs/codex-remote-access.md) | Native desktop login and pooled model subscription separation |
| [MOT changes](docs/fork-changes.md) | Features, fixes, merged PRs, and deployment boundaries |
| [Configuration](docs/configuration.md) | Config format, every field, environment variables, network tuning |
| [Proxy modes](docs/proxy-modes.md) | MITM forward proxy, sx.org residential egress |
| [Compliance](docs/compliance.md) | Terms of service notes |

## Security

The upstream sources are [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) and the [`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude) npm package. MOT maintains this source fork separately and does not publish a separate npm package. TeamClaude is **never** distributed as a downloadable binary archive, so be wary of soft-forks that bundle a `.zip` and tell you to extract and run it. See [SECURITY.md](SECURITY.md) for details and how to report issues.

## Compliance

TeamClaude is a local proxy holding your own credentials and driving your own Claude Code CLI. How that lines up with Anthropic's terms, including the multi-subscription question people ask most, is written up in [docs/compliance.md](docs/compliance.md). Not legal advice.

## Star history

<a href="https://www.star-history.com/?repos=KarpelesLab%2Fteamclaude&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT. See [LICENSE](LICENSE).

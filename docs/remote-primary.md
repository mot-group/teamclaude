# Use a remote TeamClaude primary with local fallback

Each client keeps its existing local TeamClaude listener, credentials, service, and CA. Model requests go to an authenticated remote TeamClaude first. When that host is unavailable, subsequent new requests use the local account pool. Native identity requests, Remote Control WebSockets, local administration, and unrelated CONNECT traffic keep their existing local paths.

This mode replaces a separate front proxy. The shared inference listener covers both `ANTHROPIC_BASE_URL` and intercepted CONNECT requests, so existing Claude proxy integrations keep working. No inference request goes directly to a provider outside TeamClaude.

## Configure the primary

Use a reviewed release with `/teamclaude/health`. Set a stable random `proxy.instanceId` in the primary's configuration. Keep it unchanged across restarts and upgrades. Set `proxy.trustLoopback=false` when a local TLS terminator such as Tailscale Serve fronts the listener.

Create a distinct `proxy.clientKeys` entry for each machine. Distribute only that machine's key to a protected file on that machine. Do not distribute the primary's administrative key or provider refresh tokens.

The primary must not have its own `remotePrimary` configuration. Chained primary routing is rejected. Its authenticated health response must name the expected instance and have `acceptsRelay: true`.

## Configure each client

Keep independently enrolled local accounts available for fallback. Do not copy refresh tokens between independently refreshing processes. Shared subscriptions still have shared quota. For the same reason, `teamclaude callback login` refuses on an install with `remotePrimary` set: callback.net credential sync uploads every OAuth refresh token and has signed-in installs adopt each other's. Do not run it on the primary either.

On a client with the quota probe on, the account Details line "Outside this proxy" counts the primary's spend on shared subscriptions as spend that went elsewhere. That reading is correct for the client and needs no action.

Add this block to the client's TeamClaude configuration, substituting the actual HTTPS hostname, absolute key file path, and primary instance ID:

```json
{
  "remotePrimary": {
    "url": "https://primary.example.ts.net",
    "apiKeyFile": "/absolute/private/path/client.key",
    "instanceId": "the-primary-instance-id",
    "mode": "auto"
  }
}
```

Restart the local TeamClaude service after changing this block or the client key file. Credentials never belong in URLs, repositories, or logs. HTTPS certificate validation stays enabled. HTTP is supported only for literal loopback destinations used by local tests.

Keep Claude and Codex endpoints pointed at the local listener, normally `127.0.0.1:3456`. Retain the native app login. A direct remote base URL would bypass local fallback. Explicit `/tc-acct/` and MITM `TC_ACCT` account pins stay local, including the existing keep-warm scheduler. They never cross independent pools. Remove stale pins from ordinary fleet launchers to avoid intentionally bypassing the primary. The maintained review launchers reject `TC_ACCT` when a remote primary is configured unless mode is `local-only`.

Supported remote paths are Claude messages, token counting, and model listing, plus Codex responses, response compaction, and model listing. Other paths retain existing behavior. Identity-bound traffic deliberately keeps the native client's credentials and local route.

## Failure and recovery

The client probes authenticated `/teamclaude/health` every five seconds, with a two-second deadline. The response must identify the configured primary. A new process waits for its first probe before routing model requests.

- Three consecutive availability failures switch new work to the local pool. A connection failure while sending a model request switches subsequent work immediately.
- The failed request is never replayed across proxies, even if no response headers arrived. A partial response remains an interruption. Client retries are outside this guarantee.
- Return to primary requires at least 13 successful probes and at least 60 elapsed seconds since the first success. A failed probe resets both recovery conditions.
- Authentication failure, wrong instance identity, malformed health data, and TLS failures block routing rather than silently falling back. A later availability failure does not clear that block. Sustained successful probes can restore the primary.
- Quota errors, unsupported models, and inference 5xx responses are returned unchanged. A healthy process cannot prove upstream inference works. Provider failures still require diagnosis.
- A primary transport outage does not increase quota or repair local credentials. If the local pool cannot serve the requested model, the existing TeamClaude error is returned.

`mode` can also be `primary-only` or `local-only`. These are explicit maintenance choices and require a service restart. `local-only` does not probe the primary. Do not use it to hide an authentication failure.

## Verify routing

Read the local authenticated `/teamclaude/health` or `/teamclaude/status`. `remotePrimary` reports `route`, `reason`, consecutive probe counts, and counts of forwarded, local, and in-flight model requests. It contains no client key or account credentials.

Normal local account and quota status still describes the local fallback pool. Read the central dashboard for primary usage. Do not add the same subscription's quota percentages across machines. The primary's named client counters and a real model response establish where inference ran.

Test both base URL and CONNECT clients, cancellation, a broken stream, an unreachable primary, authentication refusal, and sustained recovery. Test native identity and remote-control features separately. Stateful response IDs or account-bound conversation references may not survive failover. Start a fresh conversation when the client reports that recovery is needed.

## Roll back

Stop new work and drain the local proxy. Remove only the `remotePrimary` block, then restart TeamClaude. Existing local account files and client endpoints remain in place. Revoke the machine's remote client key if abandoning enrollment. Do not restore stale provider credentials from a backup.

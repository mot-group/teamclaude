# Codex Desktop remote access and model routing

Keeping a Codex Desktop remote target online and choosing the subscription used for model requests are separate in the tested setup. The desktop retains its native ChatGPT login for remote access. The Linux target's Codex model-provider configuration sends model requests to TeamClaude, which injects the credentials of the selected pooled subscription.

This behavior was verified on 2026-09-09 with Codex Desktop's bundled CLI version `0.153.4`, a MacBook Pro client, and a Linux target. It is an intended deployment behavior. Preserve the native desktop login when changing the subscription used for model requests. Do not sign out or replace that login merely to match the account selected by the proxy.

## Example

| Role | Account or configuration |
| --- | --- |
| Mac Codex Desktop login | Account A |
| Linux native Codex login and remote-target access | Account A |
| TeamClaude subscription selected for model requests | Separately enrolled account B, named `codex-2` in this example |

The request path is Mac Codex Desktop → Linux remote target → TeamClaude → account B. The Mac's login does not force the Linux target's model requests to use account A when the target has a custom model provider.

For a desktop host with a native ChatGPT login, use this provider configuration
in `~/.codex/config.toml`:

```toml
model_provider = "teamclaude"

[model_providers.teamclaude]
name = "TeamClaude codex-2"
base_url = "http://127.0.0.1:3456/tc-acct/codex-2/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
```

Use the name of an enrolled Codex account in place of `codex-2`. The path pin fixes requests to that account and bypasses rotation. The loopback listener accepts the local request; TeamClaude supplies the selected subscription's Bearer token and ChatGPT account ID upstream. This example does not expose the inference listener over the LAN.

Enroll pooled subscriptions separately with `teamclaude login --codex`. Keep those grants separate from the native desktop credentials. Avoid copying a native refresh token into another independently refreshing client. The maintained Linux setup uses directly enrolled credentials in TeamClaude and preserves the native Codex auth file.

The credential-ownership fix for issue #7 preserves this setup and the provider
model-routing configuration. An enrolled account retains its own tokens and ChatGPT
account ID across reload, save and restart. If an older version already saved
substituted credentials, re-enroll the pooled account. Keep the native desktop
login in place.

## Preserve desktop account settings

Set `requires_openai_auth = true` to keep the native ChatGPT account available
to the desktop app. With `false`, Codex can return no account even when a saved
ChatGPT login exists. The profile menu can show the provider name, and
**Settings > Connections** can show only SSH instead of the remote-control tabs.
Existing authorized connections may still work. Their availability does not
prove that the account settings remain accessible.

The original Linux test on 2026-09-09 used `false` and verified an existing
remote connection. The example above now uses `true` to preserve native account
features. This follows the [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#alternative-model-providers)
for custom providers.

On 2026-09-11, the backend bundled with ChatGPT for macOS `26.903.71938`, build
`8576`, returned these results for `account/read` with `refreshToken: false`:

| `requires_openai_auth` | `account` | `requiresOpenaiAuth` |
| --- | --- | --- |
| `false` | `null` | `false` |
| `true` | Native account with `type: "chatgpt"` | `true` |

Both checks used the same saved login and TeamClaude base URL. A separate test
of the installed proxy sent dummy native credentials through a local upstream
server and confirmed that TeamClaude replaced both the Bearer token and the
ChatGPT account ID with the selected pool account's credentials.

After changing the setting, finish active desktop tasks, then quit and reopen
the app. Check the profile menu and **Settings > Connections**. Visual
confirmation after restart was still pending when this backend check was
recorded. This setting does not change device pairings or the selected pool
account.

## Verify the two roles

Check the desktop's signed-in account and whether the remote target is available. Then check the target's effective model-provider configuration, the session's recorded provider, and TeamClaude's activity log. A successful model request logged as `codex-2 [pin]` identifies the selected pool entry. The dashboard's global current-account label alone does not establish which account serves Codex; explicit pins and model routes determine that.

After upgrading, also verify that the selected entry's ChatGPT account ID is B's
and that the remote target remains accessible after restarting TeamClaude. The
`codex-2 [pin]` label identifies the config entry; by itself it cannot detect old
credentials substituted under that name. Regression tests capture the actual
upstream Bearer token and account-ID header using dummy credentials and a local
server, including after refresh, save and restart.

In the verified setup, the Linux desktop backend had an active connection to TeamClaude on loopback, the desktop session recorded `model_provider: teamclaude`, and the proxy recorded successful pinned requests to an account whose subscription ID differed from the native login. The user confirmed that the target remained accessible from the Mac.

The configuration above changes model routing. It does not enroll a remote target or grant another desktop access to it. This is an observed integration behavior, not a guarantee that future Codex versions will keep the same authentication and remote-access behavior.

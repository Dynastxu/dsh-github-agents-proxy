# dsh-github-agents-proxy

English | [中文](README.md)

GitHub App proxy for DeepSeek Harness. Configure one App credential set once;
Agents then use `gh`/`git` through the App installation token, so pushes are
attributed to the App's bot identity. The token is refreshed on demand.

This stage owns the token, `gh` authentication, and Git identity injection for
Agent child processes. Commit-history rewriting, Verified signing, and PR
attribution are later steps.

## What it does

- Adds `refresh_ghapp_token` and `check_ghapp_token_status`.
- Shows the cached token's live state and remaining lifetime beside the settings
  page title: not configured, not activated, active, expiring, expired, or
  unreadable.
- Injects one fixed-prefix token snapshot into runtime context at conversation
  start, when the token crosses the refresh threshold, and after a successful
  refresh.
- Derives the App bot login/user id from the App ID and private key, then
  injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` into the Host process so Agent
  child-process `git commit` uses the bot identity. No repository or global git
  configuration is changed.
- Provides `commit_changes`, which sets the bot identity for one commit and
  appends the user's `Co-authored-by` trailer. A setting can block raw
  `git commit`, and a system-prompt section tells Agents to use the tool.
- Stores the installation token in a private file (`0600` where the platform
  supports it) and refreshes it under a cross-process file lock with a
  double-check after the lock.
- Runs no daemon, timer, scheduled task, or background job. Nothing refreshes
  unless an Agent calls the tool; status is evaluated during ordinary prompt
  assembly.

The plugin does not intercept or wrap `gh`. It owns the token and tells the
Agent where the token file is; the caller launches `gh` with that token (see
[Use the token with gh](#use-the-token-with-gh)).

## Install

The package ships a bundle patch, so a profile can load it by package name:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@dynastxu/dsh-github-agents-proxy"]
    }
  }
}
```

The patch inserts the `github-agents-proxy` row. Configure that row in the
profile's `cordis.patch.yml`:

```yaml
- id: github-agents-proxy
  config:
    appId: 123456
    installationId: 98765432
    privateKeyPath: /home/me/.dsh/github-app.pem
```

Set all three credential fields, or leave all of them out. A partial set fails
at load with the missing field names.

## Web settings page

The browser half registers **Settings → GitHub App token**. It edits the
active profile's volatile Config fields and writes them through the profile's
`cordis.patch.yml`, so no hand-editing is required:

- App ID and Installation ID
- private-key source (file path or DSH credential reference) and value
- token cache path, refresh threshold, and GitHub API base URL
- whether the runtime status snapshot is injected

A status badge beside the title shows the cached token's live state: `Not
configured`, `Not activated`, `Active · 28m2s left`, `Expiring · 1m52s left`,
`Expired`, or `Token unreadable`. Hover it for the expiry instant and the token
file. While the page is open it reads `GET /api/github-agents-proxy/status`
every 15 seconds; that route only reads the local token file — no GitHub
request, no refresh lock — and the page counts down on the Host clock, one
second at a time. Polling stops when the page closes. A Host without a Web
carrier reports `Status unavailable`.

Saving validates the positive IDs, key source, and URL, then submits through
`ctx.configForms`. The Host receives `loader/volatile-update` and rebuilds the
token manager, so the next tool call and status injection use the new values.
The browser half loads with the Web client; restart the DSH Host after upgrading
(and reload the page if needed) to see the page.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `appId` | required with credentials | GitHub App ID. Numbers and numeric strings are accepted. |
| `installationId` | required with credentials | Installation ID for the repository set the Agent may use. |
| `privateKeyPath` | — | PEM private-key path. Mutually exclusive with `privateKeyEnv`. |
| `privateKeyEnv` | — | Credential reference resolved through `ctx.credentials`; falls back to the process environment when the credential service is absent. |
| `tokenPath` | `<profile dir>/github-app-token.json` | Cached installation-token file. |
| `refreshThresholdSeconds` | `300` | Refresh when less than this many seconds remain. `0` refreshes only an expired token. |
| `apiBaseUrl` | `https://api.github.com` | GitHub API origin, including a GitHub Enterprise `api/v3` path when needed. |
| `contextInjection` | `true` | Inject the runtime-context status snapshot. |
| `configureGh` | `true` | Run `gh auth login --with-token` after refresh so plain `gh` commands use the token; global git settings are left untouched. |
| `blockRawGitCommit` | `false` | Deny direct `git commit` in bash/pwsh and require `commit_changes`. A command guardrail, not a security boundary. |

### Keep the private key out of the repository

`privateKeyPath` should point outside the checkout, or set
`.dsh/github-app.pem` as an ignored local file. For DSH-managed storage, use
`privateKeyEnv` and put the PEM in `$DSH_HOME/.credentials.yaml`:

```yaml
version: 1
refs:
  GITHUB_APP_PRIVATE_KEY: |
    -----BEGIN RSA PRIVATE KEY-----
    …
    -----END RSA PRIVATE KEY-----
```

Then configure `privateKeyEnv: GITHUB_APP_PRIVATE_KEY`. The credential service
resolves the reference at each refresh, so rotating the key takes effect on the
next call without restarting DSH.

The private key is never written to the token file, tool result, or context
snapshot.

## Tools

### `refresh_ghapp_token`

Use it when:

- `gh` returns `401`, `Bad credentials`, or otherwise says the token is invalid;
- the injected status says `missing`, `expired`, or warns that the token is
  about to expire;
- a workflow needs a new installation token immediately.

The tool takes the refresh lock, re-reads the cached token, and returns
`reason=token_still_valid` without contacting GitHub when the token has more
than the configured threshold left. If another Agent refreshed while this call
waited for the lock, the second call sees the new expiry and does not make a
duplicate GitHub request.

`force: true` skips the expiry check. On a 401, call the tool without `force`
first; if it returns `token_still_valid` while `gh` still reports 401, the token
may have been revoked, so retry with `force: true`. Otherwise use `force` only
when a still-valid token must be replaced.

Success:

```json
{ "ok": true, "refreshed": true, "expires_at": "2026-11-10T23:05:00Z", "expires_in_seconds": 3580, "token_file": "…/github-app-token.json" }
```

Still valid:

```json
{
  "ok": false,
  "reason": "token_still_valid",
  "expires_at": "2026-11-10T23:05:00Z",
  "expires_in_seconds": 1800,
  "hint": "The cached token is still valid. If gh still returns 401, call refresh_ghapp_token with force=true to replace a revoked token."
}
```

A failed exchange and missing configuration are separate structured results:
`reason=refresh_failed` carries a bounded message and actionable hint;
`reason=not_configured` lists `appId`, `installationId`, and
`privateKeyPath`/`privateKeyEnv`.

### `check_ghapp_token_status`

Reads the cached file without calling GitHub. It returns `valid`, `expiring`,
`expired`, `missing`, `invalid`, or `unconfigured`, plus `expires_at`,
`remaining`, `needs_refresh`, and the token file path. Use it when the status
snapshot is absent or a workflow needs a fresh local reading.

## Agent commit identity

The settings page does not ask for the bot name/email. The plugin uses the
existing App ID and private key to call:

```text
GET /app                         → slug = dsh-agents
GET /users/dsh-agents%5Bbot%5D  → id = 354391007, login = dsh-agents[bot]
```

and derives:

```text
GIT_AUTHOR_NAME      = dsh-agents[bot]
GIT_AUTHOR_EMAIL     = 354391007+dsh-agents[bot]@users.noreply.github.com
GIT_COMMITTER_NAME   = dsh-agents[bot]
GIT_COMMITTER_EMAIL  = 354391007+dsh-agents[bot]@users.noreply.github.com
```

These four variables enter only the Host process environment, where Agent
bash/pwsh children inherit them. The plugin runs no `git config` and changes no
repository or global git configuration; the prior values are restored on
dispose. Commits made in an external terminal are unaffected.

Limits:

- Local `git commit` is authored/committed by the bot but remains
  `verified: false`; signing/Verified is not part of this stage.
- An Agent that explicitly runs `git commit --author=...` or overrides
  `GIT_AUTHOR_*` can still bypass the identity.
- A remote SSH/container git environment inherits these variables only if that
  environment forwards them.
- If bot identity resolution fails at startup, the plugin still loads without
  injecting identity and retries after a successful token refresh.

## `commit_changes` and the raw-commit guard

A system-prompt section tells Agents to use `commit_changes` instead of a raw
`git commit`.

Tool parameters:

| Parameter | Meaning |
|---|---|
| `message` | Commit message; required |
| `stage` | `all` / `tracked` / `staged`; defaults to `all` |
| `allow_empty` | Allow an empty commit |
| `amend` | Amend the current HEAD |

The tool:

1. Reads the user's `user.name` / `user.email` from global git config;
2. Runs `git add` and `git commit` with the App bot identity;
3. Appends:
   ```text
   Co-authored-by: <user name> <user email>
   ```
4. Returns `sha`, `branch`, `author`, `committer`, and `co_author`;
5. Does not push.

When **Block raw git commit** is enabled, `tools/pre-execute` denies bash/pwsh
commands that invoke `git commit` and points the Agent at `commit_changes`.

The guard inspects only the shell command text submitted by the model; scripts,
Git aliases, and indirect loaders can bypass it, so it is not a security
boundary. Commands such as `git merge`, `git rebase`, and `git cherry-pick`
are not blocked and still rely on the process-level bot identity.

## Runtime-context snapshot

One fixed-prefix block is injected at the first prompt assembly and again only
when the state changes:

```text
[github-app-token] status=valid, expires_at=2026-11-10T23:05:00Z, remaining=28m2s, token_file=…/github-app-token.json
```

Inside the threshold:

```text
[github-app-token] status=valid, expires_at=2026-11-10T23:05:00Z, remaining=1m52s, token_file=…/github-app-token.json
WARN: The github-app-token is about to expire. Use refresh_ghapp_token to refresh it
```

Missing, expired, invalid, and unconfigured states add one actionable hint
line. The `remaining` value is the value at the instant the snapshot was
created; identical text is not re-injected on later steps. The Agent loop's
runtime-context projection performs the de-duplication, so a long turn does not
accumulate one status message per step.

## Use the token with gh

After a successful refresh the plugin runs `gh auth login --with-token`, so
plain `gh` commands use the token. It does not run `gh auth setup-git` and does
not write the global git `credential.helper`. DSH's shell executor strips
credential-shaped variables inherited from the Host process, so setting
`GH_TOKEN` in the Host does not reach bash. The token file remains available as
a manual fallback:

```sh
TOKEN_FILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/github-app-token.json"
GH_TOKEN="$(jq -r .token "$TOKEN_FILE")" gh pr list
```

PowerShell:

```powershell
$token = (Get-Content "$env:DSH_HOME\profiles\web\github-app-token.json" | ConvertFrom-Json).token
$env:GH_TOKEN = $token
gh pr list
```

The snapshot includes `token_file`, so the Agent can locate the file without
guessing the profile path. If a deployment already has a `gh` wrapper that
reads this file, that wrapper can use the file directly and needs no command
change.

## Concurrency and security

- Every refresh runs under `<tokenPath>.lock`; a second caller waits, re-reads
  the token, and returns without a duplicate exchange when the first caller
  already refreshed it.
- The token file is replaced atomically through a same-directory temporary
  file and `rename`.
- The token file is created with owner-only permissions (`0600`). On Windows
  the mode is best-effort, as with the rest of DSH's file stores.
- An abandoned lock is reclaimed after two minutes; a normal lock wait is
  bounded to ten seconds and honors tool cancellation.
- No token, JWT, or private-key material is returned to the model. GitHub error
  bodies are truncated before they become tool output.
- `configureGh: true` runs `gh auth login --with-token`, which writes only gh's
  shared credential store; global git settings are untouched. Set it to `false`
  to avoid that side effect and set `GH_TOKEN` from the token file manually.
- Older builds ran `gh auth setup-git` and may have left a global
  `credential.https://github.com.helper`; remove it once with
  `git config --global --unset-all credential.https://github.com.helper`.

## Non-goals

- No daemon, timer, watchdog, or scheduled refresh loop.
- No dependency on a long-lived session or background job.
- No interception or wrapping of `gh`.
- No multi-App or multi-installation routing; one plugin instance manages one
  installation.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

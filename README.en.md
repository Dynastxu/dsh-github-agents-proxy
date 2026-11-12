# dsh-github-agents-proxy

English | [中文](README.md)

Make DeepSeek Harness Agents work as a GitHub App. Configure one App credential
set once, and `gh`, `git`, and pull-request operations use that App's
installation token, so commits and pull requests belong to the App bot. The
token refreshes on demand.

## Features

- Agent commits use the App bot identity and keep your `Co-authored-by` trailer.
- Agents open pull requests as the App bot.
- Configure credentials in **Settings → GitHub App token**; no bot name/email is
  required.
- Shows the token state and remaining lifetime, and refreshes on demand when
  the token expires or is about to.

## Install

Before you start, you need a GitHub App installed on the target repository with
at least write access to Contents and Pull requests, plus its App ID,
installation ID, and private-key PEM. The environment where Agents run must have
the `gh` command.

The package is published on npm. In the app, open **Plugins → Add plugin →
Install a third-party plugin**, enter `@dynastxu/dsh-github-agents-proxy`, and
confirm.

Or install it into the profile you use from the CLI:

```sh
dsh plugin --profile <profile> add @dynastxu/dsh-github-agents-proxy
```

Replace `<profile>` with the profile in use (for example `web` or `desktop`).
Restart DSH, then open **Settings → GitHub App token** to enter the credentials.
The settings page saves automatically.

## Configuration

The settings page exposes every option and shows the cached token state live:
active, expiring, expired, and so on. The private key can come from a file path,
a DSH credential reference, or, in the Desktop app, the folder button that picks
the PEM file.

| Field | Default | Meaning |
|---|---|---|
| `appId` | required with credentials | GitHub App ID. |
| `installationId` | required with credentials | Installation ID from installing the App on the target repositories. |
| `privateKeyPath` | — | PEM private-key path. Use it or `privateKeyEnv`. |
| `privateKeyEnv` | — | Name of the DSH credential that holds the private key. |
| `tokenPath` | `<profile dir>/github-app-token.json` | Token cache file. |
| `refreshThresholdSeconds` | `300` | Refresh when less than this many seconds remain. |
| `apiBaseUrl` | `https://api.github.com` | GitHub API origin, including a GitHub Enterprise `api/v3` path when needed. |
| `contextInjection` | `true` | Inject the token state into the conversation. |
| `configureGh` | `true` | Let plain `gh` commands use the token after a refresh. |
| `blockRawGitCommit` | `false` | Deny raw `git commit` from Agents and require `commit_changes`. |

Without a Web settings page, configure the `github-agents-proxy` row in the
profile's `cordis.patch.yml` instead.

### Private-key safety

Do not commit the private key. Keep it outside the checkout or add it to the
ignore list; you can also store it in `$DSH_HOME/.credentials.yaml` and choose
the DSH credential reference in the settings page. The private key never appears
in the token file, tool results, or conversation context.

## Tools

### `commit_changes`

Commits the current changes with the App bot as author and committer, and
appends:

```text
Co-authored-by: <your name> <your email>
```

Parameters: `message` (required), `stage` (`all` / `tracked` / `staged`,
default `all`), `allow_empty`, and `amend`. It does not push.

With **Block raw git commit** enabled, a raw `git commit` from an Agent is
denied and the Agent is pointed at this tool. The guard inspects command text
only; it is not a security boundary.

### `create_pull_request`

Creates a pull request as the App. Parameters: `title` (required), `body`,
`base`, `head`, `draft`, and `repo`. Defaults come from the working directory,
the checked-out branch, and the repository default branch.

The `head` branch must already be pushed; the tool neither commits nor pushes.
When an open pull request already uses the same `head`, it returns that pull
request instead of creating a duplicate.

### `refresh_ghapp_token`

Refreshes the installation token. Use it when:

- `gh` returns `401` or `Bad credentials`;
- the state says `missing`, `expired`, or warns that the token is about to
  expire;
- a workflow needs a new token immediately.

A still-valid token returns `token_still_valid` without calling GitHub.
`force: true` skips the expiry check and replaces a revoked token.

### `check_ghapp_token_status`

Reads only the local cache and does not call GitHub. It returns `valid`,
`expiring`, `expired`, `missing`, `invalid`, or `unconfigured`, plus the expiry,
remaining lifetime, and token file location.

## Commit identity

The settings page does not ask for the bot name/email. The plugin reads the App
slug, looks up the matching bot user, and derives the login and user ID, then
sets:

```text
<app-slug>[bot] <bot-user-id>+<app-slug>[bot]@users.noreply.github.com>
```

The values depend on your App.

The identity is injected into Agent child processes only. The plugin does not
change repository or global git configuration, and commits from an external
terminal are unaffected.

Limits:

- Local commits remain `verified: false`; signing is not supported yet.
- An Agent that explicitly runs `git commit --author=...` or overrides
  `GIT_AUTHOR_*` can bypass the identity.
- A remote SSH or container git environment inherits the identity only if that
  environment forwards it.

## Usage notes

- After a refresh, the plugin runs `gh auth login --with-token`, so plain `gh`
  commands use the token.
- The token state appears in conversation context as `[github-app-token] ...`;
  when it shows expired or expiring, ask the Agent to refresh.
- The token is cached by default in the profile's `github-app-token.json`; read
  that file when you need the token manually.
- Private keys, JWTs, and tokens never reach the model; the token file is
  owner-only where the platform supports it.
- The plugin runs no background tasks; it contacts GitHub only when an Agent
  calls a tool.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

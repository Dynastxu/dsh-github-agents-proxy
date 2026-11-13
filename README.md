# dsh-github-agents-proxy

[English](README.en.md) | 中文

让 DeepSeek Harness 的 Agent 以 GitHub App 身份工作。配置一次 App 凭证后，`gh`、`git` 和 PR 操作都使用该 App 的 Installation Token，提交与 PR 归属于 App 的 bot；令牌在需要时刷新。

## 功能

- Agent 的提交自动使用 App bot 身份，并追加你的 `Co-authored-by`。
- Agent 以 App bot 身份创建 PR。
- 在 **设置 → GitHub App 令牌** 中填写凭证；无需填写 bot 的 name/email。
- 显示令牌状态与剩余时间，过期或即将过期时由 Agent 按需刷新。

## 安装

开始前需要一个已安装到目标仓库的 GitHub App，至少授予 Contents 与 Pull requests 的读写权限，并取得它的 App ID、Installation ID 和私钥 PEM。Agents 所在环境必须拥有 gh 命令。

包已发布到 npm，推荐在界面中安装：打开 **插件 → 添加插件 → 安装第三方插件**，填入包名 `@dynastxu/dsh-github-agents-proxy`，确认安装。

也可以用 CLI 安装到正在使用的 profile：

```sh
dsh plugin --profile <profile> add @dynastxu/dsh-github-agents-proxy
```

把 `<profile>` 换成实际使用的 profile（例如 `web`、`desktop`）。安装后重启 DSH，打开 **设置 → GitHub App 令牌** 填写凭证。设置页会自动保存。

## 配置

设置页提供全部选项，并实时显示缓存令牌的状态：已激活、即将过期、已过期等。页头显示从 GitHub 读取的 App 名称与头像；读取失败时回退为「GitHub App 令牌」。私钥可以用文件路径、DSH 凭据引用，或在 Desktop 中用文件夹按钮选择 PEM 文件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `appId` | 配置凭证时必填 | GitHub App ID。 |
| `installationId` | 配置凭证时必填 | App 安装到目标仓库后得到的 Installation ID。 |
| `privateKeyPath` | — | PEM 私钥路径。与 `privateKeyEnv` 二选一。 |
| `privateKeyEnv` | — | 通过 DSH 凭据保存私钥时引用的名称。 |
| `tokenPath` | `<profile 目录>/github-app-token.json` | 令牌缓存文件。 |
| `refreshThresholdSeconds` | `300` | 剩余时间低于该秒数时刷新。 |
| `apiBaseUrl` | `https://api.github.com` | GitHub API 地址，GitHub Enterprise 可带 `api/v3`。 |
| `contextInjection` | `true` | 是否在对话中注入令牌状态。 |
| `configureGh` | `true` | 刷新后让普通 `gh` 命令使用该令牌。 |
| `blockRawGitCommit` | `false` | 拒绝 Agent 直接执行 `git commit`，要求使用 `commit_changes`。 |

没有 Web 设置页时，在 profile 的 `cordis.patch.yml` 中配置 `github-agents-proxy` 行即可。

### 私钥安全

私钥不要提交到仓库。把它放在 checkout 之外，或加入忽略列表；也可以存进 `$DSH_HOME/.credentials.yaml`，再在设置页选择 DSH 凭据引用。私钥不会出现在令牌文件、工具结果或对话上下文中。

## 工具

### `commit_changes`

提交当前改动，使用 App bot 作为 author 和 committer，并自动追加：

```text
Co-authored-by: <你的名字> <你的邮箱>
```

参数：`message`（必填）、`stage`（`all` / `tracked` / `staged`，默认 `all`）、`allow_empty`、`amend`。默认不 push。

开启 **阻断普通 git commit** 后，Agent 直接执行 `git commit` 会被拒绝并提示改用此工具。该护栏只检查命令文本，不是安全边界。

### `create_pull_request`

以 App 身份创建 PR。参数：`title`（必填）、`body`、`base`、`head`、`draft`、`repo`。默认使用工作目录的仓库、当前检出的分支和仓库默认分支。

`head` 分支必须已推送到远端；工具不提交、不推送。同一 `head` 已有 open PR 时直接返回该 PR，不会重复创建。

### `refresh_ghapp_token`

刷新 Installation Token。遇到以下情况时调用：

- `gh` 返回 `401` 或 `Bad credentials`；
- 状态显示 `missing`、`expired`，或提示即将过期；
- 需要立即获得新令牌。

令牌仍然有效时直接返回 `token_still_valid`，不访问 GitHub。`force: true` 会跳过有效期判断，用于替换被撤销的令牌。

### `check_ghapp_token_status`

只读取本地缓存，不访问 GitHub。返回 `valid`、`expiring`、`expired`、`missing`、`invalid` 或 `unconfigured`，以及有效期、剩余时间和令牌文件位置。

## 提交身份

设置页不需要填写 bot 的 name/email。插件读取 App 的 slug，再查询对应的 bot 用户，得到 login 和用户 ID，并据此设置：

```text
<app-slug>[bot] <bot-user-id>+<app-slug>[bot]@users.noreply.github.com
```

这些值取决于你自己的 App。

身份只注入 Agent 子进程，插件不修改仓库或全局 git 配置，外部终端的提交不受影响。

限制：

- 本地提交的 `verified` 为 `false`，暂不支持签名。
- Agent 显式使用 `git commit --author=...` 或覆盖 `GIT_AUTHOR_*` 时可以绕过。
- 远程 SSH 或容器中的 git 是否继承身份取决于该环境。

## 使用提示

- 刷新成功后，插件会执行 `gh auth login --with-token`，普通 `gh` 命令可以直接使用。
- 令牌状态会以 `[github-app-token] ...` 出现在对话上下文中；显示过期或即将过期时，让 Agent 刷新即可。
- 令牌默认缓存在 profile 目录的 `github-app-token.json`，需要手动使用令牌时可以读取该文件。
- 私钥、JWT 和令牌不会返回给模型；令牌文件在平台支持时仅当前用户可读。
- 插件不运行后台任务；只有 Agent 调用工具时才会访问 GitHub。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

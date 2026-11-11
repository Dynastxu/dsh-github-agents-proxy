# dsh-github-agents-proxy

[English](README.en.md) | 中文

DeepSeek Harness 的 GitHub App 代理。只需配置一次 App 凭证，之后 Agent 通过 `gh`/`git` 访问 GitHub 时使用 Installation Token，使推送归属于该 App 的 bot 身份；令牌按需刷新。

本阶段负责令牌、`gh` 认证、Agent 子进程的 Git 身份注入和用 App 身份创建 PR。提交历史改写和 Verified 签名留到后续步骤。

## 功能

- 提供 `refresh_ghapp_token` 与 `check_ghapp_token_status` 两个工具。
- 设置页标题旁实时显示令牌状态与剩余时间：未配置、未激活、已激活、即将过期、已过期、令牌不可读。
- 在对话开始时注入一次固定前缀的令牌快照；当令牌进入刷新阈值内、刷新成功后再次注入。
- 从 App ID 和私钥解析 App bot 的 login / user id，并向 Host 进程注入 `GIT_AUTHOR_*`、`GIT_COMMITTER_*`，让 Agent 子进程里的 `git commit` 自动使用 bot 身份；不修改仓库或全局 git 配置。
- 提供 `commit_changes` 工具：单次提交设置 bot 身份，并自动追加用户的 `Co-authored-by` trailer；可在设置页阻断裸 `git commit`，并注入 Agent 提交规范提示。
- 提供 `create_pull_request` 工具：用 Installation Token 调用 GitHub REST API 创建 PR，PR 归属于 App bot；不提交、不推送。
- 把 Installation Token 存入私有文件（平台支持时权限为 `0600`），刷新时持有跨进程文件锁，拿到锁后再次检查过期时间。
- 不启动守护进程、定时器、计划任务或后台 job。只有 Agent 调用刷新工具时才会访问 GitHub；状态在正常的提示词组装过程中计算。

插件不拦截、不包装 `gh`。它负责管理令牌并告诉 Agent 令牌文件的位置；调用方用该令牌启动 `gh`（见[把令牌交给 gh](#把令牌交给-gh)）。

## 安装

包内带有 bundle patch，profile 按包名加载即可：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@dynastxu/dsh-github-agents-proxy"]
    }
  }
}
```

patch 会插入 `github-agents-proxy` 行。在 profile 的 `cordis.patch.yml` 中配置该行：

```yaml
- id: github-agents-proxy
  config:
    appId: 123456
    installationId: 98765432
    privateKeyPath: /home/me/.dsh/github-app.pem
```

三个凭证字段必须同时设置，或者全部留空。只设置一部分会在加载时直接失败，并列出缺少的字段。

## Web 设置页

插件的浏览器半注册在 **Settings → GitHub App 令牌**。页面直接编辑当前 profile 的 volatile Config 字段，停止编辑约半秒后自动写入 profile 的 `cordis.patch.yml`，无需手工改文件，也没有保存按钮：

- App ID、Installation ID
- 私钥来源（文件路径 / DSH 凭据引用）及对应值；Desktop 应用中可用文件夹按钮直接选择 PEM 文件
- 令牌缓存文件、刷新阈值、GitHub API 地址
- 是否注入运行时状态快照

标题卡下方的状态行显示缓存令牌的实时状态：`未配置`、`未激活`、`已激活 · 剩余 28m2s`、`即将过期 · 剩余 1m52s`、`已过期` 或 `令牌不可读`；悬停可看有效期和令牌文件。页面打开期间每 15 秒读取一次 Host 的 `GET /api/github-agents-proxy/status`，该路由只读取本地令牌文件，不访问 GitHub、不获取刷新锁；倒计时以 Host 时钟为准，每秒递减，页面关闭后停止轮询。Host 没有 Web 通道时显示 `状态不可用`。

每次写入先校验正整数 ID、私钥来源和 URL，再通过 `ctx.configForms` 以一次原子变更提交。App ID、Installation ID 和私钥三项齐全或全空时才会写入，避免半套凭证让插件在加载时失败；页面会在私钥行下方提示这一点。右上角的 **重置** 清空全部配置。Host 收到 `loader/volatile-update` 后重建令牌管理器，下一次工具调用和状态注入立即使用新配置。浏览器半随 Web 客户端加载，升级插件后需要重启 DSH Host（必要时再刷新页面）才会出现该设置页。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `appId` | 配置凭证时必填 | GitHub App ID。接受数字或数字字符串。 |
| `installationId` | 配置凭证时必填 | Agent 可使用的仓库集合对应的 Installation ID。 |
| `privateKeyPath` | — | PEM 私钥路径。与 `privateKeyEnv` 互斥。 |
| `privateKeyEnv` | — | 通过 `ctx.credentials` 解析的凭据引用；没有凭据服务时回退到进程环境变量。 |
| `tokenPath` | `<profile 目录>/github-app-token.json` | 缓存的 Installation Token 文件。 |
| `refreshThresholdSeconds` | `300` | 剩余时间小于该秒数时刷新。设为 `0` 时只刷新已过期令牌。 |
| `apiBaseUrl` | `https://api.github.com` | GitHub API 地址；GitHub Enterprise 可带 `api/v3` 路径。 |
| `contextInjection` | `true` | 是否注入运行时上下文状态快照。 |
| `configureGh` | `true` | 刷新成功后执行 `gh auth login --with-token`，让普通 `gh` 命令直接使用该令牌；不修改全局 git 配置。 |
| `blockRawGitCommit` | `false` | 拒绝 bash/pwsh 中直接执行的 `git commit`，要求 Agent 使用 `commit_changes`。这是命令护栏，不是安全边界。 |

### 私钥不要进入仓库

`privateKeyPath` 应指向 checkout 之外的路径，或把 `.dsh/github-app.pem` 加入忽略列表。使用 DSH 托管存储时，改用 `privateKeyEnv`，把 PEM 放进 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  GITHUB_APP_PRIVATE_KEY: |
    -----BEGIN RSA PRIVATE KEY-----
    …
    -----END RSA PRIVATE KEY-----
```

然后配置 `privateKeyEnv: GITHUB_APP_PRIVATE_KEY`。每次刷新都会重新解析该引用，因此轮换私钥后下一次调用即可生效，无需重启 DSH。

私钥不会写入令牌文件、工具返回值或上下文快照。

## 工具

### `refresh_ghapp_token`

在以下场景调用：

- `gh` 返回 `401`、`Bad credentials` 或其他令牌无效错误；
- 注入的状态显示 `missing`、`expired`，或警告令牌即将过期；
- 工作流需要立即获得新的 Installation Token。

工具先获取刷新锁，再重新读取缓存令牌。若剩余时间仍大于配置阈值，返回 `reason=token_still_valid`，不访问 GitHub。如果等待锁期间另一个 Agent 已完成刷新，第二个调用会看到新的过期时间，不会重复请求 GitHub。

`force: true` 跳过过期判断。遇到 401 时先不带 `force` 调用；如果仍返回 `token_still_valid` 而 `gh` 继续报 401，说明令牌可能已被撤销，再带 `force: true` 重试。仅在确实需要立即替换仍有效的令牌时使用。

成功：

```json
{ "ok": true, "refreshed": true, "expires_at": "2026-11-10T23:05:00Z", "expires_in_seconds": 3580, "token_file": "…/github-app-token.json" }
```

仍然有效：

```json
{
  "ok": false,
  "reason": "token_still_valid",
  "expires_at": "2026-11-10T23:05:00Z",
  "expires_in_seconds": 1800,
  "hint": "The cached token is still valid. If gh still returns 401, call refresh_ghapp_token with force=true to replace a revoked token."
}
```

刷新失败与未配置是两种独立的结构化结果：`reason=refresh_failed` 携带限长错误信息和处理建议；`reason=not_configured` 列出缺少的 `appId`、`installationId`、`privateKeyPath`/`privateKeyEnv`。

### `check_ghapp_token_status`

只读取本地缓存文件，不访问 GitHub。返回 `valid`、`expiring`、`expired`、`missing`、`invalid` 或 `unconfigured`，并附带 `expires_at`、`remaining`、`needs_refresh` 和令牌文件路径。状态快照缺失或工作流需要重新读取本地状态时使用。

### `create_pull_request`

用 Installation Token 直接调用 `POST /repos/{owner}/{repo}/pulls` 创建 PR，GitHub 因此把 PR 归属于 App bot 账号。工具不提交、不推送：`head` 分支必须已经存在于远端。

| 参数 | 说明 |
|---|---|
| `title` | PR 标题，必填 |
| `body` | PR 描述，Markdown |
| `base` | 目标分支；默认仓库默认分支（`GET /repos/{owner}/{repo}` 的 `default_branch`） |
| `head` | 源分支；默认工作目录检出的分支 |
| `draft` | 是否创建草稿 PR |
| `repo` | `owner/name`；默认从工作目录的 `origin` remote 解析，支持 https、`ssh://`、`git@host:owner/name` 和 GitHub Enterprise 主机 |

返回 `number`、`url`、`repository`、`head`、`base`、`draft`、`author`、`created`。已经存在同一个 `head` 的 open PR 时不重复创建，而是返回该 PR 并带 `created=false`，因此重试同一个调用会收敛。

失败返回结构化 `message` 和可操作的 `hint`：401 提示用 `refresh_ghapp_token` 换令牌；403 提示 Installation 权限；404 提示仓库或分支名错误、仓库不在 Installation 范围内；422 提示先推送 `head` 分支。

限制：工具只创建 PR，不 push、不改动远端分支；草稿 PR 是否可用取决于仓库设置；未推送的本地提交不会出现在 PR 里。

## Agent 提交身份

设置页不需要填写 bot 的 name/email。插件用现有 App ID 和私钥调用：

```text
GET /app                         → slug = dsh-agents
GET /users/dsh-agents%5Bbot%5D  → id = 354391007, login = dsh-agents[bot]
```

并推导：

```text
GIT_AUTHOR_NAME      = dsh-agents[bot]
GIT_AUTHOR_EMAIL     = 354391007+dsh-agents[bot]@users.noreply.github.com
GIT_COMMITTER_NAME   = dsh-agents[bot]
GIT_COMMITTER_EMAIL  = 354391007+dsh-agents[bot]@users.noreply.github.com
```

这四个变量只写入 Host 进程环境，由 Agent 的 bash/pwsh 子进程继承；插件不会执行 `git config`，也不会改仓库或全局 git 配置，dispose 时恢复原值。因此用户在外部终端的提交不受影响。

边界：

- 本地 `git commit` 产生的提交 author/committer 是 bot，但 `verified: false`；本阶段不处理签名/Verified。
- Agent 显式使用 `git commit --author=...` 或自己覆盖 `GIT_AUTHOR_*` 时仍可能绕过。
- 远程 SSH/容器里的 git 是否继承这些变量取决于该环境。
- 如果启动时解析 bot 身份失败，插件仍会加载，但不会注入身份；后续刷新成功时会再尝试。

## `commit_changes` 与裸提交护栏

系统提示词中会加入一段提交规范，要求 Agent 使用 `commit_changes`，不要直接 `git commit`。

工具参数：

| 参数 | 说明 |
|---|---|
| `message` | 提交信息，必填 |
| `stage` | `all` / `tracked` / `staged`，默认 `all` |
| `allow_empty` | 是否允许空提交 |
| `amend` | 是否 amend 当前 HEAD |

工具行为：

1. 从全局 git 配置读取用户 `user.name` / `user.email`；
2. 用 App bot 身份执行 `git add` 和 `git commit`；
3. 提交信息末尾追加：
   ```text
   Co-authored-by: <user name> <user email>
   ```
4. 返回 `sha`、`branch`、`author`、`committer`、`co_author`；
5. 默认不 push。

设置页的 **阻断普通 git commit** 打开后，`tools/pre-execute` 会拒绝 bash/pwsh 中包含 `git commit` 的命令，并提示改用 `commit_changes`。

这个护栏只检查模型提交的 shell 命令文本；脚本内部、Git alias、间接调用仍可能绕过，因此它不是安全边界。`git merge`、`git rebase`、`git cherry-pick` 等会产生提交的命令不在阻断范围内，仍依赖进程级 bot 身份兜底。

## 运行时上下文快照

首次提示词组装时注入一次固定前缀的块，之后只在状态变化时再次注入：

```text
[github-app-token] status=valid, expires_at=2026-11-10T23:05:00Z, remaining=28m2s, token_file=…/github-app-token.json
```

进入刷新阈值内：

```text
[github-app-token] status=valid, expires_at=2026-11-10T23:05:00Z, remaining=1m52s, token_file=…/github-app-token.json
WARN: The github-app-token is about to expire. Use refresh_ghapp_token to refresh it
```

缺失、过期、损坏和未配置状态会多一行处理提示。`remaining` 是快照创建瞬间的值；相同文本不会在后续步骤重复注入。去重由 Agent loop 的运行时上下文投影完成，因此长回合不会每步累积一条状态消息。

## 把令牌交给 gh

刷新成功后，插件会执行 `gh auth login --with-token`，因此普通 `gh` 命令可直接使用。它不执行 `gh auth setup-git`，也不会写入全局 git `credential.helper`。DSH 的 shell 执行器会擦除从宿主进程继承的凭证类环境变量，所以不能依赖宿主进程的 `GH_TOKEN`。如需手工兜底，也可以从令牌文件读取：

```sh
TOKEN_FILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/github-app-token.json"
GH_TOKEN="$(jq -r .token "$TOKEN_FILE")" gh pr list
```

PowerShell：

```powershell
$token = (Get-Content "$env:DSH_HOME\profiles\web\github-app-token.json" | ConvertFrom-Json).token
$env:GH_TOKEN = $token
gh pr list
```

快照包含 `token_file`，Agent 无需猜测 profile 路径。如果部署已有读取该文件的 `gh` wrapper，wrapper 可以直接使用该文件，命令无需改变。

## 并发与安全

- 每次刷新都在 `<tokenPath>.lock` 下执行；第二个调用等待、重新读取令牌，如果第一个调用已完成刷新就直接返回，不重复请求。
- 令牌文件通过同目录临时文件和 `rename` 原子替换。
- 令牌文件以仅所有者可读写的权限创建（`0600`）；Windows 上与 DSH 其他文件存储一样尽力而为。
- 废弃的锁在两分钟后可被回收；正常等待锁最多十秒，并响应工具取消。
- 不会把令牌、JWT 或私钥返回给模型。GitHub 错误响应体在进入工具输出前会截断。
- `configureGh: true` 会运行 `gh auth login --with-token`，只写入 gh 的共享凭据存储，不触碰全局 git 配置；不需要自动登录时设为 `false`，此时用令牌文件手工设置 `GH_TOKEN`。
- 旧构建曾执行 `gh auth setup-git`，给全局 git 写入 `credential.https://github.com.helper`。升级后如仍存在，执行 `git config --global --unset-all credential.https://github.com.helper` 删除一次。

## 非目标

- 不实现守护进程、定时器、watchdog 或定时刷新循环。
- 不依赖长生命周期会话或后台 job 维持令牌有效。
- 不拦截、不包装 `gh`。
- 不实现多 App 或多 Installation 路由；一个插件实例管理一个 Installation。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

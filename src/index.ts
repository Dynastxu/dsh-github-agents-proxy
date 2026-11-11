/**
 * GitHub App installation-token manager for DeepSeek Harness.
 *
 * The plugin contributes two tools, one runtime-context snapshot, a status
 * endpoint for its settings page, and a browser settings page over volatile
 * Config fields. It never starts a daemon or background loop: a refresh happens
 * only when an Agent calls `refresh_ghapp_token`, the snapshot is re-evaluated
 * during normal prompt assembly, and the settings page polls local token state
 * only while it is open. Token state is shared across Agents through a private
 * file guarded by a cross-process lock.
 *
 * @module @dynastxu/dsh-github-agents-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import { readConfig, resolveConfig, type ConfigInput, type ResolvedConfig } from './config.ts'
import { clearBotIdentity, installBotIdentity, resolveBotIdentity, type BotIdentity } from './bot.ts'
import { createCommitTool, type CommitRuntime, type SubprocessLike, type WorkingDirectoryLike } from './commit.ts'
import { isGitCommitCommand } from './guard.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile Config values were committed into the running plugin without a remount.
     * @param paths - changed config paths as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}
import { GitHubAppTokenManager, type CredentialsResolver } from './manager.ts'
import { TOKEN_STATUS_ROUTE } from './status-contract.ts'
import { serveTokenStatus } from './status.ts'
import { createRefreshTool, createStatusTool, type TokenManagerSource, type ToolsRegistry } from './tools.ts'

export { Config } from './config.ts'
export type { ConfigEnvironment, ConfigInput, ConfigValues, ResolvedConfig } from './config.ts'
export { ConfigurationError, DEFAULT_API_BASE_URL, DEFAULT_REFRESH_THRESHOLD_SECONDS, readConfig, resolveConfig } from './config.ts'
export type { BotIdentity, BotIdentityOptions } from './bot.ts'
export { clearBotIdentity, installBotIdentity, resolveBotIdentity } from './bot.ts'
export type { CommitArgs, CommitFailure, CommitResult, CommitRuntime, CommitSuccess, SubprocessLike, WorkingDirectoryLike } from './commit.ts'
export { createCommitTool } from './commit.ts'
export { formatDuration } from './duration.ts'
export { isGitCommitCommand } from './guard.ts'
export type { CredentialsResolver, ManagerOptions } from './manager.ts'
export { formatTokenSnapshot, GitHubAppTokenManager, hintForState, readPrivateKeyPem } from './manager.ts'
export { TOKEN_STATUS_ROUTE } from './status-contract.ts'
export type { TokenStatusResponse } from './status-contract.ts'
export { serveTokenStatus } from './status.ts'
export type { RefreshFailed, RefreshNotConfigured, RefreshResult, RefreshStillValid, RefreshSuccess, StatusResult, StoredToken, TokenReport, TokenSnapshot, TokenState } from './types.ts'
export type { ContentBlock, TokenManagerSource, ToolDefinition, ToolRunContext, ToolsRegistry } from './tools.ts'
export { createRefreshTool, createStatusTool, tokenReport } from './tools.ts'

/** Cordis plugin name used by Loader diagnostics and profile patch rows. */
export const name = 'github-agents-proxy'

/** Services required before the plugin can contribute tools and context. */
export const inject: string[] = ['tools', 'systemPrompt']

/** Runtime-context name of the token snapshot. */
export const GITHUB_APP_TOKEN_CONTEXT_NAME = 'github-app-token:status'

/** Placement between the working directory and sandbox-policy context. */
export const GITHUB_APP_TOKEN_CONTEXT_ORDER = 106

/** System-prompt section that tells Agents to use the dedicated commit tool. */
export const GITHUB_APP_COMMIT_GUIDANCE_SECTION = 'github-agents-proxy:commit-guidance'

/** Placement near the tool-specific system-prompt sections. */
export const GITHUB_APP_COMMIT_GUIDANCE_ORDER = 4900

const COMMIT_GUIDANCE = `# GitHub App commits

Create commits with the \`commit_changes\` tool, not with a raw \`git commit\`. The tool commits as the GitHub App bot and appends the human user as a \`Co-authored-by\` trailer. It does not push; push the resulting branch separately.

Do not use \`git commit\`, \`git commit --amend\`, or another command that creates a commit unless the user explicitly asks to bypass the tool.`

/** Delay that coalesces the settings form's field writes into one reload. */
const CONFIG_RELOAD_DEBOUNCE_MS = 100

/** The slice of `ctx.systemPrompt` this plugin uses. */
interface PromptContextRegistry {
  /**
   * Register one dynamic runtime-context contribution.
   * @param entry - name, placement, and the text provider evaluated per assembly.
   * @returns the disposer of the registration.
   */
  context(entry: {
    readonly name: string
    readonly order: number
    readonly text: (context: { readonly agent?: object }) => string
    readonly interpolate?: boolean
    readonly required?: boolean
  }): () => void
  section(entry: {
    readonly name: string
    readonly order: number
    readonly text: string | (() => string)
    readonly interpolate?: boolean
  }): () => void
}

/** The slice of the pre-execute event this plugin inspects. */
interface PressedToolExecution {
  readonly name: string
  readonly arguments: unknown
}

type PressedToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask'; readonly reason?: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Allow or deny one pending tool call before dispatch.
     * @param exec - pending tool name and parsed arguments.
     * @param next - continue to the next policy listener.
     * @mode waterfall
     */
    'tools/pre-execute'(exec: PressedToolExecution, next: () => Promise<PressedToolDecision>): Promise<PressedToolDecision>
  }
}

interface ProfileContext {
  readonly dir?: string
}

/** One exact Fetch route as the Host Connection service accepts it. */
interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The slice of the Connection service this plugin registers into. */
interface FetchRouteRegistry {
  readonly fetch: {
    register(route: FetchRoute): () => Promise<void>
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the GitHub App token manager for the lifetime of `ctx`.
 *
 * A plugin with no credential configuration still loads: the tools then report
 * `not_configured` / `unconfigured` with the exact fields to supply. A partial
 * credential set fails here, at load, rather than during a later `gh` call.
 * @param ctx - plugin context; every contribution is disposed with it.
 * @param config - volatile profile configuration, or plain values in tests.
 */
export async function apply(ctx: Context, config: ConfigInput = {}): Promise<void> {
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  const defaultTokenDir = profile?.dir
  const credentials = ctx.get('credentials') as CredentialsResolver | undefined
  const botLifecycle = new AbortController()
  let installedBotKey: string | undefined
  let currentBotIdentity: BotIdentity | undefined
  let syncGeneration = 0

  const syncBotIdentity = async (resolved: ResolvedConfig): Promise<void> => {
    const generation = ++syncGeneration
    if (!resolved.configured || resolved.appId === undefined) {
      installedBotKey = undefined
      currentBotIdentity = undefined
      clearBotIdentity()
      return
    }
    const key = `${resolved.appId}|${resolved.apiBaseUrl}`
    if (key === installedBotKey) return
    try {
      const identity = await resolveBotIdentity(
        resolved,
        credentials === undefined ? {} : { credentials },
        botLifecycle.signal,
      )
      if (generation !== syncGeneration) return
      installBotIdentity(identity)
      currentBotIdentity = identity
      installedBotKey = key
    } catch (error: unknown) {
      if (generation !== syncGeneration) return
      installedBotKey = undefined
      currentBotIdentity = undefined
      clearBotIdentity()
      ctx.logger?.warn(`github-agents-proxy: could not resolve the App bot identity; Agent commits will use the configured git identity: ${errorMessage(error)}`)
    }
  }

  let manager: GitHubAppTokenManager
  const managerOptions = {
    ...(credentials === undefined ? {} : { credentials }),
    onTokenAvailable: async (): Promise<void> => {
      await syncBotIdentity(manager.config)
    },
  }

  const buildManager = async (): Promise<GitHubAppTokenManager> => {
    const resolved = resolveConfig(readConfig(config), {
      ...(defaultTokenDir === undefined ? {} : { defaultTokenDir }),
    })
    const next = new GitHubAppTokenManager(resolved, managerOptions)
    await next.initialize()
    return next
  }

  manager = await buildManager()
  await syncBotIdentity(manager.config)
  ctx.effect(() => () => {
    botLifecycle.abort(new Error('github-agents-proxy disposed'))
    clearBotIdentity()
  }, 'github-agents-proxy: bot git identity')
  const source: TokenManagerSource = { current: () => manager }

  const tools = ctx.get('tools') as ToolsRegistry | undefined
  if (tools === undefined) throw new Error('github-agents-proxy requires the tools service')
  ctx.effect(() => tools.register(createRefreshTool(source)))
  ctx.effect(() => tools.register(createStatusTool(source)))
  const commitRuntime: CommitRuntime = {
    currentBotIdentity: () => currentBotIdentity,
    subprocess: () => ctx.get('subprocess') as SubprocessLike | undefined,
    workingDirectory: () => ctx.get('workingDirectory') as WorkingDirectoryLike | undefined,
  }
  ctx.effect(() => tools.register(createCommitTool(commitRuntime)))

  // The status route is optional: compositions without a Web carrier keep the
  // plugin loadable, and the settings page then reports the status as
  // unavailable instead of showing stale facts.
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as FetchRouteRegistry | undefined
    if (connection === undefined) return
    scope.effect(() => {
      const dispose = connection.fetch.register({
        path: TOKEN_STATUS_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => serveTokenStatus(source),
      })
      return () => { void dispose() }
    }, 'github-agents-proxy: token status route')
  })

  const gitCommitMatcher = (command: unknown): boolean =>
    typeof command === 'string' && isGitCommitCommand(command)
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (!source.current().config.blockRawGitCommit) return next()
    if (exec.name !== 'bash' && exec.name !== 'pwsh') return next()
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return next()
    const command = Reflect.get(args, 'command')
    if (!gitCommitMatcher(command)) return next()
    return {
      kind: 'deny',
      reason: 'Direct git commit is disabled. Use the commit_changes tool so the commit is authored by the GitHub App bot and carries the user Co-authored-by trailer.',
    }
  }), 'github-agents-proxy: raw git commit guard')

  const systemPrompt = ctx.get('systemPrompt') as PromptContextRegistry | undefined
  if (systemPrompt === undefined) throw new Error('github-agents-proxy requires the systemPrompt service')
  ctx.effect(() => systemPrompt.context({
    name: GITHUB_APP_TOKEN_CONTEXT_NAME,
    order: GITHUB_APP_TOKEN_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: (context) => {
      if (context.agent === undefined) return ''
      if (!source.current().config.contextInjection) return ''
      return source.current().snapshotFor(context.agent)
    },
  }))
  ctx.effect(() => systemPrompt.section({
    name: GITHUB_APP_COMMIT_GUIDANCE_SECTION,
    order: GITHUB_APP_COMMIT_GUIDANCE_ORDER,
    text: () => source.current().config.configured ? COMMIT_GUIDANCE : '',
  }), 'github-agents-proxy: commit guidance')

  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  let reloading: Promise<void> = Promise.resolve()
  const reload = (): void => {
    if (reloadTimer !== undefined) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      reloading = reloading.then(async () => {
        try {
          const next = await buildManager()
          manager = next
          await syncBotIdentity(next.config)
        } catch (error: unknown) {
          ctx.logger?.warn(`github-agents-proxy: kept the previous configuration because the edited value is invalid: ${errorMessage(error)}`)
        }
      })
    }, CONFIG_RELOAD_DEBOUNCE_MS)
  }
  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', reload)
    return () => {
      off()
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
    }
  }, 'github-agents-proxy: volatile configuration')

}

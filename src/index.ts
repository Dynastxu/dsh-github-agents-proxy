/**
 * GitHub App installation-token manager for DeepSeek Harness.
 *
 * The plugin contributes two tools, one runtime-context snapshot, and a
 * browser settings page over volatile Config fields. It never starts a daemon
 * or background loop: a refresh happens only when an Agent calls
 * `refresh_ghapp_token`, and the snapshot is re-evaluated during normal prompt
 * assembly. Token state is shared across Agents through a private file guarded
 * by a cross-process lock.
 *
 * @module @dynastxu/dsh-github-agents-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import { readConfig, resolveConfig, type ConfigInput, type ResolvedConfig } from './config.ts'
import { clearBotIdentity, installBotIdentity, resolveBotIdentity } from './bot.ts'

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
import { createRefreshTool, createStatusTool, type TokenManagerSource, type ToolsRegistry } from './tools.ts'

export { Config } from './config.ts'
export type { ConfigEnvironment, ConfigInput, ConfigValues, ResolvedConfig } from './config.ts'
export { ConfigurationError, DEFAULT_API_BASE_URL, DEFAULT_REFRESH_THRESHOLD_SECONDS, readConfig, resolveConfig } from './config.ts'
export type { BotIdentity, BotIdentityOptions } from './bot.ts'
export { clearBotIdentity, installBotIdentity, resolveBotIdentity } from './bot.ts'
export type { CredentialsResolver, ManagerOptions } from './manager.ts'
export { formatDuration, formatTokenSnapshot, GitHubAppTokenManager, hintForState, readPrivateKeyPem } from './manager.ts'
export type { RefreshFailed, RefreshNotConfigured, RefreshResult, RefreshStillValid, RefreshSuccess, StatusResult, StoredToken, TokenSnapshot, TokenState } from './types.ts'
export type { ContentBlock, TokenManagerSource, ToolDefinition, ToolRunContext, ToolsRegistry } from './tools.ts'
export { createRefreshTool, createStatusTool } from './tools.ts'

/** Cordis plugin name used by Loader diagnostics and profile patch rows. */
export const name = 'github-agents-proxy'

/** Services required before the plugin can contribute tools and context. */
export const inject: string[] = ['tools', 'systemPrompt']

/** Runtime-context name of the token snapshot. */
export const GITHUB_APP_TOKEN_CONTEXT_NAME = 'github-app-token:status'

/** Placement between the working directory and sandbox-policy context. */
export const GITHUB_APP_TOKEN_CONTEXT_ORDER = 106

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
}

interface ProfileContext {
  readonly dir?: string
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
  let syncGeneration = 0

  const syncBotIdentity = async (resolved: ResolvedConfig): Promise<void> => {
    const generation = ++syncGeneration
    if (!resolved.configured || resolved.appId === undefined) {
      installedBotKey = undefined
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
      installedBotKey = key
    } catch (error: unknown) {
      if (generation !== syncGeneration) return
      installedBotKey = undefined
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

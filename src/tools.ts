/**
 * Model-facing tools for the GitHub App token manager.
 *
 * `refresh_ghapp_token` is the only operation that may contact GitHub;
 * `check_ghapp_token_status` only reads local state. Both return structured
 * canonical values so an Agent can distinguish "still valid" from
 * "unconfigured" and "refresh failed" without parsing prose.
 *
 * @module @dynastxu/dsh-github-agents-proxy/tools
 */

import { formatDuration, hintForState, type GitHubAppTokenManager } from './manager.ts'
import type { RefreshResult, StatusResult, TokenReport, TokenSnapshot, TokenState } from './types.ts'

/** A live manager, or a provider that resolves the manager after a config reload. */
export type TokenManagerSource = GitHubAppTokenManager | { current(): GitHubAppTokenManager }

/**
 * Resolve the live manager behind a source.
 * @param source - live manager, or a provider resolving it after a config reload.
 * @returns the manager to use for this operation.
 */
export function resolveManager(source: TokenManagerSource): GitHubAppTokenManager {
  return 'current' in source ? source.current() : source
}

/** One model-facing text block. */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** The slice of the tool execution context these tools consume. */
export interface ToolRunContext {
  /** Caller cancellation. */
  readonly signal: AbortSignal
  /** Calling Agent, when the tool runs from a model step. */
  readonly agent?: object
}

/** A tool definition compatible with `ctx.tools.register`. */
export interface ToolDefinition<TArgs, TResult> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: TArgs, value: TResult): ContentBlock[]
  }
  isConcurrencySafe?(args: TArgs): boolean
  execute(args: TArgs, exec: ToolRunContext): Promise<TResult>
}

/** The slice of `ctx.tools` used by this plugin. */
export interface ToolsRegistry {
  register<TArgs, TResult>(definition: ToolDefinition<TArgs, TResult>): () => void
}

const REFRESH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    refreshed: { type: 'boolean' },
    expires_at: { type: 'string' },
    expires_in_seconds: { type: 'integer' },
    token_file: { type: 'string' },
    gh_configured: { type: 'boolean' },
    gh_message: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    hint: { type: 'string' },
    message: { type: 'string' },
  },
}

const STATUS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'status', 'configured', 'needs_refresh', 'token_file', 'threshold_seconds'],
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    configured: { type: 'boolean' },
    needs_refresh: { type: 'boolean' },
    token_file: { type: 'string' },
    threshold_seconds: { type: 'integer' },
    expires_at: { type: 'string' },
    expires_in_seconds: { type: 'integer' },
    remaining: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
    hint: { type: 'string' },
  },
}

function stateNeedsRefresh(state: TokenState): boolean {
  return state !== 'valid'
}

/**
 * Project one token snapshot into the structured facts shared by
 * `check_ghapp_token_status` and the settings page's live status.
 * @param snapshot - token state at one instant.
 * @returns the report fields, omitting facts the snapshot does not carry.
 */
export function tokenReport(snapshot: TokenSnapshot): TokenReport {
  return {
    status: snapshot.state,
    configured: snapshot.configured,
    needs_refresh: stateNeedsRefresh(snapshot.state),
    token_file: snapshot.tokenPath,
    threshold_seconds: snapshot.refreshThresholdSeconds,
    ...(snapshot.expiresAt === undefined ? {} : { expires_at: snapshot.expiresAt }),
    ...(snapshot.expiresInSeconds === undefined ? {} : {
      expires_in_seconds: snapshot.expiresInSeconds,
      remaining: formatDuration(snapshot.expiresInSeconds),
    }),
    ...(snapshot.missing === undefined ? {} : { missing: snapshot.missing }),
    ...(snapshot.detail === undefined ? {} : { message: snapshot.detail }),
  }
}

function renderRefresh(value: RefreshResult): string {
  if (value.ok) {
    const gh = value.gh_configured
      ? ' The gh CLI is authenticated; retry the failed gh command.'
      : ` gh CLI was not configured${value.gh_message === undefined ? '' : `: ${value.gh_message}`}.`
    return `Refreshed the GitHub App installation token. expires_at=${value.expires_at} `
      + `(remaining=${formatDuration(value.expires_in_seconds)}). The token file was updated at ${value.token_file}.${gh}`
  }
  switch (value.reason) {
    case 'token_still_valid':
      return `No refresh performed: the cached token is still valid for ${formatDuration(value.expires_in_seconds)} `
        + `(expires_at=${value.expires_at}).${value.gh_configured ? ' The gh CLI is authenticated.' : value.gh_message === undefined ? '' : ` gh CLI warning: ${value.gh_message}`} ${value.hint}`
    case 'not_configured':
      return `GitHub App credentials are not configured (missing: ${value.missing.join(', ')}). ${value.hint}`
    case 'refresh_failed':
      return `Could not refresh the GitHub App installation token: ${value.message}. ${value.hint}`
  }
}

function renderStatus(value: StatusResult): string {
  const fields = [`status=${value.status}`, `needs_refresh=${String(value.needs_refresh)}`]
  if (value.expires_at !== undefined) fields.push(`expires_at=${value.expires_at}`)
  if (value.remaining !== undefined) fields.push(`remaining=${value.remaining}`)
  fields.push(`token_file=${value.token_file}`)
  if (value.missing !== undefined && value.missing.length > 0) fields.push(`missing=${value.missing.join(',')}`)
  let text = `[github-app-token] ${fields.join(', ')}`
  if (value.message !== undefined) text += `\n${value.message}`
  if (value.hint !== undefined) text += `\nHINT: ${value.hint}`
  return text
}

/**
 * Create the `refresh_ghapp_token` definition.
 * @param manager - token manager owned by the plugin.
 * @returns a registry-ready tool declaration.
 */
export function createRefreshTool(manager: TokenManagerSource): ToolDefinition<{ force?: boolean }, RefreshResult> {
  return {
    name: 'refresh_ghapp_token',
    description: 'Refresh the GitHub App installation token used by gh. Call this when gh or the GitHub API returns 401 or '
      + 'Bad credentials, when the injected github-app-token status says the token is missing or expired, or when that '
      + 'status warns the token is about to expire. The tool checks the cached token under a lock and returns '
      + 'reason=token_still_valid without contacting GitHub when enough lifetime remains. Call it without force first; if '
      + 'gh still returns 401 after a token_still_valid result, call again with force=true to replace a revoked token.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        force: {
          type: 'boolean',
          description: 'Replace a still-valid cached token instead of returning token_still_valid.',
        },
      },
    },
    timeoutMs: 45_000,
    output: {
      schema: REFRESH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRefresh(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return resolveManager(manager).refresh(args.force === true, exec.signal)
    },
  }
}

/**
 * Create the `check_ghapp_token_status` definition.
 * @param manager - token manager owned by the plugin.
 * @returns a registry-ready tool declaration.
 */
export function createStatusTool(manager: TokenManagerSource): ToolDefinition<Record<string, never>, StatusResult> {
  return {
    name: 'check_ghapp_token_status',
    description: 'Read the cached GitHub App installation token status without contacting GitHub. Reports valid, '
      + 'expiring, expired, missing, invalid, or unconfigured, plus expires_at, remaining lifetime, the token file path, '
      + 'and whether refresh_ghapp_token is needed. Use it before a GitHub operation when the injected '
      + 'github-app-token status is absent or stale.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    timeoutMs: 10_000,
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const snapshot = await resolveManager(manager).checkFromDisk()
      exec.signal.throwIfAborted()
      const hint = hintForState(snapshot.state)
      return {
        ok: true,
        ...tokenReport(snapshot),
        ...(hint === undefined ? {} : { hint }),
      }
    },
  }
}

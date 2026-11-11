/**
 * Installation-token state, refresh orchestration, and runtime-context snapshots.
 *
 * The manager performs one bounded, atomic operation: read the cached token
 * under a file lock, re-check expiry, exchange a JWT for a fresh installation
 * token when needed, and atomically replace the cache. It deliberately owns no
 * timer or background loop; the Agent's next tool call or model step drives
 * every refresh.
 *
 * @module @dynastxu/dsh-github-agents-proxy/manager
 */

import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from './config.ts'
import { configureGhAuth, type GhAuthResult } from './gh.ts'
import { exchangeInstallationToken } from './github.ts'
import { createAppJwt, parsePrivateKey } from './jwt.ts'
import { FileTokenStore, TokenFileError } from './token-store.ts'
import type { RefreshResult, StoredToken, TokenSnapshot, TokenState } from './types.ts'

/** Resolved credential lookup exposed by `ctx.credentials`. */
export interface CredentialsResolver {
  /**
   * Resolve one credential reference.
   * @param ref - environment-style reference name.
   * @returns the non-empty value, or undefined while unconfigured.
   */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
}

/** Runtime overrides used by tests and the Host adapter. */
export interface ManagerOptions {
  /** Fetch implementation; defaults to the process global. */
  readonly fetch?: typeof fetch
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
  /** Credential service used for `privateKeyEnv`; process env is the fallback. */
  readonly credentials?: CredentialsResolver
  /** Environment used for `privateKeyEnv` when no credential service is present. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** GitHub request deadline in milliseconds; defaults to 15 seconds. */
  readonly requestTimeoutMs?: number
  /** Refresh-lock wait budget in milliseconds. */
  readonly lockTimeoutMs?: number
  /** Abandoned-lock age in milliseconds. */
  readonly lockStaleMs?: number
  /** Refresh-lock poll interval in milliseconds. */
  readonly lockPollMs?: number
  /** gh authentication override used by tests; defaults to the real gh CLI. */
  readonly gh?: (token: string, apiBaseUrl: string, signal: AbortSignal) => Promise<GhAuthResult>
  /** Best-effort notification after a cached or fresh token is accepted. */
  readonly onTokenAvailable?: (token: StoredToken) => Promise<void>
}

/** Credentials and environment used to resolve a configured private key. */
export interface PrivateKeyReadOptions {
  /** Credential service used by `privateKeyEnv`. */
  readonly credentials?: CredentialsResolver
  /** Environment used by `privateKeyEnv` when no credential service is present. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Read the configured App private key.
 * @param config - resolved App configuration.
 * @param options - credential and environment overrides.
 * @param signal - cancellation for the file read.
 * @returns PEM text.
 * @throws when neither key source is configured or its value is empty.
 */
export async function readPrivateKeyPem(
  config: ResolvedConfig,
  options: PrivateKeyReadOptions,
  signal: AbortSignal,
): Promise<string> {
  if (config.privateKeyPath !== undefined) {
    return readFile(config.privateKeyPath, { encoding: 'utf8', signal })
  }
  const ref = config.privateKeyEnv
  if (ref === undefined) throw new Error('GitHub App private key is not configured')
  if (options.credentials !== undefined) {
    const resolved = await options.credentials.resolve(ref)
    if (resolved === undefined || resolved.value.trim().length === 0) {
      throw new Error(`credential "${ref}" is not configured`)
    }
    return resolved.value
  }
  const value = (options.env ?? process.env)[ref]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`environment credential "${ref}" is not configured`)
  }
  return value
}

const MAX_ERROR_MESSAGE_CHARS = 600

/**
 * Render a compact remaining-time label.
 * @param totalSeconds - remaining whole seconds.
 * @returns a label such as `45s`, `1m52s`, `28m2s`, or `1h2m`.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d${rest}h`
}

/**
 * One stable runtime-context block for a token state.
 * @param snapshot - token state at the snapshot instant.
 * @returns the fixed-prefix status line and any warning or hint line.
 */
export function formatTokenSnapshot(snapshot: TokenSnapshot): string {
  const status = snapshot.state === 'expiring' ? 'valid' : snapshot.state
  const fields = [`status=${status}`]
  if (snapshot.expiresAt !== undefined && snapshot.state !== 'missing' && snapshot.state !== 'unconfigured') {
    fields.push(`expires_at=${snapshot.expiresAt}`)
  }
  if (snapshot.expiresInSeconds !== undefined) {
    fields.push(`remaining=${formatDuration(snapshot.expiresInSeconds)}`)
  }
  if (snapshot.missing !== undefined && snapshot.missing.length > 0) {
    fields.push(`missing=${snapshot.missing.join(',')}`)
  }
  fields.push(`token_file=${snapshot.tokenPath}`)
  let text = `[github-app-token] ${fields.join(', ')}`
  switch (snapshot.state) {
    case 'valid':
      break
    case 'expiring':
      text += '\nWARN: The github-app-token is about to expire. Use refresh_ghapp_token to refresh it'
      break
    case 'expired':
      text += '\nWARN: The github-app-token has expired. Use refresh_ghapp_token to refresh it.'
      break
    case 'missing':
      text += '\nHINT: Call refresh_ghapp_token to create a GitHub App installation token.'
      break
    case 'invalid':
      text += '\nHINT: Call refresh_ghapp_token to replace the unreadable token file.'
      break
    case 'unconfigured':
      text += '\nHINT: Configure appId, privateKeyPath (or privateKeyEnv), and installationId for the github-agents-proxy plugin.'
      break
  }
  return text
}

/**
 * A user-facing hint for one state, omitted for a healthy token.
 * @param state - token state.
 * @returns actionable guidance, or undefined when no action is needed.
 */
export function hintForState(state: TokenState): string | undefined {
  switch (state) {
    case 'valid':
      return undefined
    case 'expiring':
      return 'The token is inside the refresh threshold. Call refresh_ghapp_token before the next GitHub operation.'
    case 'expired':
      return 'The token has expired. Call refresh_ghapp_token before using gh.'
    case 'missing':
      return 'No cached token exists. Call refresh_ghapp_token to create one.'
    case 'invalid':
      return 'The cached token file cannot be read. Call refresh_ghapp_token to replace it.'
    case 'unconfigured':
      return 'Set appId, installationId, and privateKeyPath or privateKeyEnv for the github-agents-proxy plugin.'
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_ERROR_MESSAGE_CHARS ? normalized : `${normalized.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
}

function secondsUntil(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))
}

class SnapshotCache {
  private readonly entries = new WeakMap<object, { readonly epoch: number; readonly signature: string; readonly text: string }>()
  private epoch = 0

  invalidateAll(): void {
    this.epoch += 1
  }

  render(holder: object, snapshot: TokenSnapshot): string {
    const signature = [
      snapshot.state,
      snapshot.expiresAt ?? '',
      snapshot.detail ?? '',
      String(snapshot.refreshThresholdSeconds),
      snapshot.missing?.join(',') ?? '',
      snapshot.tokenPath,
    ].join('|')
    const cached = this.entries.get(holder)
    if (cached !== undefined && cached.epoch === this.epoch && cached.signature === signature) {
      return cached.text
    }
    const text = formatTokenSnapshot(snapshot)
    this.entries.set(holder, { epoch: this.epoch, signature, text })
    return text
  }
}

/**
 * Owns one installation's cached token and coordinates its refresh.
 */
export class GitHubAppTokenManager {
  /** Resolved configuration for this installation. */
  readonly config: ResolvedConfig
  /** Cached-token store and lock. */
  readonly store: FileTokenStore
  private readonly options: ManagerOptions
  private readonly snapshots = new SnapshotCache()
  private token: StoredToken | undefined
  private loadError: string | undefined

  /**
   * @param config - resolved plugin configuration.
   * @param options - transport, clock, and credential overrides.
   */
  constructor(config: ResolvedConfig, options: ManagerOptions = {}) {
    this.config = config
    this.options = options
    this.store = new FileTokenStore(config.tokenPath, {
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
      ...(options.lockPollMs === undefined ? {} : { lockPollMs: options.lockPollMs }),
      now: options.now ?? Date.now,
    })
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Load the cached token before the first prompt assembly, so a conversation
   * starts from the real state rather than a transient `missing` snapshot.
   */
  async initialize(): Promise<void> {
    if (!this.config.configured) return
    await this.reloadFromDisk()
  }

  /**
   * Re-read the token file and return its current status.
   * @returns the status snapshot; a malformed file reports `invalid` rather than throwing.
   */
  async checkFromDisk(): Promise<TokenSnapshot> {
    if (this.config.configured) await this.reloadFromDisk()
    return this.currentSnapshot()
  }

  /**
   * Format the status contribution for one prompt assembly.
   *
   * The per-Agent cache freezes `remaining` at the instant a state first
   * appears; the Agent loop skips re-injecting identical text. The cache is
   * invalidated when the state crosses a threshold or a refresh commits.
   * @param agent - Agent whose conversation receives the snapshot.
   * @returns the fixed-prefix status block.
   */
  snapshotFor(agent?: object): string {
    return this.snapshots.render(agent ?? this, this.currentSnapshot())
  }

  /**
   * Refresh the installation token if needed, or unconditionally with `force`.
   * @param force - exchange a new token even when the cached token is healthy.
   * @param signal - caller cancellation for lock waits, file reads, and the HTTP request.
   * @returns a structured success, no-op, unconfigured, or failure result.
   */
  async refresh(force: boolean, signal: AbortSignal): Promise<RefreshResult> {
    if (!this.config.configured) return this.notConfigured()
    signal.throwIfAborted()
    try {
      return await this.store.withLock(async () => {
        let current: StoredToken | undefined
        try {
          current = await this.store.read()
        } catch (error: unknown) {
          // A corrupt cache is a reason to replace it, not a reason to fail the refresh.
          if (!(error instanceof TokenFileError)) throw error
        }
        const now = this.now()
        if (!force && current !== undefined && this.matchesConfig(current) && !this.needsRefresh(current, now)) {
          await this.notifyTokenAvailable(current, signal)
          const gh = await this.configureGh(current.token, signal)
          signal.throwIfAborted()
          return this.stillValid(current, now, gh)
        }
        const record = await this.exchange(signal)
        signal.throwIfAborted()
        await this.store.write(record)
        this.token = record
        this.loadError = undefined
        this.snapshots.invalidateAll()
        await this.notifyTokenAvailable(record, signal)
        const gh = await this.configureGh(record.token, signal)
        signal.throwIfAborted()
        return {
          ok: true as const,
          refreshed: true as const,
          expires_at: record.expires_at,
          expires_in_seconds: secondsUntil(record.expires_at, this.now()),
          token_file: this.config.tokenPath,
          gh_configured: gh.configured,
          ...(gh.message === undefined ? {} : { gh_message: gh.message }),
        }
      }, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      return this.failed(error)
    }
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      this.token = await this.store.read()
      this.loadError = undefined
    } catch (error: unknown) {
      this.token = undefined
      this.loadError = safeErrorMessage(error)
    }
  }

  private currentSnapshot(): TokenSnapshot {
    const base = {
      tokenPath: this.config.tokenPath,
      refreshThresholdSeconds: this.config.refreshThresholdSeconds,
    }
    if (!this.config.configured) {
      return {
        ...base,
        state: 'unconfigured',
        configured: false,
        missing: this.config.missing,
      }
    }
    if (this.loadError !== undefined) {
      return {
        ...base,
        state: 'invalid',
        configured: true,
        detail: this.loadError,
      }
    }
    if (this.token === undefined) {
      return {
        ...base,
        state: 'missing',
        configured: true,
      }
    }
    if (!this.matchesConfig(this.token)) {
      return {
        ...base,
        state: 'missing',
        configured: true,
        detail: 'cached token belongs to a different GitHub App or installation',
      }
    }
    const expiresAtMs = Date.parse(this.token.expires_at)
    if (!Number.isFinite(expiresAtMs)) {
      return {
        ...base,
        state: 'invalid',
        configured: true,
        detail: 'cached token has an invalid expires_at',
      }
    }
    const now = this.now()
    const remainingMs = expiresAtMs - now
    const expiresInSeconds = Math.max(0, Math.floor(remainingMs / 1000))
    const state: TokenState = remainingMs <= 0
      ? 'expired'
      : remainingMs < this.config.refreshThresholdSeconds * 1000
        ? 'expiring'
        : 'valid'
    return {
      ...base,
      state,
      configured: true,
      expiresAt: this.token.expires_at,
      expiresInSeconds,
    }
  }

  private matchesConfig(token: StoredToken): boolean {
    return token.app_id === this.config.appId && token.installation_id === this.config.installationId
  }

  private needsRefresh(token: StoredToken, now: number): boolean {
    const expiresAtMs = Date.parse(token.expires_at)
    if (!Number.isFinite(expiresAtMs)) return true
    const remainingMs = expiresAtMs - now
    return remainingMs <= 0 || remainingMs < this.config.refreshThresholdSeconds * 1000
  }

  private async exchange(signal: AbortSignal): Promise<StoredToken> {
    const appId = this.config.appId
    const installationId = this.config.installationId
    if (appId === undefined || installationId === undefined) {
      throw new Error('GitHub App credentials are incomplete')
    }
    const pem = await this.readPrivateKey(signal)
    const privateKey = parsePrivateKey(pem)
    const jwt = createAppJwt(appId, privateKey, this.now())
    return exchangeInstallationToken({
      apiBaseUrl: this.config.apiBaseUrl,
      appId,
      installationId,
      jwt,
      signal,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.options.requestTimeoutMs }),
    })
  }

  private async readPrivateKey(signal: AbortSignal): Promise<string> {
    return readPrivateKeyPem(this.config, this.options, signal)
  }

  private async notifyTokenAvailable(token: StoredToken, signal: AbortSignal): Promise<void> {
    if (this.options.onTokenAvailable === undefined) return
    signal.throwIfAborted()
    await this.options.onTokenAvailable(token)
    signal.throwIfAborted()
  }

  private async configureGh(token: string, signal: AbortSignal): Promise<GhAuthResult> {
    if (!this.config.configureGh) {
      return { configured: false, message: 'gh CLI configuration is disabled in the plugin settings' }
    }
    const configure = this.options.gh ?? configureGhAuth
    return configure(token, this.config.apiBaseUrl, signal)
  }

  private stillValid(token: StoredToken, now: number, gh: GhAuthResult): RefreshResult {
    return {
      ok: false,
      reason: 'token_still_valid',
      expires_at: token.expires_at,
      expires_in_seconds: secondsUntil(token.expires_at, now),
      gh_configured: gh.configured,
      ...(gh.message === undefined ? {} : { gh_message: gh.message }),
      hint: 'The cached token is still valid. If gh still returns 401, call refresh_ghapp_token with force=true to replace a revoked token.',
    }
  }

  private notConfigured(): RefreshResult {
    return {
      ok: false,
      reason: 'not_configured',
      missing: this.config.missing,
      hint: 'Configure appId, installationId, and privateKeyPath or privateKeyEnv for the github-agents-proxy plugin.',
    }
  }

  private failed(error: unknown): RefreshResult {
    return {
      ok: false,
      reason: 'refresh_failed',
      message: safeErrorMessage(error),
      hint: 'Check the App ID, installation ID, private key, network access, and apiBaseUrl, then retry.',
    }
  }
}

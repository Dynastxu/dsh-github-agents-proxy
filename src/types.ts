/**
 * Shared runtime values for the GitHub App token manager.
 *
 * @module @dynastxu/dsh-github-agents-proxy/types
 */

/** Health of the cached installation token at one instant. */
export type TokenState = 'valid' | 'expiring' | 'expired' | 'missing' | 'unconfigured' | 'invalid'

/** The token document persisted on disk. */
export interface StoredToken {
  /** Cache format version. */
  readonly version: 1
  /** GitHub installation access token. */
  readonly token: string
  /** GitHub-provided ISO-8601 expiry timestamp. */
  readonly expires_at: string
  /** GitHub App ID that issued the token. */
  readonly app_id: string
  /** Installation ID the token belongs to. */
  readonly installation_id: string
}

/** One instant's view of the cached token. */
export interface TokenSnapshot {
  /** Health at the snapshot instant. */
  readonly state: TokenState
  /** Whether GitHub App credentials are configured. */
  readonly configured: boolean
  /** GitHub expiry timestamp, when a token document exists. */
  readonly expiresAt?: string
  /** Whole seconds until expiry, floored at zero. */
  readonly expiresInSeconds?: number
  /** Absolute cached-token path. */
  readonly tokenPath: string
  /** Configured refresh threshold in seconds. */
  readonly refreshThresholdSeconds: number
  /** Credential fields absent from an unconfigured installation. */
  readonly missing?: readonly string[]
  /** Why the token document is unusable, when it exists but cannot be trusted. */
  readonly detail?: string
}

/** Successful refresh outcome. */
export interface RefreshSuccess {
  readonly ok: true
  /** Whether this call performed the GitHub exchange. */
  readonly refreshed: true
  readonly expires_at: string
  readonly expires_in_seconds: number
  readonly token_file: string
  /** Whether the shared gh CLI accepted the token. */
  readonly gh_configured: boolean
  /** Non-fatal gh setup warning, or why gh was not configured. */
  readonly gh_message?: string
}

/** A refresh request declined because the cached token remains usable. */
export interface RefreshStillValid {
  readonly ok: false
  readonly reason: 'token_still_valid'
  readonly expires_at: string
  readonly expires_in_seconds: number
  /** Whether the shared gh CLI accepted the token. */
  readonly gh_configured: boolean
  /** Non-fatal gh setup warning, or why gh was not configured. */
  readonly gh_message?: string
  readonly hint: string
}

/** A refresh request refused because no complete GitHub App credential set exists. */
export interface RefreshNotConfigured {
  readonly ok: false
  readonly reason: 'not_configured'
  readonly missing: readonly string[]
  readonly hint: string
}

/** A refresh request that reached GitHub or local storage and failed. */
export interface RefreshFailed {
  readonly ok: false
  readonly reason: 'refresh_failed'
  readonly message: string
  readonly hint: string
}

/** Canonical result of `refresh_ghapp_token`. */
export type RefreshResult = RefreshSuccess | RefreshStillValid | RefreshNotConfigured | RefreshFailed

/** Canonical result of `check_ghapp_token_status`. */
export interface StatusResult {
  readonly ok: true
  readonly status: TokenState
  readonly configured: boolean
  readonly needs_refresh: boolean
  readonly token_file: string
  readonly threshold_seconds: number
  readonly expires_at?: string
  readonly expires_in_seconds?: number
  readonly remaining?: string
  readonly missing?: readonly string[]
  readonly message?: string
  readonly hint?: string
}

/**
 * GitHub installation-token exchange.
 *
 * @module @dynastxu/dsh-github-agents-proxy/github
 */

import type { StoredToken } from './types.ts'

/** GitHub rejected or could not complete the installation-token request. */
export class GitHubApiError extends Error {
  /** HTTP status returned by GitHub. */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

/** Inputs for one installation-token request. */
export interface TokenExchangeRequest {
  /** API origin, optionally including a GitHub Enterprise `api/v3` path. */
  readonly apiBaseUrl: string
  /** GitHub App ID written into the JWT `iss` claim. */
  readonly appId: string
  /** Installation receiving the token. */
  readonly installationId: string
  /** App JWT signed with the private key. */
  readonly jwt: string
  /** Caller cancellation. */
  readonly signal: AbortSignal
  /** Fetch implementation; defaults to the process global. */
  readonly fetch?: typeof fetch
  /** Request deadline in milliseconds; defaults to 15 seconds. */
  readonly timeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_CHARS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_ERROR_BODY_CHARS ? normalized : `${normalized.slice(0, MAX_ERROR_BODY_CHARS)}…`
}

function errorMessageFromBody(text: string): string {
  if (text.trim().length === 0) return 'empty response'
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value) && typeof value.message === 'string' && value.message.trim().length > 0) {
      return truncate(value.message)
    }
  } catch {
    // Non-JSON error bodies are still useful when truncated.
  }
  return truncate(text)
}

/**
 * Exchange a GitHub App JWT for one installation access token.
 * @param request - App, installation, JWT, and transport facts.
 * @returns the persisted-token document for the fresh installation token.
 * @throws GitHubApiError when GitHub refuses the request or returns an unusable body.
 */
export async function exchangeInstallationToken(request: TokenExchangeRequest): Promise<StoredToken> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GitHubApiError(0, 'request timeout must be a positive finite number')
  }
  const fetchImpl = request.fetch ?? globalThis.fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout])
  const url = `${request.apiBaseUrl}/app/installations/${encodeURIComponent(request.installationId)}/access_tokens`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${request.jwt}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-github-agents-proxy',
        'x-github-api-version': '2022-11-28',
      },
      body: '{}',
      signal,
    })
  } catch (error: unknown) {
    if (request.signal.aborted) throw error
    if (timeout.aborted) throw new GitHubApiError(0, `GitHub token request timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw new GitHubApiError(0, `GitHub token request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new GitHubApiError(response.status, `GitHub API ${response.status}: ${errorMessageFromBody(text)}`)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new GitHubApiError(response.status, 'GitHub returned a non-JSON installation-token response')
  }
  if (!isRecord(body)) {
    throw new GitHubApiError(response.status, 'GitHub returned an unexpected installation-token response')
  }
  const token = body.token
  const expiresAt = body.expires_at
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new GitHubApiError(response.status, 'GitHub installation-token response omitted the token')
  }
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
    throw new GitHubApiError(response.status, 'GitHub installation-token response omitted a valid expires_at')
  }

  return {
    version: 1,
    token: token.trim(),
    expires_at: expiresAt,
    app_id: request.appId,
    installation_id: request.installationId,
  }
}

/**
 * GitHub API transport.
 *
 * One request helper serves both the App-JWT token exchange and
 * installation-token REST calls, so timeouts, headers, error-body extraction,
 * and response decoding behave identically everywhere.
 *
 * @module @dynastxu/dsh-github-agents-proxy/github
 */

import type { StoredToken } from './types.ts'

/** GitHub rejected or could not complete a request. */
export class GitHubApiError extends Error {
  /** HTTP status returned by GitHub, or 0 when no response arrived. */
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

/** One authenticated GitHub REST call. */
export interface GitHubRestRequest {
  /** API origin, optionally including a GitHub Enterprise `api/v3` path. */
  readonly apiBaseUrl: string
  /** Complete `authorization` header value, for example `Bearer ghs_…`. */
  readonly authorization: string
  /** HTTP method. */
  readonly method: 'GET' | 'POST'
  /** Resource path beginning with `/`, without a query string. */
  readonly path: string
  /** JSON request body; omitted for a bodyless request. */
  readonly body?: unknown
  /** Caller cancellation. */
  readonly signal: AbortSignal
  /** Fetch implementation; defaults to the process global. */
  readonly fetch?: typeof fetch
  /** Request deadline in milliseconds; defaults to 15 seconds. */
  readonly timeoutMs?: number
}

/** Status and decoded JSON body of a GitHub REST response. */
export interface GitHubRestResponse {
  /** HTTP status of the response. */
  readonly status: number
  /** Decoded JSON body. */
  readonly body: unknown
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

function errorsMessage(value: Record<string, unknown>): string {
  const errors = value.errors
  if (!Array.isArray(errors)) return ''
  const messages: string[] = []
  for (const entry of errors) {
    if (typeof entry === 'string') messages.push(entry)
    else if (isRecord(entry) && typeof entry.message === 'string' && entry.message.trim().length > 0) {
      messages.push(entry.message.trim())
    }
  }
  return [...new Set(messages)].join('; ')
}

function errorMessageFromBody(text: string): string {
  if (text.trim().length === 0) return 'empty response'
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value)) {
      const message = typeof value.message === 'string' ? value.message.trim() : ''
      const details = errorsMessage(value)
      if (message.length > 0 || details.length > 0) {
        return truncate(message.length > 0 && details.length > 0 ? `${message}: ${details}` : message || details)
      }
    }
  } catch {
    // Non-JSON error bodies are still useful when truncated.
  }
  return truncate(text)
}

/**
 * Send one authenticated GitHub REST request and decode its JSON body.
 * @param request - endpoint, method, authorization, and transport facts.
 * @returns the HTTP status and decoded body of a successful response.
 * @throws GitHubApiError when no response arrives, GitHub reports a failure, or the body is not JSON.
 */
export async function githubRest(request: GitHubRestRequest): Promise<GitHubRestResponse> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GitHubApiError(0, 'request timeout must be a positive finite number')
  }
  const fetchImpl = request.fetch ?? globalThis.fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout])
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: request.authorization,
    'user-agent': 'dsh-github-agents-proxy',
    'x-github-api-version': '2022-11-28',
  }
  if (request.body !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  try {
    response = await fetchImpl(`${request.apiBaseUrl}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal,
    })
  } catch (error: unknown) {
    if (request.signal.aborted) throw error
    if (timeout.aborted) throw new GitHubApiError(0, `GitHub request timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw new GitHubApiError(0, `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new GitHubApiError(response.status, `GitHub API ${response.status}: ${errorMessageFromBody(text)}`)
  }

  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new GitHubApiError(response.status, 'GitHub returned a non-JSON response')
  }
}

/**
 * Exchange a GitHub App JWT for one installation access token.
 * @param request - App, installation, JWT, and transport facts.
 * @returns the persisted-token document for the fresh installation token.
 * @throws GitHubApiError when GitHub refuses the request or returns an unusable body.
 */
export async function exchangeInstallationToken(request: TokenExchangeRequest): Promise<StoredToken> {
  const response = await githubRest({
    apiBaseUrl: request.apiBaseUrl,
    authorization: `Bearer ${request.jwt}`,
    method: 'POST',
    path: `/app/installations/${encodeURIComponent(request.installationId)}/access_tokens`,
    body: {},
    signal: request.signal,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  })
  const body = response.body
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

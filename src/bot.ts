/**
 * GitHub App bot identity derivation and Agent-process git environment.
 *
 * The bot login comes from the App slug, while the noreply address uses the
 * bot's numeric user id (not the App id). Both are fetched from the existing
 * App ID plus private key; neither is a user setting.
 *
 * @module @dynastxu/dsh-github-agents-proxy/bot
 */

import { createAppJwt, parsePrivateKey } from './jwt.ts'
import { readPrivateKeyPem, type CredentialsResolver } from './manager.ts'
import type { ResolvedConfig } from './config.ts'

/** Git identity of one GitHub App's bot user. */
export interface BotIdentity {
  /** Bot login, for example `dsh-agents[bot]`. */
  readonly login: string
  /** GitHub noreply address linked to the bot user. */
  readonly email: string
  /** Bot user id, which is not the App id. */
  readonly userId: number
  /** App slug used to derive the login. */
  readonly appSlug: string
  /** Avatar URL of the App owner from `GET /app`, when GitHub reports one. */
  readonly avatarUrl?: string
}

/** Runtime overrides used by tests and the Host adapter. */
export interface BotIdentityOptions {
  /** Fetch implementation; defaults to the process global. */
  readonly fetch?: typeof fetch
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
  /** Credential service used by `privateKeyEnv`. */
  readonly credentials?: CredentialsResolver
  /** Environment used by `privateKeyEnv` when no credential service is present. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Request deadline in milliseconds; defaults to 15 seconds. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ERROR_CHARS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_ERROR_CHARS ? normalized : `${normalized.slice(0, MAX_ERROR_CHARS)}…`
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-github-agents-proxy', ...headers },
    signal: combined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}: ${messageOf(text)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GitHub returned non-JSON data for ${url}`)
  }
}

/**
 * Resolve the App bot's numeric user id, login, and noreply email.
 *
 * `GET /app` needs the App JWT; `GET /users/<slug>[bot]` is public.
 * @param config - resolved App configuration.
 * @param options - transport, clock, and credential overrides.
 * @param signal - caller cancellation.
 * @returns the bot identity.
 * @throws when the App is unconfigured, credentials fail, or GitHub returns an unusable response.
 */
export async function resolveBotIdentity(
  config: ResolvedConfig,
  options: BotIdentityOptions = {},
  signal: AbortSignal,
): Promise<BotIdentity> {
  if (!config.configured || config.appId === undefined) {
    throw new Error('GitHub App credentials are not configured')
  }
  const pem = await readPrivateKeyPem(config, options, signal)
  const key = parsePrivateKey(pem)
  const jwt = createAppJwt(config.appId, key, (options.now ?? Date.now)())
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const app = await getJson(`${config.apiBaseUrl}/app`, { authorization: `Bearer ${jwt}` }, fetchImpl, signal, timeoutMs)
  if (!isRecord(app) || typeof app.slug !== 'string' || app.slug.trim() === '') {
    throw new Error('GitHub App response omitted the App slug')
  }
  const slug = app.slug.trim()
  const login = `${slug}[bot]`
  const owner = isRecord(app.owner) ? app.owner : undefined
  const avatarUrl = owner !== undefined && typeof owner.avatar_url === 'string'
    ? owner.avatar_url.trim()
    : ''
  const user = await getJson(
    `${config.apiBaseUrl}/users/${encodeURIComponent(login)}`,
    {},
    fetchImpl,
    signal,
    timeoutMs,
  )
  if (!isRecord(user) || typeof user.login !== 'string' || typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) {
    throw new Error(`GitHub user response for ${login} omitted its login or numeric id`)
  }
  return {
    login: user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
    userId: user.id,
    appSlug: slug,
    ...(avatarUrl === '' ? {} : { avatarUrl }),
  }
}

const GIT_IDENTITY_ENV = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const

let previousEnvironment: Map<string, string | undefined> | undefined

/**
 * Install the bot as the default author and committer of Agent child processes.
 *
 * Only process environment variables are changed; no repository, global git,
 * or gh configuration is touched. The first call records every previous value
 * so {@link clearBotIdentity} can restore them.
 * @param identity - bot identity to install.
 */
export function installBotIdentity(identity: BotIdentity): void {
  previousEnvironment ??= new Map(GIT_IDENTITY_ENV.map(key => [key, process.env[key]]))
  process.env.GIT_AUTHOR_NAME = identity.login
  process.env.GIT_AUTHOR_EMAIL = identity.email
  process.env.GIT_COMMITTER_NAME = identity.login
  process.env.GIT_COMMITTER_EMAIL = identity.email
}

/**
 * Restore the environment values that existed before the first install.
 */
export function clearBotIdentity(): void {
  if (previousEnvironment === undefined) return
  for (const key of GIT_IDENTITY_ENV) {
    const value = previousEnvironment.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  previousEnvironment = undefined
}

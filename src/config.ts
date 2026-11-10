/**
 * Configuration schema and resolution for the GitHub App token manager.
 *
 * Every user-facing field is volatile so `@deepseek-ai/dsh-settings` can edit
 * it from the Web UI and commit changes into the running plugin without a
 * remount. Consumers read the current references through {@link readConfig}.
 *
 * @module @dynastxu/dsh-github-agents-proxy/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Default remaining lifetime that triggers a refresh. */
export const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300

/** Default GitHub API endpoint. */
export const DEFAULT_API_BASE_URL = 'https://api.github.com'

/** Basename of the cached token document. */
export const DEFAULT_TOKEN_FILENAME = 'github-app-token.json'

/** Editable plugin configuration, as plain values. */
export interface ConfigValues {
  /** GitHub App ID. Numeric strings are accepted. */
  appId?: string | number
  /** GitHub App installation ID. Numeric strings are accepted. */
  installationId?: string | number
  /** Absolute or `~`-relative path to the App's PEM private key. */
  privateKeyPath?: string
  /**
   * Credential reference (an environment-style name) resolved through
   * `ctx.credentials`, with the process environment as the fallback when the
   * credential service is absent. Mutually exclusive with `privateKeyPath`.
   */
  privateKeyEnv?: string
  /** Cached installation-token file. Defaults under the active profile directory. */
  tokenPath?: string
  /** Refresh when less than this many seconds remain; defaults to 300. */
  refreshThresholdSeconds?: number
  /** GitHub API base URL; defaults to `https://api.github.com`. */
  apiBaseUrl?: string
  /** Inject a runtime-context status snapshot; defaults to true. */
  contextInjection?: boolean
  /** Authenticate the shared gh CLI after a refresh; defaults to true. */
  configureGh?: boolean
}

/**
 * The Loader-facing Config schema projected into the settings form.
 *
 * `appId` and `installationId` accept numbers for hand-written YAML, while the
 * page edits them as text.
 */
export const Config = z.object({
  appId: z.union([z.string(), z.number()]).description('GitHub App ID.').volatile(),
  installationId: z.union([z.string(), z.number()]).description('GitHub App installation ID.').volatile(),
  privateKeyPath: z.string().description('Path to the App PEM private key; mutually exclusive with the credential reference.').volatile(),
  privateKeyEnv: z.string().description('Credential reference holding the App PEM private key.').volatile(),
  tokenPath: z.string().description('Cached installation-token file; empty uses the active profile directory.').volatile(),
  refreshThresholdSeconds: z.number().step(1).min(0).default(DEFAULT_REFRESH_THRESHOLD_SECONDS)
    .description('Refresh when fewer than this many seconds remain.').volatile(),
  apiBaseUrl: z.string().default(DEFAULT_API_BASE_URL)
    .description('GitHub API base URL, including a GitHub Enterprise api/v3 path when needed.').volatile(),
  contextInjection: z.boolean().default(true)
    .description('Inject the token status into runtime context.').volatile(),
  configureGh: z.boolean().default(true)
    .description('Run gh auth login --with-token after a successful refresh so plain gh commands work.').volatile(),
})

/** Loader-facing Config type: one stable reference per volatile field. */
export type Config = ReturnType<typeof Config>

/** Configuration accepted by {@link readConfig}: Loader references or plain values. */
export type ConfigInput = Config | ConfigValues

/** Environment and filesystem facts used to resolve relative configuration. */
export interface ConfigEnvironment {
  /** Environment map; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Operating-system home used by `~` expansion; defaults to `os.homedir()`. */
  readonly home?: string
  /** Base for relative paths; defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Directory used when `tokenPath` is omitted. */
  readonly defaultTokenDir?: string
}

/** Fully resolved and validated plugin configuration. */
export interface ResolvedConfig {
  /** Whether a complete GitHub App credential set is present. */
  readonly configured: boolean
  /** GitHub App ID, when configured. */
  readonly appId?: string
  /** Installation ID, when configured. */
  readonly installationId?: string
  /** Absolute private-key path, when configured. */
  readonly privateKeyPath?: string
  /** Credential reference for the private key, when configured. */
  readonly privateKeyEnv?: string
  /** Absolute cached-token path. */
  readonly tokenPath: string
  /** Refresh threshold in seconds. */
  readonly refreshThresholdSeconds: number
  /** Normalized GitHub API base URL. */
  readonly apiBaseUrl: string
  /** Whether the runtime-context status contribution is enabled. */
  readonly contextInjection: boolean
  /** Whether a refreshed token is also installed into the shared gh CLI. */
  readonly configureGh: boolean
  /** Credential fields still absent when `configured` is false. */
  readonly missing: readonly string[]
}

/** A configuration value that cannot produce a usable manager. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

/** Credential fields reported by an unconfigured installation. */
export const CREDENTIAL_FIELD_NAMES = ['appId', 'installationId', 'privateKeyPath'] as const

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Readable<T> {
  get(): T
}

function isReadable<T>(value: unknown): value is Readable<T> {
  return typeof value === 'object'
    && value !== null
    && 'get' in value
    && typeof (value as { get?: unknown }).get === 'function'
}

function readField<T>(value: T | Readable<T> | undefined): T | undefined {
  return isReadable<T>(value) ? value.get() : value
}

/**
 * Read current plain values from the Loader's volatile Config references.
 * @param config - Loader references, or plain values in tests and direct calls.
 * @returns a detached plain configuration object.
 */
export function readConfig(config: ConfigInput = {}): ConfigValues {
  const appId = readField(config.appId)
  const installationId = readField(config.installationId)
  const privateKeyPath = readField(config.privateKeyPath)
  const privateKeyEnv = readField(config.privateKeyEnv)
  const tokenPath = readField(config.tokenPath)
  const refreshThresholdSeconds = readField(config.refreshThresholdSeconds)
  const apiBaseUrl = readField(config.apiBaseUrl)
  const contextInjection = readField(config.contextInjection)
  const configureGh = readField(config.configureGh)
  return {
    ...(appId === undefined ? {} : { appId }),
    ...(installationId === undefined ? {} : { installationId }),
    ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
    ...(privateKeyEnv === undefined ? {} : { privateKeyEnv }),
    ...(tokenPath === undefined ? {} : { tokenPath }),
    ...(refreshThresholdSeconds === undefined ? {} : { refreshThresholdSeconds }),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(contextInjection === undefined ? {} : { contextInjection }),
    ...(configureGh === undefined ? {} : { configureGh }),
  }
}

function hasValue(value: unknown): boolean {
  return value !== undefined
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

function absolutePath(value: string, cwd: string, home: string): string {
  const expanded = expandHome(value, home)
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

function resolveHarnessHome(env: Readonly<Record<string, string | undefined>>, home: string, cwd: string): string {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) {
    return absolutePath(configured, cwd, home)
  }
  return join(home, '.dsh')
}

function parseId(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigurationError(`${field} must be a positive integer`)
    }
    return String(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      throw new ConfigurationError(`${field} must be a positive integer`)
    }
    return trimmed
  }
  throw new ConfigurationError(`${field} must be a positive integer or a numeric string`)
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${field} must be a non-negative integer`)
  }
  return value
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${field} must be a boolean`)
  }
  return value
}

function parsePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty path`)
  }
  const trimmed = value.trim()
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseCredentialRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || !CREDENTIAL_REF_PATTERN.test(value)) {
    throw new ConfigurationError(`${field} must match ${String(CREDENTIAL_REF_PATTERN)}`)
  }
  return value
}

function parseApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ConfigurationError('apiBaseUrl must be an absolute URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigurationError('apiBaseUrl must use http or https')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new ConfigurationError('apiBaseUrl must not carry credentials, a query, or a fragment')
  }
  return trimmed
}

/**
 * Resolve and validate plain plugin configuration.
 *
 * No credential fields means the plugin is intentionally unconfigured and its
 * tools report how to finish setup. Any partial credential set fails at load,
 * because a half-configured installation would only fail later during `gh`.
 * @param config - plain plugin configuration.
 * @param environment - environment, home, and path defaults.
 * @returns the validated configuration with every path absolute.
 * @throws ConfigurationError when a supplied field is invalid or the credential set is incomplete.
 */
export function resolveConfig(config: ConfigValues = {}, environment: ConfigEnvironment = {}): ResolvedConfig {
  const env = environment.env ?? process.env
  const home = environment.home ?? homedir()
  const cwd = environment.cwd ?? process.cwd()
  const dshHome = resolveHarnessHome(env, home, cwd)
  const defaultTokenDir = environment.defaultTokenDir === undefined
    ? dshHome
    : absolutePath(environment.defaultTokenDir, cwd, home)

  const credentialFields = [config.appId, config.installationId, config.privateKeyPath, config.privateKeyEnv]
  const anyCredentialField = credentialFields.some(hasValue)
  const missing: string[] = []
  if (!hasValue(config.appId)) missing.push('appId')
  if (!hasValue(config.installationId)) missing.push('installationId')
  if (!hasValue(config.privateKeyPath) && !hasValue(config.privateKeyEnv)) missing.push('privateKeyPath')

  if (anyCredentialField && missing.length > 0) {
    throw new ConfigurationError(
      `GitHub App configuration is incomplete; missing ${missing.join(', ')}. `
      + 'Set appId, installationId, and exactly one of privateKeyPath or privateKeyEnv, or leave all credential fields unset.',
    )
  }

  if (config.privateKeyPath !== undefined && config.privateKeyEnv !== undefined) {
    throw new ConfigurationError('privateKeyPath and privateKeyEnv are mutually exclusive')
  }

  const tokenPath = config.tokenPath === undefined
    ? join(defaultTokenDir, DEFAULT_TOKEN_FILENAME)
    : absolutePath(parsePath(config.tokenPath, 'tokenPath'), cwd, home)
  const refreshThresholdSeconds = config.refreshThresholdSeconds === undefined
    ? DEFAULT_REFRESH_THRESHOLD_SECONDS
    : parseNonNegativeInteger(config.refreshThresholdSeconds, 'refreshThresholdSeconds')
  const apiBaseUrl = config.apiBaseUrl === undefined
    ? DEFAULT_API_BASE_URL
    : parseApiBaseUrl(config.apiBaseUrl)
  const contextInjection = config.contextInjection === undefined
    ? true
    : parseBoolean(config.contextInjection, 'contextInjection')
  const configureGh = config.configureGh === undefined
    ? true
    : parseBoolean(config.configureGh, 'configureGh')

  if (!anyCredentialField) {
    return {
      configured: false,
      tokenPath,
      refreshThresholdSeconds,
      apiBaseUrl,
      contextInjection,
      configureGh,
      missing: [...CREDENTIAL_FIELD_NAMES],
    }
  }

  const appId = parseId(config.appId, 'appId')
  const installationId = parseId(config.installationId, 'installationId')
  if (config.privateKeyPath !== undefined) {
    const privateKeyPath = absolutePath(parsePath(config.privateKeyPath, 'privateKeyPath'), cwd, home)
    return {
      configured: true,
      appId,
      installationId,
      privateKeyPath,
      tokenPath,
      refreshThresholdSeconds,
      apiBaseUrl,
      contextInjection,
      configureGh,
      missing: [],
    }
  }

  const privateKeyEnv = parseCredentialRef(config.privateKeyEnv, 'privateKeyEnv')
  return {
    configured: true,
    appId,
    installationId,
    privateKeyEnv,
    tokenPath,
    refreshThresholdSeconds,
    apiBaseUrl,
    contextInjection,
    configureGh,
    missing: [],
  }
}

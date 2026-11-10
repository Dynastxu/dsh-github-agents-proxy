/**
 * Private cached-token document and the cross-process refresh lock.
 *
 * The installation token is a bearer credential. It is written with owner-only
 * permissions through a same-directory atomic rename, and every refresh runs
 * under a lock file beside the token so concurrent Agents or Host processes
 * cannot overwrite each other or issue duplicate GitHub exchanges.
 *
 * @module @dynastxu/dsh-github-agents-proxy/token-store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { StoredToken } from './types.ts'

/** A cached-token file that exists but cannot be trusted. */
export class TokenFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenFileError'
  }
}

/** A refresh that waited too long for another writer's lock. */
export class TokenLockTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenLockTimeoutError'
  }
}

/** Options for {@link FileTokenStore}. */
export interface TokenStoreOptions {
  /** Maximum time to wait for the refresh lock; defaults to 10 seconds. */
  readonly lockTimeoutMs?: number
  /** Age after which an abandoned lock is reclaimed; defaults to 2 minutes. */
  readonly lockStaleMs?: number
  /** Poll interval while waiting for the lock; defaults to 50 milliseconds. */
  readonly lockPollMs?: number
  /** Clock used for lock aging and tests; defaults to `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_LOCK_STALE_MS = 120_000
const DEFAULT_LOCK_POLL_MS = 50

interface LockDocument {
  readonly owner: string
  readonly pid: number
  readonly acquired_at: string
}

interface ErrorWithCode {
  readonly code: unknown
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as ErrorWithCode).code
  return typeof code === 'string' ? code : undefined
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TokenFileError(`cached GitHub App token is invalid: ${field} must be a non-empty string`)
  }
  return value.trim()
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Validate one parsed token document.
 * @param value - parsed JSON value from the cached-token file.
 * @returns the typed token document.
 * @throws TokenFileError when the value is not the expected format.
 */
export function parseStoredToken(value: unknown): StoredToken {
  if (!isRecord(value)) throw new TokenFileError('cached GitHub App token file must contain a JSON object')
  if (value.version !== 1) throw new TokenFileError('cached GitHub App token file has an unsupported version')
  const token = readString(value, 'token')
  const expiresAt = readString(value, 'expires_at')
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new TokenFileError('cached GitHub App token is invalid: expires_at must be an ISO-8601 timestamp')
  }
  return {
    version: 1,
    token,
    expires_at: expiresAt,
    app_id: readString(value, 'app_id'),
    installation_id: readString(value, 'installation_id'),
  }
}

async function writeTokenDocument(file: string, token: StoredToken): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(token)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Read and write the private token document.
 */
export class FileTokenStore {
  /** Absolute cached-token path. */
  readonly tokenPath: string
  /** Lock-file path beside the token document. */
  readonly lockPath: string
  private readonly options: Required<TokenStoreOptions>

  /**
   * @param tokenPath - absolute cached-token path.
   * @param options - lock timing and clock overrides.
   */
  constructor(tokenPath: string, options: TokenStoreOptions = {}) {
    this.tokenPath = tokenPath
    this.lockPath = `${tokenPath}.lock`
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
      now: options.now ?? Date.now,
    }
  }

  /**
   * Read the cached token document.
   * @returns the token, or `undefined` when no file exists.
   * @throws TokenFileError when the file exists but is malformed.
   */
  async read(): Promise<StoredToken | undefined> {
    let text: string
    try {
      text = await readFile(this.tokenPath, 'utf8')
    } catch (error: unknown) {
      if (isEnoent(error)) return undefined
      throw new TokenFileError(`cannot read cached GitHub App token: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return parseStoredToken(JSON.parse(text))
    } catch (error: unknown) {
      if (error instanceof TokenFileError) throw error
      throw new TokenFileError('cached GitHub App token file is not valid JSON')
    }
  }

  /**
   * Atomically replace the cached token document.
   * @param token - the token to persist.
   */
  async write(token: StoredToken): Promise<void> {
    await writeTokenDocument(this.tokenPath, token)
  }

  /**
   * Run one operation while holding the cross-process refresh lock.
   * @param action - operation to run under the lock.
   * @param signal - caller cancellation; an aborted wait rejects with its reason.
   * @returns the action's result.
   */
  async withLock<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    // The lock lives beside the token, so the parent directory must exist
    // before the exclusive create; the token write itself also ensures it.
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 })
    const lock = await this.acquireLock(signal)
    try {
      return await action()
    } finally {
      await lock.release()
    }
  }

  private async acquireLock(signal: AbortSignal): Promise<LockHandle> {
    const deadline = this.options.now() + this.options.lockTimeoutMs
    const owner = randomUUID()
    while (true) {
      signal.throwIfAborted()
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          const document: LockDocument = {
            owner,
            pid: process.pid,
            acquired_at: new Date(this.options.now()).toISOString(),
          }
          await handle.writeFile(JSON.stringify(document), 'utf8')
          await handle.sync()
        } catch (error: unknown) {
          await handle.close().catch(() => undefined)
          await rm(this.lockPath, { force: true }).catch(() => undefined)
          throw error
        }
        await handle.close()
        return new LockHandle(this.lockPath, owner)
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error
        if (await this.isStaleLock()) {
          await rm(this.lockPath, { force: true }).catch(() => undefined)
          continue
        }
        if (this.options.now() >= deadline) {
          const budget = this.options.lockTimeoutMs >= 1000
            ? `${Math.round(this.options.lockTimeoutMs / 1000)}s`
            : `${this.options.lockTimeoutMs}ms`
          throw new TokenLockTimeoutError(`timed out after ${budget} waiting for another GitHub App token refresh`)
        }
        await sleep(this.options.lockPollMs, signal)
      }
    }
  }

  private async isStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath)
      return this.options.now() - info.mtimeMs > this.options.lockStaleMs
    } catch (error: unknown) {
      if (isEnoent(error)) return true
      throw error
    }
  }
}

class LockHandle {
  constructor(
    private readonly lockPath: string,
    private readonly owner: string,
  ) {}

  async release(): Promise<void> {
    try {
      const text = await readFile(this.lockPath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || parsed.owner !== this.owner) return
      await rm(this.lockPath, { force: true })
    } catch (error: unknown) {
      if (isEnoent(error) || error instanceof SyntaxError) return
      // The token write, when any, already committed. A failed unlock leaves a
      // stale lock that the next caller reclaims after `lockStaleMs`.
      return
    }
  }
}

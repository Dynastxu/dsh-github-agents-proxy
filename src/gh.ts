/**
 * Install a refreshed installation token into the shared GitHub CLI.
 *
 * DSH strips credential-shaped ambient variables from child processes, so
 * exporting `GH_TOKEN` from the Host would not reach a bash-started `gh`.
 * Writing the token through `gh auth login --with-token` instead makes plain
 * `gh` use it. No global git credential helper is installed.
 *
 * @module @dynastxu/dsh-github-agents-proxy/gh
 */

import { spawn } from 'node:child_process'

/** Outcome of installing a token into the shared gh CLI. */
export interface GhAuthResult {
  /** Whether `gh auth login --with-token` accepted the token. */
  readonly configured: boolean
  /** Non-fatal setup warning, or the reason login failed. */
  readonly message?: string
}

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const GH_TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

const GH_TIMEOUT_MS = 20_000
const MAX_MESSAGE_CHARS = 500

/** Hostname gh should treat as its active account. */
export function ghHostname(apiBaseUrl: string): string {
  try {
    const url = new URL(apiBaseUrl)
    return url.hostname === 'api.github.com' ? 'github.com' : url.hostname
  } catch {
    return 'github.com'
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_MESSAGE_CHARS ? normalized : `${normalized.slice(0, MAX_MESSAGE_CHARS)}…`
}

function runGh(args: readonly string[], input: string | undefined, signal: AbortSignal): Promise<RunResult> {
  const env = { ...process.env }
  for (const key of GH_TOKEN_ENV_KEYS) delete env[key]
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawn('gh', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    }
    const onAbort = (): void => {
      try { child.kill() } catch { /* the process may already have exited */ }
      finish(1)
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* the process may already have exited */ }
      stderr += '\ngh command timed out'
      finish(1)
    }, GH_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', (error) => {
      stderr += `\n${errorMessage(error)}`
      finish(1)
    })
    child.on('close', code => { finish(code ?? 1) })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input === undefined ? '' : `${input}\n`)
  })
}

function failure(result: RunResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  return text === '' ? `gh exited with code ${result.code}` : errorMessage(text)
}

/**
 * Authenticate the shared gh CLI with a fresh installation token.
 * @param token - installation access token; never logged.
 * @param apiBaseUrl - GitHub API base URL used to derive the gh hostname.
 * @param signal - caller cancellation.
 * @returns whether login succeeded and an optional warning.
 */
export async function configureGhAuth(token: string, apiBaseUrl: string, signal: AbortSignal): Promise<GhAuthResult> {
  const hostname = ghHostname(apiBaseUrl)
  const login = await runGh(['auth', 'login', '--hostname', hostname, '--with-token'], token, signal)
  if (login.code !== 0) return { configured: false, message: failure(login) }
  return { configured: true }
}

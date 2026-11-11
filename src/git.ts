/**
 * Git subprocess plumbing shared by the Agent-facing tools.
 *
 * `commit_changes` and `create_pull_request` both run git in the session working
 * directory through the Host subprocess service, so the runner, working-directory
 * resolution, and bounded output handling live here once.
 *
 * @module @dynastxu/dsh-github-agents-proxy/git
 */

import type { ToolRunContext } from './tools.ts'

/** One collected subprocess stream. */
interface CollectedStream {
  readFrom(offset: number): { readonly text: string }
}

/** The slice of a subprocess handle used by the tools. */
interface SubprocessHandle {
  readonly done: Promise<{ readonly exitCode: number | null }>
  readonly collected: {
    readonly stdout?: CollectedStream
    readonly stderr?: CollectedStream
  }
}

/** The slice of `ctx.subprocess` used by the tools. */
export interface SubprocessLike {
  resolveExecutable(name: string): Promise<string>
  spawn(spec: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly stdio: {
      readonly stdin: 'ignore'
      readonly stdout: { readonly maxBytes: number }
      readonly stderr: { readonly maxBytes: number }
    }
    readonly graceMs: number
    readonly signal?: AbortSignal
    readonly env?: NodeJS.ProcessEnv
  }): SubprocessHandle
}

/** The slice of `ctx.workingDirectory` used by the tools. */
export interface WorkingDirectoryLike {
  ensure(agent: object, signal: AbortSignal): Promise<string>
}

/** Git services behind one tool, when the composition provides them. */
export interface GitRuntime {
  /** Subprocess service, when the composition provides one. */
  subprocess(): SubprocessLike | undefined
  /** Session working-directory service, when available. */
  workingDirectory(): WorkingDirectoryLike | undefined
}

/** Exit code and bounded output of one git invocation. */
export interface RunResult {
  /** Process exit code, or null when the process ended without one. */
  readonly code: number | null
  /** Collected standard output. */
  readonly stdout: string
  /** Collected standard error. */
  readonly stderr: string
}

const MAX_OUTPUT_CHARS = 2_000

/**
 * Collapse git output into one bounded line.
 * @param value - raw stream text.
 * @returns the normalized text, truncated past the bound.
 */
export function truncateOutput(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_OUTPUT_CHARS ? normalized : `${normalized.slice(0, MAX_OUTPUT_CHARS)}…`
}

/**
 * Describe a failed git invocation, preferring its own output.
 * @param result - collected exit code and streams.
 * @param fallback - text used when git produced no output.
 * @returns stderr, then stdout, or the fallback with the exit code.
 */
export function failureText(result: RunResult, fallback: string): string {
  const output = truncateOutput(`${result.stderr}\n${result.stdout}`)
  return output === '' ? `${fallback} (git exited with ${String(result.code)})` : output
}

/**
 * Run one git command and collect its bounded output.
 * @param subprocess - Host subprocess service.
 * @param executable - resolved git executable.
 * @param cwd - directory git runs in.
 * @param args - arguments after the executable.
 * @param env - environment the child process receives.
 * @param signal - caller cancellation.
 * @returns the exit code and both bounded streams.
 */
export async function runGit(
  subprocess: SubprocessLike,
  executable: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<RunResult> {
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 5_000,
    signal,
    env,
  })
  const outcome = await handle.done
  return {
    code: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/**
 * Resolve the directory a tool operates in for the calling Agent.
 * @param runtime - git services owned by the plugin.
 * @param exec - execution context carrying the Agent.
 * @returns the session working directory, or the Host process directory.
 */
export async function resolveWorkspaceCwd(runtime: GitRuntime, exec: ToolRunContext): Promise<string> {
  if (exec.agent !== undefined) {
    const workingDirectory = runtime.workingDirectory()
    if (workingDirectory !== undefined) return workingDirectory.ensure(exec.agent, exec.signal)
    const session = (exec.agent as { readonly session?: { readonly header?: { readonly cwd?: string } } }).session
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return process.cwd()
}

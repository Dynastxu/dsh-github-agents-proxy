/**
 * Dedicated commit tool for Agent changes.
 *
 * One git child process receives the App bot identity, and the commit message
 * gets a final `Co-authored-by` trailer for the human user. The tool owns the
 * commit so no repository or global git identity has to be changed.
 *
 * @module @dynastxu/dsh-github-agents-proxy/commit
 */

import type { BotIdentity } from './bot.ts'
import type { ToolDefinition, ToolRunContext } from './tools.ts'

/** One collected subprocess stream. */
interface CollectedStream {
  readFrom(offset: number): { readonly text: string }
}

/** The slice of a subprocess handle used by the commit tool. */
interface SubprocessHandle {
  readonly done: Promise<{ readonly exitCode: number | null }>
  readonly collected: {
    readonly stdout?: CollectedStream
    readonly stderr?: CollectedStream
  }
}

/** The slice of `ctx.subprocess` used by the commit tool. */
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

/** The slice of `ctx.workingDirectory` used by the commit tool. */
export interface WorkingDirectoryLike {
  ensure(agent: object, signal: AbortSignal): Promise<string>
}

/** Runtime dependencies behind the commit tool. */
export interface CommitRuntime {
  /** Current App bot identity, or undefined when resolution failed. */
  currentBotIdentity(): BotIdentity | undefined
  /** Subprocess service, when the composition provides one. */
  subprocess(): SubprocessLike | undefined
  /** Session working-directory service, when available. */
  workingDirectory(): WorkingDirectoryLike | undefined
}

/** Arguments accepted by `commit_changes`. */
export interface CommitArgs {
  /** Commit message. */
  readonly message: string
  /** How to stage changes before committing; defaults to all. */
  readonly stage?: 'all' | 'tracked' | 'staged'
  /** Allow an empty commit. */
  readonly allow_empty?: boolean
  /** Amend the current HEAD instead of creating a new commit. */
  readonly amend?: boolean
}

/** Successful commit outcome. */
export interface CommitSuccess {
  readonly ok: true
  /** New commit SHA. */
  readonly sha: string
  /** Current branch, or HEAD when detached. */
  readonly branch: string
  /** Author identity written to the commit. */
  readonly author: string
  /** Committer identity written to the commit. */
  readonly committer: string
  /** Co-author trailer, when the user identity was available. */
  readonly co_author?: string
}

/** Failed commit outcome. */
export interface CommitFailure {
  readonly ok: false
  /** Human-readable reason, including bounded git output when available. */
  readonly message: string
}

/** Canonical result of `commit_changes`. */
export type CommitResult = CommitSuccess | CommitFailure

interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const MAX_OUTPUT_CHARS = 2_000
const TIMEOUT_MS = 120_000

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_OUTPUT_CHARS ? normalized : `${normalized.slice(0, MAX_OUTPUT_CHARS)}…`
}

function failure(result: RunResult, fallback: string): string {
  const output = truncate(`${result.stderr}\n${result.stdout}`)
  return output === '' ? `${fallback} (git exited with ${String(result.code)})` : output
}

function identityValue(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim()
}

async function runGit(
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

async function resolveCwd(runtime: CommitRuntime, exec: ToolRunContext): Promise<string> {
  if (exec.agent !== undefined) {
    const workingDirectory = runtime.workingDirectory()
    if (workingDirectory !== undefined) return workingDirectory.ensure(exec.agent, exec.signal)
    const session = (exec.agent as { readonly session?: { readonly header?: { readonly cwd?: string } } }).session
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return process.cwd()
}

/**
 * Create the `commit_changes` tool.
 * @param runtime - bot identity and process services owned by the plugin.
 * @returns a registry-ready tool declaration.
 */
export function createCommitTool(runtime: CommitRuntime): ToolDefinition<CommitArgs, CommitResult> {
  return {
    name: 'commit_changes',
    description: 'Stage and commit the current changes as the GitHub App bot. Use this instead of running git commit '
      + 'directly. It sets the bot as author and committer and appends a final Co-authored-by trailer for the human user. '
      + 'It never pushes; push the resulting branch separately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          description: 'Commit message. A blank line and Co-authored-by trailer are added automatically when the user identity is available.',
        },
        stage: {
          type: 'string',
          enum: ['all', 'tracked', 'staged'],
          description: 'Stage all changes, tracked changes only, or leave the existing index untouched. Defaults to all.',
        },
        allow_empty: {
          type: 'boolean',
          description: 'Allow a commit with no staged changes.',
        },
        amend: {
          type: 'boolean',
          description: 'Amend the current HEAD instead of creating a new commit.',
        },
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          sha: { type: 'string' },
          branch: { type: 'string' },
          author: { type: 'string' },
          committer: { type: 'string' },
          co_author: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `Committed ${value.sha} on ${value.branch} as ${value.author}`
          + `${value.co_author === undefined ? '' : ` with ${value.co_author}`}.`
        : `Commit failed: ${value.message}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const message = args.message.trim()
      if (message === '') return { ok: false, message: 'commit message must not be empty' }
      const bot = runtime.currentBotIdentity()
      if (bot === undefined) {
        return { ok: false, message: 'GitHub App bot identity is unavailable; check the App credentials and restart or refresh the plugin' }
      }
      const subprocess = runtime.subprocess()
      if (subprocess === undefined) {
        return { ok: false, message: 'commit_changes requires the subprocess service in this composition' }
      }
      let cwd: string
      try {
        cwd = await resolveCwd(runtime, exec)
      } catch (error: unknown) {
        return { ok: false, message: `cannot resolve the working directory: ${error instanceof Error ? error.message : String(error)}` }
      }
      let executable: string
      try {
        executable = await subprocess.resolveExecutable('git')
      } catch (error: unknown) {
        return { ok: false, message: `git is unavailable: ${error instanceof Error ? error.message : String(error)}` }
      }
      const env: NodeJS.ProcessEnv = {
        GIT_AUTHOR_NAME: bot.login,
        GIT_AUTHOR_EMAIL: bot.email,
        GIT_COMMITTER_NAME: bot.login,
        GIT_COMMITTER_EMAIL: bot.email,
      }
      const stage = args.stage ?? 'all'
      if (stage !== 'staged') {
        const add = await runGit(subprocess, executable, cwd, ['add', stage === 'all' ? '-A' : '-u'], env, exec.signal)
        if (add.code !== 0) return { ok: false, message: `git add failed: ${failure(add, 'git add failed')}` }
      }

      const name = await runGit(subprocess, executable, cwd, ['config', '--global', '--get', 'user.name'], env, exec.signal)
      const email = await runGit(subprocess, executable, cwd, ['config', '--global', '--get', 'user.email'], env, exec.signal)
      const coAuthorName = name.code === 0 ? identityValue(name.stdout) : ''
      const coAuthorEmail = email.code === 0 ? identityValue(email.stdout) : ''
      const coAuthor = coAuthorName !== '' && coAuthorEmail !== ''
        ? `Co-authored-by: ${coAuthorName} <${coAuthorEmail}>`
        : undefined

      const commitArgs = ['commit', '-m', message]
      if (args.amend === true) commitArgs.push('--amend')
      if (args.allow_empty === true) commitArgs.push('--allow-empty')
      if (coAuthor !== undefined && !/^Co-authored-by:/mi.test(message)) commitArgs.push('--trailer', coAuthor)
      const commit = await runGit(subprocess, executable, cwd, commitArgs, env, exec.signal)
      if (commit.code !== 0) return { ok: false, message: `git commit failed: ${failure(commit, 'git commit failed')}` }

      const sha = await runGit(subprocess, executable, cwd, ['rev-parse', 'HEAD'], env, exec.signal)
      const branch = await runGit(subprocess, executable, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], env, exec.signal)
      if (sha.code !== 0 || branch.code !== 0) {
        return { ok: false, message: `commit succeeded but its identity could not be read: ${failure(sha.code !== 0 ? sha : branch, 'git rev-parse failed')}` }
      }
      return {
        ok: true,
        sha: sha.stdout.trim(),
        branch: branch.stdout.trim(),
        author: `${bot.login} <${bot.email}>`,
        committer: `${bot.login} <${bot.email}>`,
        ...(coAuthor === undefined ? {} : { co_author: coAuthor }),
      }
    },
  }
}

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
import { failureText, resolveWorkspaceCwd, runGit, type GitRuntime } from './git.ts'
import type { ToolDefinition } from './tools.ts'

export type { SubprocessLike, WorkingDirectoryLike } from './git.ts'

/** Runtime dependencies behind the commit tool. */
export interface CommitRuntime extends GitRuntime {
  /** Current App bot identity, or undefined when resolution failed. */
  currentBotIdentity(): BotIdentity | undefined
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

const TIMEOUT_MS = 120_000

function identityValue(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim()
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
        cwd = await resolveWorkspaceCwd(runtime, exec)
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
        if (add.code !== 0) return { ok: false, message: `git add failed: ${failureText(add, 'git add failed')}` }
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
      if (commit.code !== 0) return { ok: false, message: `git commit failed: ${failureText(commit, 'git commit failed')}` }

      const sha = await runGit(subprocess, executable, cwd, ['rev-parse', 'HEAD'], env, exec.signal)
      const branch = await runGit(subprocess, executable, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], env, exec.signal)
      if (sha.code !== 0 || branch.code !== 0) {
        return { ok: false, message: `commit succeeded but its identity could not be read: ${failureText(sha.code !== 0 ? sha : branch, 'git rev-parse failed')}` }
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

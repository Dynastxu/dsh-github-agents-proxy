import { describe, expect, it } from 'vitest'
import { createCommitTool, type SubprocessLike } from '../src/commit.ts'
import { abortSignal } from './helpers.ts'

interface Call {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv | undefined
}

function fakeSubprocess(calls: Call[], commitExitCode = 0): SubprocessLike {
  return {
    resolveExecutable: async () => 'git',
    spawn(spec) {
      const args = spec.argv.slice(1)
      calls.push({ args, env: spec.env })
      let stdout = ''
      if (args[0] === 'config' && args.at(-1) === 'user.name') stdout = 'dynastxu\n'
      if (args[0] === 'config' && args.at(-1) === 'user.email') stdout = '151742029+ETOofficial@users.noreply.github.com\n'
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') stdout = 'abc123\n'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') stdout = 'main\n'
      const exitCode = args[0] === 'commit' ? commitExitCode : 0
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: exitCode === 0 ? '' : 'commit rejected' }) },
        },
      }
    },
  }
}

describe('commit_changes tool', () => {
  it('stages, commits as the bot, and appends the user co-author trailer', async () => {
    const calls: Call[] = []
    const tool = createCommitTool({
      currentBotIdentity: () => ({
        login: 'dsh-agents[bot]',
        email: '354391007+dsh-agents[bot]@users.noreply.github.com',
        userId: 354391007,
        appSlug: 'dsh-agents',
        appName: 'dsh-agents',
      }),
      subprocess: () => fakeSubprocess(calls),
      workingDirectory: () => ({ ensure: async () => '/repo' }),
    })
    const result = await tool.execute({ message: 'test: commit tool' }, { signal: abortSignal(), agent: {} })
    expect(result).toMatchObject({
      ok: true,
      sha: 'abc123',
      branch: 'main',
      author: 'dsh-agents[bot] <354391007+dsh-agents[bot]@users.noreply.github.com>',
      co_author: 'Co-authored-by: dynastxu <151742029+ETOofficial@users.noreply.github.com>',
    })
    expect(calls.some(call => call.args.join(' ') === 'add -A')).toBe(true)
    const commit = calls.find(call => call.args[0] === 'commit')
    expect(commit?.args).toContain('--trailer')
    expect(commit?.args).toContain('Co-authored-by: dynastxu <151742029+ETOofficial@users.noreply.github.com>')
    expect(commit?.env?.GIT_AUTHOR_NAME).toBe('dsh-agents[bot]')
    expect(commit?.env?.GIT_COMMITTER_EMAIL).toBe('354391007+dsh-agents[bot]@users.noreply.github.com')
  })

  it('does not stage when the caller already staged changes', async () => {
    const calls: Call[] = []
    const tool = createCommitTool({
      currentBotIdentity: () => ({
        login: 'dsh-agents[bot]',
        email: '354391007+dsh-agents[bot]@users.noreply.github.com',
        userId: 354391007,
        appSlug: 'dsh-agents',
        appName: 'dsh-agents',
      }),
      subprocess: () => fakeSubprocess(calls),
      workingDirectory: () => ({ ensure: async () => '/repo' }),
    })
    const result = await tool.execute({ message: 'test: staged only', stage: 'staged' }, { signal: abortSignal() })
    expect(result.ok).toBe(true)
    expect(calls.some(call => call.args[0] === 'add')).toBe(false)
  })

  it('returns a structured failure when git commit fails', async () => {
    const tool = createCommitTool({
      currentBotIdentity: () => ({
        login: 'dsh-agents[bot]',
        email: '354391007+dsh-agents[bot]@users.noreply.github.com',
        userId: 354391007,
        appSlug: 'dsh-agents',
        appName: 'dsh-agents',
      }),
      subprocess: () => fakeSubprocess([], 1),
      workingDirectory: () => ({ ensure: async () => '/repo' }),
    })
    const result = await tool.execute({ message: 'test: rejected' }, { signal: abortSignal() })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('commit rejected') })
  })
})

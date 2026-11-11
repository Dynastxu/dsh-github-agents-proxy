import { describe, expect, it } from 'vitest'
import { isGitCommitCommand } from '../src/guard.ts'

describe('git commit command guard', () => {
  it('recognizes direct commit invocations', () => {
    expect(isGitCommitCommand('git commit -m test')).toBe(true)
    expect(isGitCommitCommand('cd repo && git -C . commit --amend')).toBe(true)
    expect(isGitCommitCommand('git -c user.name=x commit -m test')).toBe(true)
    expect(isGitCommitCommand('git.exe --no-pager commit -m test')).toBe(true)
  })

  it('leaves unrelated git commands alone', () => {
    expect(isGitCommitCommand('git status')).toBe(false)
    expect(isGitCommitCommand('git log --oneline')).toBe(false)
    expect(isGitCommitCommand('git commit-tree HEAD^{tree}')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { clearBotIdentity, installBotIdentity, resolveBotIdentity } from '../src/bot.ts'
import { abortSignal, createFixture, jsonResponse } from './helpers.ts'

function botFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/app')) return jsonResponse({ id: 5678739, slug: 'dsh-agents', name: 'DSH Agents' })
    if (url.endsWith('/users/dsh-agents%5Bbot%5D')) {
      return jsonResponse({ id: 354391007, login: 'dsh-agents[bot]', type: 'Bot' })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

describe('GitHub App bot identity', () => {
  it('derives the bot login and noreply email from the App slug and bot user id', async () => {
    const fixture = await createFixture()
    try {
      const identity = await resolveBotIdentity(fixture.config, { fetch: botFetch(), now: () => Date.now() }, abortSignal())
      expect(identity).toEqual({
        login: 'dsh-agents[bot]',
        email: '354391007+dsh-agents[bot]@users.noreply.github.com',
        userId: 354391007,
        appSlug: 'dsh-agents',
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('installs and restores the Agent git identity environment', () => {
    const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const
    const previous = new Map(keys.map(key => [key, process.env[key]]))
    clearBotIdentity()
    process.env.GIT_AUTHOR_NAME = 'previous-author'
    try {
      installBotIdentity({
        login: 'dsh-agents[bot]',
        email: '354391007+dsh-agents[bot]@users.noreply.github.com',
        userId: 354391007,
        appSlug: 'dsh-agents',
      })
      expect(process.env.GIT_AUTHOR_NAME).toBe('dsh-agents[bot]')
      expect(process.env.GIT_COMMITTER_EMAIL).toBe('354391007+dsh-agents[bot]@users.noreply.github.com')
      clearBotIdentity()
      expect(process.env.GIT_AUTHOR_NAME).toBe('previous-author')
      expect(process.env.GIT_COMMITTER_NAME).toBeUndefined()
    } finally {
      clearBotIdentity()
      for (const key of keys) {
        const value = previous.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

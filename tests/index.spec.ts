import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { createFixture, jsonResponse } from './helpers.ts'

interface CapturedTool {
  readonly name: string
}

interface CapturedPrompt {
  readonly name: string
  readonly text: (context: { readonly agent?: object }) => string
}

function fakeContext(): {
  ctx: Context
  tools: Map<string, CapturedTool>
  prompts: Map<string, CapturedPrompt>
  sections: Map<string, { readonly name: string; readonly text: string | (() => string) }>
} {
  const ctx = new Context()
  const tools = new Map<string, CapturedTool>()
  const prompts = new Map<string, CapturedPrompt>()
  const sections = new Map<string, { readonly name: string; readonly text: string | (() => string) }>()
  ctx.provide('tools', {
    register(definition: CapturedTool) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', {
    context(entry: CapturedPrompt) {
      prompts.set(entry.name, entry)
      return () => prompts.delete(entry.name)
    },
    section(entry: { readonly name: string; readonly text: string | (() => string) }) {
      sections.set(entry.name, entry)
      return () => sections.delete(entry.name)
    },
  })
  return { ctx, tools, prompts, sections }
}

describe('github-agents-proxy plugin', () => {
  it('exports the plugin name the bundle patch references', () => {
    expect(plugin.name).toBe('github-agents-proxy')
  })

  it('registers both tools and the runtime-context provider, then disposes them', async () => {
    const fake = fakeContext()
    try {
      await fake.ctx.plugin(plugin)
      expect([...fake.tools.keys()].sort()).toEqual(['check_ghapp_token_status', 'commit_changes', 'refresh_ghapp_token'])
      expect([...fake.prompts.keys()]).toEqual([plugin.GITHUB_APP_TOKEN_CONTEXT_NAME])
      expect([...fake.sections.keys()]).toEqual([plugin.GITHUB_APP_COMMIT_GUIDANCE_SECTION])
      const prompt = fake.prompts.get(plugin.GITHUB_APP_TOKEN_CONTEXT_NAME)!
      expect(prompt.text({})).toBe('')
      expect(prompt.text({ agent: {} })).toContain('[github-app-token] status=unconfigured')

      await fake.ctx.fiber.dispose()
      expect(fake.tools.size).toBe(0)
      expect(fake.prompts.size).toBe(0)
      expect(fake.sections.size).toBe(0)
    } finally {
      await fake.ctx.fiber.dispose()
    }
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('loads a configured installation and reports a missing cached token', async () => {
    const fixture = await createFixture()
    const fake = fakeContext()
    const previousName = process.env.GIT_AUTHOR_NAME
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/app')) return jsonResponse({ slug: 'dsh-agents' })
      if (url.endsWith('/users/dsh-agents%5Bbot%5D')) return jsonResponse({ id: 354391007, login: 'dsh-agents[bot]' })
      return new Response('not found', { status: 404 })
    })
    try {
      await fake.ctx.plugin(plugin, {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: fixture.config.privateKeyPath!,
        tokenPath: fixture.tokenPath,
      })
      const prompt = fake.prompts.get(plugin.GITHUB_APP_TOKEN_CONTEXT_NAME)!
      expect(prompt.text({ agent: {} })).toContain('[github-app-token] status=missing')

      expect(process.env.GIT_AUTHOR_NAME).toBe('dsh-agents[bot]')
      expect(process.env.GIT_COMMITTER_EMAIL).toBe('354391007+dsh-agents[bot]@users.noreply.github.com')
      const refresh = fake.tools.get('refresh_ghapp_token') as unknown as { name: string }
      expect(refresh.name).toBe('refresh_ghapp_token')
    } finally {
      await fake.ctx.fiber.dispose()
      if (previousName === undefined) delete process.env.GIT_AUTHOR_NAME
      else process.env.GIT_AUTHOR_NAME = previousName
      await fixture.cleanup()
    }
  })
})

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { createFixture } from './helpers.ts'

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
} {
  const ctx = new Context()
  const tools = new Map<string, CapturedTool>()
  const prompts = new Map<string, CapturedPrompt>()
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
  })
  return { ctx, tools, prompts }
}

describe('github-agents-proxy plugin', () => {
  it('exports the plugin name the bundle patch references', () => {
    expect(plugin.name).toBe('github-agents-proxy')
  })

  it('registers both tools and the runtime-context provider, then disposes them', async () => {
    const fake = fakeContext()
    try {
      await fake.ctx.plugin(plugin)
      expect([...fake.tools.keys()].sort()).toEqual(['check_ghapp_token_status', 'refresh_ghapp_token'])
      expect([...fake.prompts.keys()]).toEqual([plugin.GITHUB_APP_TOKEN_CONTEXT_NAME])
      const prompt = fake.prompts.get(plugin.GITHUB_APP_TOKEN_CONTEXT_NAME)!
      expect(prompt.text({})).toBe('')
      expect(prompt.text({ agent: {} })).toContain('[github-app-token] status=unconfigured')

      await fake.ctx.fiber.dispose()
      expect(fake.tools.size).toBe(0)
      expect(fake.prompts.size).toBe(0)
    } finally {
      await fake.ctx.fiber.dispose()
    }
  })

  it('loads a configured installation and reports a missing cached token', async () => {
    const fixture = await createFixture()
    const fake = fakeContext()
    try {
      await fake.ctx.plugin(plugin, {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: fixture.config.privateKeyPath!,
        tokenPath: fixture.tokenPath,
      })
      const prompt = fake.prompts.get(plugin.GITHUB_APP_TOKEN_CONTEXT_NAME)!
      expect(prompt.text({ agent: {} })).toContain('[github-app-token] status=missing')

      const refresh = fake.tools.get('refresh_ghapp_token') as unknown as { name: string }
      expect(refresh.name).toBe('refresh_ghapp_token')
    } finally {
      await fake.ctx.fiber.dispose()
      await fixture.cleanup()
    }
  })
})

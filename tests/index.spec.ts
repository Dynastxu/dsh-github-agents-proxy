import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('github-agents-proxy', () => {
  it('exports the plugin name the bundle patch references', () => {
    expect(plugin.name).toBe('github-agents-proxy')
  })

  it('mounts and disposes as a Cordis plugin', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(plugin)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

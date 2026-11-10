import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { GitHubAppTokenManager } from '../src/manager.ts'
import { FileTokenStore } from '../src/token-store.ts'
import { createRefreshTool, createStatusTool } from '../src/tools.ts'
import { abortSignal, createFixture, jsonResponse, tokenDocument } from './helpers.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')

describe('GitHub App token tools', () => {
  it('declares the expected tool schemas', () => {
    const config = resolveConfig({}, { env: {}, home: process.cwd(), cwd: process.cwd() })
    const manager = new GitHubAppTokenManager(config)
    const refresh = createRefreshTool(manager)
    const status = createStatusTool(manager)
    expect(refresh.name).toBe('refresh_ghapp_token')
    expect(status.name).toBe('check_ghapp_token_status')
    expect(refresh.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    expect((refresh.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('force')
    expect(status.output.schema).toMatchObject({ required: expect.arrayContaining(['ok', 'status', 'needs_refresh']) })
  })

  it('renders a still-valid refresh result with the action hint', async () => {
    const fixture = await createFixture()
    try {
      await new FileTokenStore(fixture.tokenPath).write(tokenDocument(1800, NOW))
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => NOW })
      await manager.initialize()
      const tool = createRefreshTool(manager)
      const result = await tool.execute({}, { signal: abortSignal() })
      expect(result).toMatchObject({ ok: false, reason: 'token_still_valid', expires_in_seconds: 1800 })
      const rendered = tool.output.render({}, result)
      expect(rendered[0]?.text).toContain('No refresh performed')
      expect(rendered[0]?.text).toContain('force=true')
    } finally {
      await fixture.cleanup()
    }
  })

  it('renders a successful refresh and updates status', async () => {
    const fixture = await createFixture({ configureGh: true })
    try {
      const fetchImpl = (async () => jsonResponse({
        token: 'ghs_tool',
        expires_at: new Date(NOW + 3600_000).toISOString(),
      })) as typeof fetch
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => NOW, fetch: fetchImpl, gh: async () => ({ configured: true }) })
      const refresh = createRefreshTool(manager)
      const result = await refresh.execute({ force: true }, { signal: abortSignal() })
      expect(result.ok).toBe(true)
      const rendered = refresh.output.render({ force: true }, result)
      expect(rendered[0]?.text).toContain('Refreshed the GitHub App installation token')
      expect(rendered[0]?.text).toContain('retry the failed gh command')

      const statusTool = createStatusTool(manager)
      const status = await statusTool.execute({}, { signal: abortSignal() })
      expect(status).toMatchObject({ ok: true, status: 'valid', needs_refresh: false })
      const statusText = statusTool.output.render({}, status)
      expect(statusText[0]?.text).toContain('[github-app-token] status=valid')
      expect(statusText[0]?.text).toContain('needs_refresh=false')
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports missing configuration from both tools', async () => {
    const config = resolveConfig({}, { env: {}, home: process.cwd(), cwd: process.cwd() })
    const manager = new GitHubAppTokenManager(config)
    const refresh = createRefreshTool(manager)
    const result = await refresh.execute({}, { signal: abortSignal() })
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' })
    if (!result.ok && result.reason === 'not_configured') {
      expect(result.missing).toEqual(['appId', 'installationId', 'privateKeyPath'])
    }
    expect(refresh.output.render({}, result)[0]?.text).toContain('missing: appId, installationId, privateKeyPath')

    const status = await createStatusTool(manager).execute({}, { signal: abortSignal() })
    expect(status).toMatchObject({ ok: true, status: 'unconfigured', configured: false, needs_refresh: true })
  })
})

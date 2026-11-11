import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { GitHubAppTokenManager } from '../src/manager.ts'
import { serveTokenStatus } from '../src/status.ts'
import type { TokenStatusResponse } from '../src/status-contract.ts'
import { createFixture, tokenDocument, type Fixture } from './helpers.ts'

const NOW = Date.parse('2026-11-11T00:00:00.000Z')

async function configuredManager(fixture: Fixture, now: number): Promise<GitHubAppTokenManager> {
  const manager = new GitHubAppTokenManager(fixture.config, { now: () => now })
  await manager.initialize()
  return manager
}

async function bodyOf(manager: GitHubAppTokenManager, now: number): Promise<TokenStatusResponse> {
  const response = await serveTokenStatus({ current: () => manager }, () => now)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-type')).toContain('application/json')
  return await response.json() as TokenStatusResponse
}

describe('live token status route', () => {
  it('reports a healthy cached token with the Host clock', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.tokenPath, JSON.stringify(tokenDocument(1800, NOW)))
      const manager = await configuredManager(fixture, NOW)
      const body = await bodyOf(manager, NOW)
      expect(body).toEqual({
        status: 'valid',
        configured: true,
        needs_refresh: false,
        token_file: fixture.tokenPath,
        threshold_seconds: 300,
        expires_at: new Date(NOW + 1_800_000).toISOString(),
        expires_in_seconds: 1800,
        remaining: '30m',
        server_time: new Date(NOW).toISOString(),
      })
      expect(JSON.stringify(body)).not.toContain('ghs_test_token')
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports a token inside the refresh threshold', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.tokenPath, JSON.stringify(tokenDocument(120, NOW)))
      const manager = await configuredManager(fixture, NOW)
      const body = await bodyOf(manager, NOW)
      expect(body.status).toBe('expiring')
      expect(body.needs_refresh).toBe(true)
      expect(body.remaining).toBe('2m')
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports a configured installation without a cached token', async () => {
    const fixture = await createFixture()
    try {
      const manager = await configuredManager(fixture, NOW)
      const body = await bodyOf(manager, NOW)
      expect(body.status).toBe('missing')
      expect(body.configured).toBe(true)
      expect(body.needs_refresh).toBe(true)
      expect(body.expires_at).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports an unconfigured installation with the missing credential fields', async () => {
    const fixture = await createFixture()
    try {
      const config = resolveConfig({}, { defaultTokenDir: fixture.dir })
      const manager = new GitHubAppTokenManager(config, { now: () => NOW })
      await manager.initialize()
      const body = await bodyOf(manager, NOW)
      expect(body.status).toBe('unconfigured')
      expect(body.configured).toBe(false)
      expect(body.missing).toEqual(['appId', 'installationId', 'privateKeyPath'])
      expect(body.token_file).toBe(join(fixture.dir, 'github-app-token.json'))
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports an unreadable token file instead of failing the request', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.tokenPath, '{not json')
      const manager = await configuredManager(fixture, NOW)
      const body = await bodyOf(manager, NOW)
      expect(body.status).toBe('invalid')
      expect(typeof body.message).toBe('string')
      expect(body.message).not.toBe('')
    } finally {
      await fixture.cleanup()
    }
  })
})

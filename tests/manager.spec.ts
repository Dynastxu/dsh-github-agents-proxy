import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { formatDuration, GitHubAppTokenManager } from '../src/manager.ts'
import { FileTokenStore } from '../src/token-store.ts'
import { abortSignal, createFixture, jsonResponse, tokenDocument } from './helpers.ts'

const START = Date.parse('2026-11-10T12:00:00Z')

function clock(start = START): { now: number } {
  return { now: start }
}

describe('GitHubAppTokenManager', () => {
  it('formats remaining lifetimes compactly', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(112)).toBe('1m52s')
    expect(formatDuration(1682)).toBe('28m2s')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(3660)).toBe('1h1m')
  })

  it('freezes a snapshot until the token crosses a state boundary', async () => {
    const fixture = await createFixture()
    try {
      const time = clock()
      await new FileTokenStore(fixture.tokenPath).write(tokenDocument(1800, time.now))
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => time.now })
      await manager.initialize()
      const agent = {}

      const initial = manager.snapshotFor(agent)
      expect(initial).toContain('[github-app-token] status=valid')
      expect(initial).toContain('remaining=30m')
      expect(initial).not.toContain('WARN:')

      time.now += 10 * 60 * 1000
      expect(manager.snapshotFor(agent)).toBe(initial)

      time.now += 1000 * 1000
      const warning = manager.snapshotFor(agent)
      expect(warning).toContain('status=valid')
      expect(warning).toContain('remaining=3m20s')
      expect(warning).toContain('WARN: The github-app-token is about to expire.')

      time.now += 200 * 1000
      const expired = manager.snapshotFor(agent)
      expect(expired).toContain('status=expired')
      expect(expired).toContain('WARN: The github-app-token has expired.')
    } finally {
      await fixture.cleanup()
    }
  })

  it('refreshes when missing, declines a healthy token, and force-replaces it', async () => {
    const fixture = await createFixture()
    try {
      const time = clock()
      let calls = 0
      const fetchImpl = (async () => {
        calls += 1
        return jsonResponse({
          token: `ghs_${calls}`,
          expires_at: new Date(time.now + 3600_000).toISOString(),
        })
      }) as typeof fetch
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => time.now, fetch: fetchImpl })
      await manager.initialize()

      const first = await manager.refresh(false, abortSignal())
      expect(first).toMatchObject({ ok: true, refreshed: true, expires_in_seconds: 3600 })
      expect(calls).toBe(1)
      expect(manager.snapshotFor({})).toContain('status=valid')

      time.now += 60_000
      const second = await manager.refresh(false, abortSignal())
      expect(second).toMatchObject({ ok: false, reason: 'token_still_valid', expires_in_seconds: 3540 })
      expect(calls).toBe(1)

      const forced = await manager.refresh(true, abortSignal())
      expect(forced.ok).toBe(true)
      expect(calls).toBe(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it('serializes two concurrent refreshes to one GitHub exchange', async () => {
    const fixture = await createFixture()
    try {
      const time = clock()
      await new FileTokenStore(fixture.tokenPath).write(tokenDocument(100, time.now))
      let calls = 0
      const fetchImpl = (async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 40))
        return jsonResponse({
          token: 'ghs_shared',
          expires_at: new Date(time.now + 3600_000).toISOString(),
        })
      }) as typeof fetch
      const first = new GitHubAppTokenManager(fixture.config, { now: () => time.now, fetch: fetchImpl, lockPollMs: 5 })
      const second = new GitHubAppTokenManager(fixture.config, { now: () => time.now, fetch: fetchImpl, lockPollMs: 5 })

      const results = await Promise.all([
        first.refresh(false, abortSignal()),
        second.refresh(false, abortSignal()),
      ])
      expect(calls).toBe(1)
      expect(results.filter(result => result.ok)).toHaveLength(1)
      expect(results.filter(result => !result.ok && result.reason === 'token_still_valid')).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('installs a fresh token into gh and reports its outcome', async () => {
    const fixture = await createFixture({ configureGh: true })
    try {
      let ghCalls = 0
      const gh = async () => {
        ghCalls += 1
        return { configured: true }
      }
      const fetchImpl = (async () => jsonResponse({
        token: 'ghs_gh_auth',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })) as typeof fetch
      const manager = new GitHubAppTokenManager(fixture.config, { gh, fetch: fetchImpl })
      const first = await manager.refresh(false, abortSignal())
      expect(first).toMatchObject({ ok: true, gh_configured: true })
      expect(ghCalls).toBe(1)

      const second = await manager.refresh(false, abortSignal())
      expect(second).toMatchObject({ ok: false, reason: 'token_still_valid', gh_configured: true })
      expect(ghCalls).toBe(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports unconfigured without reading credentials or contacting GitHub', async () => {
    const fetchImpl = vi.fn()
    const config = resolveConfig({}, { env: {}, home: process.cwd(), cwd: process.cwd() })
    const manager = new GitHubAppTokenManager(config, { fetch: fetchImpl as unknown as typeof fetch })
    const result = await manager.refresh(false, abortSignal())
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(manager.snapshotFor({})).toContain('status=unconfigured')
  })

  it('turns an invalid private key into a structured failure', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.config.privateKeyPath!, 'not a private key', 'utf8')
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => START })
      const result = await manager.refresh(false, abortSignal())
      expect(result).toMatchObject({ ok: false, reason: 'refresh_failed' })
      if (!result.ok && result.reason === 'refresh_failed') {
        expect(result.message).toMatch(/RSA private key|PEM private key/)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  it('resolves the private key through a credential reference', async () => {
    const fixture = await createFixture()
    try {
      const config = resolveConfig({
        appId: '12345',
        installationId: '67890',
        privateKeyEnv: 'GITHUB_APP_PRIVATE_KEY',
        refreshThresholdSeconds: 300,
        configureGh: false,
      }, { defaultTokenDir: fixture.dir, env: {}, home: fixture.dir, cwd: fixture.dir })
      const resolve = vi.fn(async () => ({ value: fixture.privateKeyPem }))
      let calls = 0
      const fetchImpl = (async () => {
        calls += 1
        return jsonResponse({
          token: 'ghs_credential',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      }) as typeof fetch
      const manager = new GitHubAppTokenManager(config, { credentials: { resolve }, fetch: fetchImpl })
      const result = await manager.refresh(false, abortSignal())
      expect(result.ok).toBe(true)
      expect(resolve).toHaveBeenCalledWith('GITHUB_APP_PRIVATE_KEY')
      expect(calls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('reads status from disk and reports corruption without throwing', async () => {
    const fixture = await createFixture()
    try {
      const time = clock()
      const store = new FileTokenStore(fixture.tokenPath)
      await store.write(tokenDocument(1200, time.now))
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => time.now })
      expect(await manager.checkFromDisk()).toMatchObject({
        state: 'valid',
        configured: true,
        expiresInSeconds: 1200,
      })

      await writeFile(fixture.tokenPath, '{bad json', 'utf8')
      expect(await manager.checkFromDisk()).toMatchObject({ state: 'invalid', configured: true })
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports a token belonging to another installation as missing', async () => {
    const fixture = await createFixture()
    try {
      const time = clock()
      await new FileTokenStore(fixture.tokenPath).write({
        ...tokenDocument(3600, time.now),
        installation_id: '99999',
      })
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => time.now })
      await manager.initialize()
      expect(await manager.checkFromDisk()).toMatchObject({ state: 'missing' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('uses a supplied token path and reports missing state', async () => {
    const fixture = await createFixture({ tokenPath: join('tokens', 'custom.json') })
    try {
      const manager = new GitHubAppTokenManager(fixture.config, { now: () => START })
      await manager.initialize()
      expect(manager.snapshotFor({})).toContain('status=missing')
      expect(manager.config.tokenPath.endsWith(join('tokens', 'custom.json'))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })
})

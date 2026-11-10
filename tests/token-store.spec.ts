import { stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileTokenStore, parseStoredToken, TokenFileError, TokenLockTimeoutError } from '../src/token-store.ts'
import { createFixture, tokenDocument } from './helpers.ts'

describe('FileTokenStore', () => {
  it('round-trips a private token document', async () => {
    const fixture = await createFixture()
    try {
      const store = new FileTokenStore(fixture.tokenPath)
      expect(await store.read()).toBeUndefined()
      const token = tokenDocument(3600)
      await store.write(token)
      expect(await store.read()).toEqual(token)
      if (process.platform !== 'win32') {
        const info = await stat(fixture.tokenPath)
        expect(info.mode & 0o777).toBe(0o600)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports a malformed cached document as a token-file error', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.tokenPath, '{not json', 'utf8')
      const store = new FileTokenStore(fixture.tokenPath)
      await expect(store.read()).rejects.toBeInstanceOf(TokenFileError)
      expect(() => parseStoredToken({ version: 1, token: 'x', expires_at: 'not-a-date', app_id: '1', installation_id: '2' }))
        .toThrow(/expires_at/)
    } finally {
      await fixture.cleanup()
    }
  })

  it('creates the token directory before taking the lock', async () => {
    const fixture = await createFixture()
    try {
      const tokenPath = join(fixture.dir, 'nested', 'deep', 'token.json')
      const store = new FileTokenStore(tokenPath)
      await store.withLock(async () => {
        await store.write(tokenDocument(60))
      }, new AbortController().signal)
      expect(await store.read()).toMatchObject({ token: 'ghs_test_token' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('serializes writers through the lock', async () => {
    const fixture = await createFixture()
    try {
      const store = new FileTokenStore(fixture.tokenPath, { lockPollMs: 5 })
      const order: string[] = []
      await Promise.all([
        store.withLock(async () => {
          order.push('first:start')
          await new Promise(resolve => setTimeout(resolve, 30))
          order.push('first:end')
        }, new AbortController().signal),
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          await store.withLock(async () => {
            order.push('second:start')
          }, new AbortController().signal)
        })(),
      ])
      expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    } finally {
      await fixture.cleanup()
    }
  })

  it('reclaims an abandoned lock after its stale window', async () => {
    const fixture = await createFixture()
    try {
      const store = new FileTokenStore(fixture.tokenPath, { lockStaleMs: 10, lockTimeoutMs: 200, lockPollMs: 5 })
      await writeFile(store.lockPath, JSON.stringify({ owner: 'dead', pid: 1, acquired_at: '2020-01-01T00:00:00.000Z' }), 'utf8')
      const old = new Date(Date.now() - 60_000)
      await utimes(store.lockPath, old, old)
      let ran = false
      await store.withLock(async () => {
        ran = true
      }, new AbortController().signal)
      expect(ran).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it('times out behind a live lock and honors cancellation', async () => {
    const fixture = await createFixture()
    try {
      const store = new FileTokenStore(fixture.tokenPath, { lockTimeoutMs: 25, lockPollMs: 5 })
      await writeFile(store.lockPath, JSON.stringify({ owner: 'other', pid: 1, acquired_at: new Date().toISOString() }), 'utf8')
      await expect(store.withLock(async () => undefined, new AbortController().signal))
        .rejects.toBeInstanceOf(TokenLockTimeoutError)

      const controller = new AbortController()
      const waiting = store.withLock(async () => undefined, controller.signal)
      setTimeout(() => controller.abort(new Error('cancelled')), 5)
      await expect(waiting).rejects.toThrow('cancelled')
    } finally {
      await fixture.cleanup()
    }
  })
})

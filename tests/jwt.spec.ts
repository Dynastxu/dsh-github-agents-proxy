import { createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createFixture } from './helpers.ts'
import { createAppJwt, parsePrivateKey, PrivateKeyError } from '../src/jwt.ts'

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('GitHub App JWTs', () => {
  it('signs an RS256 JWT with the App ID and a bounded lifetime', async () => {
    const fixture = await createFixture()
    try {
      const now = Date.parse('2026-11-10T12:00:00Z')
      const jwt = createAppJwt('12345', parsePrivateKey(fixture.privateKeyPem), now)
      const [header, payload, signature] = jwt.split('.')
      expect(header).toBeDefined()
      expect(payload).toBeDefined()
      expect(signature).toBeDefined()
      expect(decodeSegment(header!)).toEqual({ alg: 'RS256', typ: 'JWT' })
      expect(decodeSegment(payload!)).toEqual({
        iat: now / 1000 - 60,
        exp: now / 1000 - 60 + 600,
        iss: '12345',
      })
      const verifier = createVerify('RSA-SHA256')
      verifier.update(`${header}.${payload}`)
      expect(verifier.verify(fixture.publicKeyPem, Buffer.from(signature!, 'base64url'))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects non-RSA and malformed private keys', () => {
    expect(() => parsePrivateKey('not a key')).toThrow(PrivateKeyError)
    expect(() => parsePrivateKey('')).toThrow(/empty/)
  })
})

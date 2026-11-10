/**
 * GitHub App JWT creation.
 *
 * GitHub authenticates App-level requests with a short-lived RS256 JWT. The
 * token endpoint exchanges that JWT for one installation access token.
 *
 * @module @dynastxu/dsh-github-agents-proxy/jwt
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'

/** JWT lifetime measured from its backdated `iat` claim. */
const JWT_LIFETIME_SECONDS = 600

/** Clock-skew allowance before `iat`; GitHub rejects tokens issued too far in the future. */
const JWT_CLOCK_SKEW_SECONDS = 60

/** A private key that cannot be used for GitHub App authentication. */
export class PrivateKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrivateKeyError'
  }
}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Parse and validate the RSA private key used to sign App JWTs.
 * @param pem - PEM text loaded from a private-key file or credential reference.
 * @returns the parsed RSA key.
 * @throws PrivateKeyError when the text is not a usable RSA private key.
 */
export function parsePrivateKey(pem: string): KeyObject {
  if (pem.trim().length === 0) throw new PrivateKeyError('GitHub App private key is empty')
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch {
    throw new PrivateKeyError('GitHub App private key is not a valid PEM private key')
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new PrivateKeyError('GitHub App private key must be an RSA private key')
  }
  return key
}

/**
 * Create one GitHub App JWT.
 * @param appId - GitHub App ID used as the `iss` claim.
 * @param privateKey - parsed RSA private key.
 * @param nowMs - current epoch milliseconds.
 * @returns the compact RS256 JWT.
 */
export function createAppJwt(appId: string, privateKey: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000)
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' })
  const payload = encodeJson({
    iat: now - JWT_CLOCK_SKEW_SECONDS,
    exp: now - JWT_CLOCK_SKEW_SECONDS + JWT_LIFETIME_SECONDS,
    iss: appId,
  })
  const signingInput = `${header}.${payload}`
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

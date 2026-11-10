import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, type ConfigValues, type ResolvedConfig } from '../src/config.ts'
import type { StoredToken } from '../src/types.ts'

export interface Fixture {
  readonly dir: string
  readonly privateKeyPem: string
  readonly publicKeyPem: string
  readonly config: ResolvedConfig
  readonly tokenPath: string
  cleanup(): Promise<void>
}

export async function createFixture(overrides: Partial<ConfigValues> = {}, defaultTokenDir?: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-app-token-'))
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPath = join(dir, 'github-app.pem')
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 })
  const config = resolveConfig({
    appId: '12345',
    installationId: '67890',
    privateKeyPath,
    refreshThresholdSeconds: 300,
    configureGh: false,
    ...overrides,
  }, {
    defaultTokenDir: defaultTokenDir ?? dir,
    env: {},
    home: dir,
    cwd: dir,
  })
  return {
    dir,
    privateKeyPem,
    publicKeyPem,
    config,
    tokenPath: config.tokenPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export function tokenDocument(expiresInSeconds: number, now = Date.now()): StoredToken {
  return {
    version: 1,
    token: 'ghs_test_token',
    expires_at: new Date(now + expiresInSeconds * 1000).toISOString(),
    app_id: '12345',
    installation_id: '67890',
  }
}

export function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function abortSignal(): AbortSignal {
  return new AbortController().signal
}

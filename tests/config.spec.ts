import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, ConfigurationError, readConfig, resolveConfig } from '../src/config.ts'

const ROOT = resolve('/tmp', 'dsh-config-test')
const PROFILE_DIR = join(ROOT, '.dsh', 'profiles', 'web')
const ENVIRONMENT = {
  env: {},
  home: ROOT,
  cwd: ROOT,
  defaultTokenDir: PROFILE_DIR,
}

describe('resolveConfig', () => {
  it('treats an entirely absent credential set as intentionally unconfigured', () => {
    const resolved = resolveConfig({}, ENVIRONMENT)
    expect(resolved.configured).toBe(false)
    expect(resolved.missing).toEqual(['appId', 'installationId', 'privateKeyPath'])
    expect(resolved.refreshThresholdSeconds).toBe(300)
    expect(resolved.contextInjection).toBe(true)
    expect(resolved.blockRawGitCommit).toBe(false)
    expect(resolved.tokenPath).toBe(join(PROFILE_DIR, 'github-app-token.json'))
  })

  it('rejects a partial credential set at load', () => {
    expect(() => resolveConfig({ appId: '1' }, ENVIRONMENT)).toThrow(ConfigurationError)
    expect(() => resolveConfig({ appId: '1' }, ENVIRONMENT)).toThrow(/installationId, privateKeyPath/)
  })

  it('accepts numeric strings and normalizes path fields', () => {
    const resolved = resolveConfig({
      appId: '42',
      installationId: '99',
      privateKeyPath: '~/keys/app.pem',
      tokenPath: 'tokens/app.json',
    }, ENVIRONMENT)
    expect(resolved).toMatchObject({
      configured: true,
      appId: '42',
      installationId: '99',
      privateKeyPath: join(ROOT, 'keys', 'app.pem'),
      tokenPath: resolve(ROOT, 'tokens', 'app.json'),
    })
  })

  it('rejects invalid IDs, thresholds, and flags', () => {
    expect(() => resolveConfig({ appId: 0, installationId: '1', privateKeyPath: 'k' }, ENVIRONMENT)).toThrow(/appId/)
    expect(() => resolveConfig({ appId: 'x', installationId: '1', privateKeyPath: 'k' }, ENVIRONMENT)).toThrow(/appId/)
    expect(() => resolveConfig({ appId: '1', installationId: '2', privateKeyPath: 'k', refreshThresholdSeconds: -1 }, ENVIRONMENT)).toThrow(/non-negative/)
    expect(() => resolveConfig({ appId: '1', installationId: '2', privateKeyPath: 'k', refreshThresholdSeconds: 1.5 }, ENVIRONMENT)).toThrow(/non-negative/)
    expect(() => resolveConfig({ appId: '1', installationId: '2', privateKeyPath: 'k', contextInjection: 'yes' as never }, ENVIRONMENT)).toThrow(/boolean/)
  })

  it('requires exactly one private-key source', () => {
    expect(() => resolveConfig({
      appId: '1',
      installationId: '2',
      privateKeyPath: 'k',
      privateKeyEnv: 'GITHUB_APP_KEY',
    }, ENVIRONMENT)).toThrow(/mutually exclusive/)
    expect(() => resolveConfig({
      appId: '1',
      installationId: '2',
      privateKeyEnv: 'not-a-ref',
    }, ENVIRONMENT)).toThrow(/privateKeyEnv/)
  })

  it('accepts a credential reference and a configurable API URL', () => {
    const resolved = resolveConfig({
      appId: '1',
      installationId: '2',
      privateKeyEnv: 'GITHUB_APP_KEY',
      apiBaseUrl: 'https://github.example/api/v3/',
    }, ENVIRONMENT)
    expect(resolved.privateKeyEnv).toBe('GITHUB_APP_KEY')
    expect(resolved.privateKeyPath).toBeUndefined()
    expect(resolved.apiBaseUrl).toBe('https://github.example/api/v3')
  })

  it('rejects an API URL carrying credentials or a query', () => {
    expect(() => resolveConfig({ apiBaseUrl: 'https://user:pass@example.test' }, ENVIRONMENT)).toThrow(/credentials/)
    expect(() => resolveConfig({ apiBaseUrl: 'https://example.test?x=1' }, ENVIRONMENT)).toThrow(/query/)
    expect(() => resolveConfig({ apiBaseUrl: 'ftp://example.test' }, ENVIRONMENT)).toThrow(/http/)
  })

  it('reads volatile Loader references into plain values', () => {
    const live = Config({
      appId: '7',
      installationId: 8,
      privateKeyEnv: 'GITHUB_APP_KEY',
      refreshThresholdSeconds: 45,
      contextInjection: false,
      blockRawGitCommit: true,
    })
    expect(readConfig(live)).toMatchObject({
      appId: '7',
      installationId: 8,
      privateKeyEnv: 'GITHUB_APP_KEY',
      refreshThresholdSeconds: 45,
      contextInjection: false,
      blockRawGitCommit: true,
      apiBaseUrl: 'https://api.github.com',
    })
  })

  it('honors DSH_HOME when no profile directory is supplied', () => {
    const resolved = resolveConfig({}, { env: { DSH_HOME: join(ROOT, 'srv', 'dsh') }, home: ROOT, cwd: ROOT })
    expect(resolved.tokenPath).toBe(join(ROOT, 'srv', 'dsh', 'github-app-token.json'))
  })
})

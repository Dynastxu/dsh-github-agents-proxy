import { describe, expect, it } from 'vitest'
import { draftFrom, EMPTY_DRAFT, validateDraft, type Draft } from '../src/client/draft.ts'

/** Translator stub that returns the copy key, so assertions name the failure message. */
const t = (key: string): string => key

/** A complete file-path configuration. */
const complete: Draft = {
  ...EMPTY_DRAFT,
  appId: '5678739',
  installationId: '180118664',
  keyValue: 'C:\\Users\\me\\github-app.pem',
}

describe('settings draft', () => {
  it('uses the unconfigured defaults when the Host has no values', () => {
    expect(draftFrom(undefined)).toEqual(EMPTY_DRAFT)
    expect(draftFrom(undefined)).not.toBe(EMPTY_DRAFT)
  })

  it('projects stored values into text, defaults, and the private-key source', () => {
    expect(draftFrom({
      appId: 5678739,
      installationId: '180118664',
      privateKeyPath: '/home/me/app.pem',
      refreshThresholdSeconds: 60,
      apiBaseUrl: 'https://github.example/api/v3',
      contextInjection: false,
      configureGh: false,
      blockRawGitCommit: true,
    })).toEqual({
      appId: '5678739',
      installationId: '180118664',
      keySource: 'path',
      keyValue: '/home/me/app.pem',
      tokenPath: '',
      threshold: '60',
      apiBaseUrl: 'https://github.example/api/v3',
      contextInjection: false,
      configureGh: false,
      blockRawGitCommit: true,
    })
  })

  it('prefers the credential reference as the private-key source when it is set', () => {
    const draft = draftFrom({
      appId: '1',
      installationId: '2',
      privateKeyPath: '/ignored.pem',
      privateKeyEnv: 'GITHUB_APP_PRIVATE_KEY',
    })
    expect(draft.keySource).toBe('ref')
    expect(draft.keyValue).toBe('GITHUB_APP_PRIVATE_KEY')
  })

  it('treats defaults as the unconfigured state', () => {
    expect(draftFrom({})).toEqual(EMPTY_DRAFT)
  })

  it('accepts an unconfigured page and a complete file-path configuration', () => {
    expect(validateDraft(EMPTY_DRAFT, t)).toBeUndefined()
    expect(validateDraft(complete, t)).toBeUndefined()
  })

  it('accepts a complete credential-reference configuration', () => {
    expect(validateDraft({ ...complete, keySource: 'ref', keyValue: 'GITHUB_APP_PRIVATE_KEY' }, t)).toBeUndefined()
  })

  it('requires the three credential fields together', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, appId: '1' }, t)).toBe('invalidIds')
    expect(validateDraft({ ...EMPTY_DRAFT, appId: '1', installationId: '2' }, t)).toBe('invalidKey')
    expect(validateDraft({ ...EMPTY_DRAFT, keyValue: '/key.pem' }, t)).toBe('invalidIds')
  })

  it('rejects non-positive identifiers', () => {
    for (const appId of ['0', '-1', '01', 'abc', '1.5', ' 1 2']) {
      expect(validateDraft({ ...complete, appId }, t)).toBe('invalidIds')
    }
  })

  it('rejects an invalid credential reference', () => {
    expect(validateDraft({ ...complete, keySource: 'ref', keyValue: '9-lives' }, t)).toBe('invalidKey')
    expect(validateDraft({ ...complete, keySource: 'ref', keyValue: '' }, t)).toBe('invalidKey')
  })

  it('rejects a negative or fractional refresh threshold', () => {
    for (const threshold of ['-1', '1.5', 'x', '']) {
      expect(validateDraft({ ...complete, threshold }, t)).toBe('invalidThreshold')
    }
  })

  it('accepts an empty API base URL but rejects malformed or decorated URLs', () => {
    expect(validateDraft({ ...complete, apiBaseUrl: '  ' }, t)).toBeUndefined()
    for (const apiBaseUrl of ['not a url', 'ftp://github.com', 'https://user:secret@github.com', 'https://github.com/?q=1', 'https://github.com/#x']) {
      expect(validateDraft({ ...complete, apiBaseUrl }, t)).toBe('invalidUrl')
    }
  })

  it('trims supplied text before validating it', () => {
    expect(validateDraft({
      ...complete,
      appId: ' 5678739 ',
      installationId: ' 180118664 ',
      keyValue: '  C:\\key.pem  ',
      apiBaseUrl: ' https://api.github.com ',
    }, t)).toBeUndefined()
  })
})

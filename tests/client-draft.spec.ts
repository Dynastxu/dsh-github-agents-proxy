import { describe, expect, it } from 'vitest'
import {
  credentialsComplete, credentialsEntered, draftFrom, draftWrites, EMPTY_DRAFT, validateDraft, type Draft,
} from '../src/client/draft.ts'

/** Translator stub that returns the copy key, so assertions name the failure message. */
const t = (key: string): string => key

/** A complete file-path configuration. */
const complete: Draft = {
  ...EMPTY_DRAFT,
  appId: '5678739',
  installationId: '180118664',
  keyValue: 'C:\\Users\\me\\github-app.pem',
}

/** Stored values matching {@link complete}. */
const stored = {
  appId: '5678739',
  installationId: '180118664',
  privateKeyPath: 'C:\\Users\\me\\github-app.pem',
  refreshThresholdSeconds: 300,
} as const

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

  it('accepts a partial credential set while the operator is still typing', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, appId: '1' }, t)).toBeUndefined()
    expect(validateDraft({ ...EMPTY_DRAFT, appId: '1', installationId: '2' }, t)).toBeUndefined()
    expect(validateDraft({ ...EMPTY_DRAFT, keyValue: '/key.pem' }, t)).toBeUndefined()
  })

  it('accepts a complete credential-reference configuration', () => {
    expect(validateDraft({ ...complete, keySource: 'ref', keyValue: 'GITHUB_APP_PRIVATE_KEY' }, t)).toBeUndefined()
  })

  it('rejects non-positive identifiers', () => {
    for (const appId of ['0', '-1', '01', 'abc', '1.5', ' 1 2']) {
      expect(validateDraft({ ...complete, appId }, t)).toBe('invalidIds')
    }
  })

  it('rejects an invalid credential reference', () => {
    expect(validateDraft({ ...complete, keySource: 'ref', keyValue: '9-lives' }, t)).toBe('invalidKey')
  })

  it('rejects a negative or fractional refresh threshold', () => {
    for (const threshold of ['-1', '1.5', 'x']) {
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

  it('reports which credential fields are entered', () => {
    expect(credentialsEntered(EMPTY_DRAFT)).toBe(false)
    expect(credentialsEntered({ ...EMPTY_DRAFT, installationId: '2' })).toBe(true)
    expect(credentialsComplete(complete)).toBe(true)
    expect(credentialsComplete({ ...complete, keyValue: '' })).toBe(false)
  })
})

describe('settings draft writes', () => {
  it('writes nothing when the draft matches the stored values', () => {
    expect(draftWrites(draftFrom(stored), stored)).toEqual([])
    expect(draftWrites({ ...EMPTY_DRAFT }, undefined)).toEqual([])
  })

  it('writes only the changed credential field of a complete group', () => {
    expect(draftWrites({ ...complete, appId: '42' }, stored)).toEqual([
      { op: 'set', path: ['appId'], value: '42' },
    ])
  })

  it('keeps a partial credential group out of the mutation', () => {
    expect(draftWrites({ ...EMPTY_DRAFT, appId: '5678739' }, undefined)).toEqual([])
    expect(draftWrites({ ...complete, installationId: '' }, stored)).toEqual([])
  })

  it('clears the credential fields when the group is emptied', () => {
    expect(draftWrites({ ...EMPTY_DRAFT }, stored)).toEqual([
      { op: 'unset', path: ['appId'] },
      { op: 'unset', path: ['installationId'] },
      { op: 'unset', path: ['privateKeyPath'] },
    ])
  })

  it('switches the private-key source with one unset and one set', () => {
    expect(draftWrites({ ...complete, keySource: 'ref', keyValue: 'GITHUB_APP_PRIVATE_KEY' }, stored)).toEqual([
      { op: 'unset', path: ['privateKeyPath'] },
      { op: 'set', path: ['privateKeyEnv'], value: 'GITHUB_APP_PRIVATE_KEY' },
    ])
  })

  it('writes and clears the optional fields', () => {
    expect(draftWrites({ ...complete, tokenPath: 'token.json', threshold: '60', apiBaseUrl: 'https://github.example/api/v3' }, stored)).toEqual([
      { op: 'set', path: ['tokenPath'], value: 'token.json' },
      { op: 'set', path: ['refreshThresholdSeconds'], value: 60 },
      { op: 'set', path: ['apiBaseUrl'], value: 'https://github.example/api/v3' },
    ])
    expect(draftWrites({ ...complete, tokenPath: '', threshold: '', apiBaseUrl: '' }, {
      ...stored,
      tokenPath: 'token.json',
      refreshThresholdSeconds: 60,
      apiBaseUrl: 'https://github.example/api/v3',
    })).toEqual([
      { op: 'unset', path: ['tokenPath'] },
      { op: 'unset', path: ['refreshThresholdSeconds'] },
      { op: 'unset', path: ['apiBaseUrl'] },
    ])
  })

  it('treats the default refresh threshold as unchanged', () => {
    const ops = draftWrites({ ...complete, threshold: '300' }, undefined)
    expect(ops.some(op => op.path[0] === 'refreshThresholdSeconds')).toBe(false)
  })

  it('writes changed switches only', () => {
    expect(draftWrites({ ...complete, contextInjection: false, blockRawGitCommit: true }, stored)).toEqual([
      { op: 'set', path: ['contextInjection'], value: false },
      { op: 'set', path: ['blockRawGitCommit'], value: true },
    ])
    expect(draftWrites({ ...complete, configureGh: false }, { ...stored, configureGh: false })).toEqual([])
  })
})

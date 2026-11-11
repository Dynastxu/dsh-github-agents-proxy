/**
 * Settings-page draft values and validation.
 *
 * The page edits plain text locally and writes the snapshot back through
 * `ctx.configForms`; keeping the conversion here lets the page render without
 * owning the configuration format.
 *
 * @module @dynastxu/dsh-github-agents-proxy/client/draft
 */

import type { Translate } from './locales.ts'

/** Plain values projected by the Host form. */
export interface GithubAppSettings {
  readonly appId?: string | number
  readonly installationId?: string | number
  readonly privateKeyPath?: string
  readonly privateKeyEnv?: string
  readonly tokenPath?: string
  readonly refreshThresholdSeconds?: number
  readonly apiBaseUrl?: string
  readonly contextInjection?: boolean
  readonly configureGh?: boolean
  readonly blockRawGitCommit?: boolean
}

/** Editable text and toggle state of the settings page. */
export interface Draft {
  appId: string
  installationId: string
  keySource: 'path' | 'ref'
  keyValue: string
  tokenPath: string
  threshold: string
  apiBaseUrl: string
  contextInjection: boolean
  configureGh: boolean
  blockRawGitCommit: boolean
}

/** State of a page that has no stored configuration. */
export const EMPTY_DRAFT: Draft = {
  appId: '',
  installationId: '',
  keySource: 'path',
  keyValue: '',
  tokenPath: '',
  threshold: '300',
  apiBaseUrl: '',
  contextInjection: true,
  configureGh: true,
  blockRawGitCommit: false,
}

/**
 * Project stored configuration into editable text and toggles.
 * @param value - plain values from the Host form; undefined while unset.
 * @returns a detached draft.
 */
export function draftFrom(value: GithubAppSettings | undefined): Draft {
  if (value === undefined) return { ...EMPTY_DRAFT }
  const useRef = typeof value.privateKeyEnv === 'string' && value.privateKeyEnv !== ''
  return {
    appId: value.appId === undefined ? '' : String(value.appId),
    installationId: value.installationId === undefined ? '' : String(value.installationId),
    keySource: useRef ? 'ref' : 'path',
    keyValue: useRef ? value.privateKeyEnv ?? '' : value.privateKeyPath ?? '',
    tokenPath: value.tokenPath ?? '',
    threshold: String(value.refreshThresholdSeconds ?? 300),
    apiBaseUrl: value.apiBaseUrl ?? '',
    contextInjection: value.contextInjection !== false,
    configureGh: value.configureGh !== false,
    blockRawGitCommit: value.blockRawGitCommit === true,
  }
}

/**
 * Check a positive-integer identifier as the Host accepts it.
 * @param value - trimmed identifier text.
 * @returns whether the text is a positive integer.
 */
function validId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value)
}

/**
 * Check an API base URL, allowing the empty value that selects the default.
 * @param value - trimmed URL text.
 * @returns whether the text is empty or an http(s) URL without credentials, query, or fragment.
 */
function validHttpUrl(value: string): boolean {
  if (value === '') return true
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

/**
 * Find the first invalid draft value.
 * @param draft - current page state.
 * @param t - settings-page translator.
 * @returns the localized problem, or undefined when every supplied value is acceptable.
 */
export function validateDraft(draft: Draft, t: Translate): string | undefined {
  const appId = draft.appId.trim()
  const installationId = draft.installationId.trim()
  const keyValue = draft.keyValue.trim()
  if (appId === '' && installationId === '' && keyValue === '') return undefined
  if (!validId(appId) || !validId(installationId)) return t('invalidIds')
  if (keyValue === '') return t('invalidKey')
  if (draft.keySource === 'ref' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyValue)) return t('invalidKey')
  if (!/^(0|[1-9][0-9]*)$/.test(draft.threshold.trim())) return t('invalidThreshold')
  if (!validHttpUrl(draft.apiBaseUrl.trim())) return t('invalidUrl')
  return undefined
}

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

/** One atomic namespace operation accepted by `ctx.configForms`. */
export type ConfigPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: string | number | boolean }
  | { readonly op: 'unset'; readonly path: readonly string[] }

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
 *
 * Empty credential fields are valid here: a partially filled credential set is
 * saved only once complete, so the page can autosave the rest of the form
 * while the operator is still typing.
 * @param draft - current page state.
 * @param t - settings-page translator.
 * @returns the localized problem, or undefined when every supplied value is acceptable.
 */
export function validateDraft(draft: Draft, t: Translate): string | undefined {
  const appId = draft.appId.trim()
  const installationId = draft.installationId.trim()
  const keyValue = draft.keyValue.trim()
  if (appId !== '' && !validId(appId)) return t('invalidIds')
  if (installationId !== '' && !validId(installationId)) return t('invalidIds')
  if (draft.keySource === 'ref' && keyValue !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyValue)) return t('invalidKey')
  const threshold = draft.threshold.trim()
  if (threshold !== '' && !/^(0|[1-9][0-9]*)$/.test(threshold)) return t('invalidThreshold')
  if (!validHttpUrl(draft.apiBaseUrl.trim())) return t('invalidUrl')
  return undefined
}

/**
 * Whether the operator supplied any credential field.
 * @param draft - current page state.
 * @returns whether an App ID, Installation ID, or private-key value is present.
 */
export function credentialsEntered(draft: Draft): boolean {
  return draft.appId.trim() !== '' || draft.installationId.trim() !== '' || draft.keyValue.trim() !== ''
}

/**
 * Whether all three credential fields are present.
 * @param draft - current page state.
 * @returns whether App ID, Installation ID, and private-key value are all present.
 */
export function credentialsComplete(draft: Draft): boolean {
  return draft.appId.trim() !== '' && draft.installationId.trim() !== '' && draft.keyValue.trim() !== ''
}

/**
 * Turn the draft into the atomic mutation that persists every changed field.
 *
 * The credential group is written only while it is complete or empty: the Host
 * rejects a partial credential set at load, so intermediate typing must not
 * reach the profile. Other fields are written independently.
 * @param draft - current page state.
 * @param value - stored configuration the draft was derived from.
 * @returns operations for one namespace mutation; empty when nothing changed.
 */
export function draftWrites(draft: Draft, value: GithubAppSettings | undefined): ConfigPathOp[] {
  const current = value ?? {}
  const ops: ConfigPathOp[] = []
  const setText = (field: string, next: string, previous: string): void => {
    if (next === previous) return
    if (next === '') ops.push({ op: 'unset', path: [field] })
    else ops.push({ op: 'set', path: [field], value: next })
  }
  const currentText = (field: string | number | undefined): string =>
    field === undefined ? '' : String(field).trim()

  if (credentialsComplete(draft) || !credentialsEntered(draft)) {
    setText('appId', draft.appId.trim(), currentText(current.appId))
    setText('installationId', draft.installationId.trim(), currentText(current.installationId))
    const keyValue = draft.keyValue.trim()
    setText('privateKeyPath', draft.keySource === 'path' ? keyValue : '', currentText(current.privateKeyPath))
    setText('privateKeyEnv', draft.keySource === 'ref' ? keyValue : '', currentText(current.privateKeyEnv))
  }

  setText('tokenPath', draft.tokenPath.trim(), currentText(current.tokenPath))
  const threshold = draft.threshold.trim()
  if (threshold === '') {
    if (current.refreshThresholdSeconds !== undefined) ops.push({ op: 'unset', path: ['refreshThresholdSeconds'] })
  } else if (Number(threshold) !== (current.refreshThresholdSeconds ?? 300)) {
    ops.push({ op: 'set', path: ['refreshThresholdSeconds'], value: Number(threshold) })
  }
  setText('apiBaseUrl', draft.apiBaseUrl.trim(), currentText(current.apiBaseUrl))

  const setBoolean = (field: string, next: boolean, previous: boolean): void => {
    if (next !== previous) ops.push({ op: 'set', path: [field], value: next })
  }
  setBoolean('contextInjection', draft.contextInjection, current.contextInjection !== false)
  setBoolean('configureGh', draft.configureGh, current.configureGh !== false)
  setBoolean('blockRawGitCommit', draft.blockRawGitCommit, current.blockRawGitCommit === true)
  return ops
}

/**
 * Browser half: the GitHub App token settings page.
 *
 * Values live in the active profile's volatile Config fields and are read and
 * written through `ctx.configForms`, so `cordis.patch.yml`, the settings page,
 * and the running Host share one source of truth.
 *
 * @module @dynastxu/dsh-github-agents-proxy/client
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { en, NS, zh, type CopyKey, type Translate } from './locales.ts'
import { CSS, STYLE_MARKER } from './styles.ts'

/** Plain values projected by the Host form. */
interface GithubAppSettings {
  readonly appId?: string | number
  readonly installationId?: string | number
  readonly privateKeyPath?: string
  readonly privateKeyEnv?: string
  readonly tokenPath?: string
  readonly refreshThresholdSeconds?: number
  readonly apiBaseUrl?: string
  readonly contextInjection?: boolean
  readonly configureGh?: boolean
}

interface ConfigFormSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
  readonly writable: boolean
  readonly revision: number | undefined
}

interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

interface ConfigFormsService {
  get<T>(namespace: string): ConfigForm<T>
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<CopyKey, string>; en: Record<CopyKey, string> }): () => void
  bind(namespace: string): Translate
}

interface SlotsService {
  inject(name: string, register: () => () => void): () => void
  register(definition: {
    readonly name: 'settings.section'
    readonly id: string
    readonly order: number
    readonly label: () => string
    readonly locale: string
    readonly inject: () => { readonly form: ConfigForm<GithubAppSettings> }
  }, component: (props: SettingsSectionProps) => ReactNode): () => void
}

interface SettingsSectionProps {
  readonly t: Translate
  readonly form: ConfigForm<GithubAppSettings>
}

interface Draft {
  appId: string
  installationId: string
  keySource: 'path' | 'ref'
  keyValue: string
  tokenPath: string
  threshold: string
  apiBaseUrl: string
  contextInjection: boolean
  configureGh: boolean
}

const EMPTY_DRAFT: Draft = {
  appId: '',
  installationId: '',
  keySource: 'path',
  keyValue: '',
  tokenPath: '',
  threshold: '300',
  apiBaseUrl: '',
  contextInjection: true,
  configureGh: true,
}

function draftFrom(value: GithubAppSettings | undefined): Draft {
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
  }
}

function validId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value.trim())
}

function validHttpUrl(value: string): boolean {
  if (value.trim() === '') return true
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

function validate(draft: Draft, t: Translate): string | undefined {
  const appId = draft.appId.trim()
  const installationId = draft.installationId.trim()
  const keyValue = draft.keyValue.trim()
  if (appId === '' && installationId === '' && keyValue === '') return undefined
  if (!validId(appId) || !validId(installationId)) return t('invalidIds')
  if (keyValue === '') return t('invalidKey')
  if (draft.keySource === 'ref' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyValue)) return t('invalidKey')
  if (!/^(0|[1-9][0-9]*)$/.test(draft.threshold.trim())) return t('invalidThreshold')
  if (!validHttpUrl(draft.apiBaseUrl)) return t('invalidUrl')
  return undefined
}

/** Set or clear one form field. */
async function write(form: ConfigForm<GithubAppSettings>, field: string, value: unknown): Promise<boolean> {
  if (value === undefined || value === '') return form.unset(field)
  return form.set(field, value)
}

function SettingsSection({ t, form }: SettingsSectionProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const [draft, setDraft] = useState<Draft>(() => draftFrom(snapshot.value))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!dirty) setDraft(draftFrom(snapshot.value))
  }, [snapshot.value, dirty])

  const editable = snapshot.status === 'ready' && snapshot.writable && !busy
  const update = (patch: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setDirty(true)
    setMessage(null)
  }

  const save = async (): Promise<void> => {
    const problem = validate(draft, t)
    if (problem !== undefined) {
      setMessage({ kind: 'error', text: problem })
      return
    }
    setBusy(true)
    setMessage(null)
    const appId = draft.appId.trim()
    const installationId = draft.installationId.trim()
    const keyValue = draft.keyValue.trim()
    const threshold = Number(draft.threshold.trim())
    const unconfigured = appId === '' && installationId === '' && keyValue === ''
    try {
      const writes: Promise<boolean>[] = [
        write(form, 'appId', unconfigured ? undefined : appId),
        write(form, 'installationId', unconfigured ? undefined : installationId),
        write(form, 'privateKeyPath', unconfigured || draft.keySource !== 'path' ? undefined : keyValue),
        write(form, 'privateKeyEnv', unconfigured || draft.keySource !== 'ref' ? undefined : keyValue),
        write(form, 'tokenPath', draft.tokenPath.trim() === '' ? undefined : draft.tokenPath.trim()),
        write(form, 'refreshThresholdSeconds', threshold),
        write(form, 'apiBaseUrl', draft.apiBaseUrl.trim() === '' ? undefined : draft.apiBaseUrl.trim()),
        write(form, 'contextInjection', draft.contextInjection),
        write(form, 'configureGh', draft.configureGh),
      ]
      let accepted = true
      for (const operation of writes) {
        if (!(await operation)) accepted = false
      }
      if (!accepted) {
        setMessage({ kind: 'error', text: t('saveFailed') })
        return
      }
      setDirty(false)
      setMessage({ kind: 'ok', text: t('saved') })
    } catch {
      setMessage({ kind: 'error', text: t('saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const fields = ['appId', 'installationId', 'privateKeyPath', 'privateKeyEnv', 'tokenPath', 'refreshThresholdSeconds', 'apiBaseUrl', 'contextInjection', 'configureGh']
      let accepted = true
      for (const field of fields) {
        if (!(await form.unset(field))) accepted = false
      }
      if (!accepted) {
        setMessage({ kind: 'error', text: t('saveFailed') })
        return
      }
      setDraft({ ...EMPTY_DRAFT })
      setDirty(false)
      setMessage({ kind: 'ok', text: t('cleared') })
    } catch {
      setMessage({ kind: 'error', text: t('saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  if (snapshot.status === 'loading') return <p className="ghapp-loading">{t('loading')}</p>
  if (snapshot.status === 'unavailable') return <p className="ghapp-status ghapp-status-error">{t('unavailable')}</p>

  return (
    <div className="ghapp-settings">
      <div>
        <h2 className="ghapp-heading">{t('title')}</h2>
        <p className="ghapp-intro">{t('intro')}</p>
      </div>
      {!snapshot.writable ? <p className="ghapp-status ghapp-status-error">{t('readonly')}</p> : null}
      <div className="ghapp-grid">
        <label className="ghapp-field">
          <span className="ghapp-label">{t('appId')}</span>
          <input className="ghapp-input" inputMode="numeric" value={draft.appId} disabled={!editable} onChange={event => update({ appId: event.currentTarget.value })} />
          <span className="ghapp-hint">{t('appIdHint')}</span>
        </label>
        <label className="ghapp-field">
          <span className="ghapp-label">{t('installationId')}</span>
          <input className="ghapp-input" inputMode="numeric" value={draft.installationId} disabled={!editable} onChange={event => update({ installationId: event.currentTarget.value })} />
          <span className="ghapp-hint">{t('installationIdHint')}</span>
        </label>
        <label className="ghapp-field">
          <span className="ghapp-label">{t('keySource')}</span>
          <select className="ghapp-select" value={draft.keySource} disabled={!editable} onChange={event => update({ keySource: event.currentTarget.value === 'ref' ? 'ref' : 'path' })}>
            <option value="path">{t('keyPath')}</option>
            <option value="ref">{t('keyRef')}</option>
          </select>
        </label>
        <label className="ghapp-field">
          <span className="ghapp-label">{t('keyValue')}</span>
          <input className="ghapp-input" value={draft.keyValue} disabled={!editable} onChange={event => update({ keyValue: event.currentTarget.value })} />
          <span className="ghapp-hint">{draft.keySource === 'path' ? t('keyValueHintPath') : t('keyValueHintRef')}</span>
        </label>
        <label className="ghapp-field ghapp-field-wide ghapp-check">
          <input type="checkbox" checked={draft.contextInjection} disabled={!editable} onChange={event => update({ contextInjection: event.currentTarget.checked })} />
          <span>
            <span className="ghapp-label">{t('contextInjection')}</span>
            <span className="ghapp-hint"> {t('contextInjectionHint')}</span>
          </span>
        </label>
        <label className="ghapp-field ghapp-field-wide ghapp-check">
          <input type="checkbox" checked={draft.configureGh} disabled={!editable} onChange={event => update({ configureGh: event.currentTarget.checked })} />
          <span>
            <span className="ghapp-label">{t('configureGh')}</span>
            <span className="ghapp-hint"> {t('configureGhHint')}</span>
          </span>
        </label>
      </div>
      <details className="ghapp-details">
        <summary>{t('advanced')}</summary>
        <div className="ghapp-grid">
          <label className="ghapp-field ghapp-field-wide">
            <span className="ghapp-label">{t('tokenPath')}</span>
            <input className="ghapp-input" value={draft.tokenPath} disabled={!editable} placeholder="github-app-token.json" onChange={event => update({ tokenPath: event.currentTarget.value })} />
            <span className="ghapp-hint">{t('tokenPathHint')}</span>
          </label>
          <label className="ghapp-field">
            <span className="ghapp-label">{t('threshold')}</span>
            <input className="ghapp-input" inputMode="numeric" value={draft.threshold} disabled={!editable} onChange={event => update({ threshold: event.currentTarget.value })} />
            <span className="ghapp-hint">{t('thresholdHint')}</span>
          </label>
          <label className="ghapp-field">
            <span className="ghapp-label">{t('apiBaseUrl')}</span>
            <input className="ghapp-input" value={draft.apiBaseUrl} disabled={!editable} placeholder="https://api.github.com" onChange={event => update({ apiBaseUrl: event.currentTarget.value })} />
            <span className="ghapp-hint">{t('apiBaseUrlHint')}</span>
          </label>
        </div>
      </details>
      <p className="ghapp-note">{t('note')} {t('privateKeyNote')}</p>
      <div className="ghapp-actions">
        <button className="ghapp-button ghapp-button-primary" type="button" disabled={!editable} onClick={() => { void save() }}>
          {busy ? t('saving') : t('save')}
        </button>
        <button className="ghapp-button" type="button" disabled={!editable} onClick={() => { void clear() }}>{t('clear')}</button>
        {message !== null ? <span className={`ghapp-status ${message.kind === 'ok' ? 'ghapp-status-ok' : 'ghapp-status-error'}`}>{message.text}</span> : null}
      </div>
    </div>
  )
}

/** Required browser services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the dictionaries, stylesheet, and settings page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  const locale = ctx.get('locale') as LocaleService | undefined
  const configForms = ctx.get('configForms') as ConfigFormsService | undefined
  if (slots === undefined || locale === undefined || configForms === undefined) return

  ctx.effect(() => locale.register(NS, { zh, en }), 'github-agents-proxy: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = STYLE_MARKER
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'github-agents-proxy: settings styles')
  const t = locale.bind(NS)
  const form = configForms.get<GithubAppSettings>(NS)
  ctx.effect(() => configForms.whileServed([NS], () => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'github-agents-proxy',
    order: 120,
    label: () => t('title'),
    locale: NS,
    inject: () => ({ form }),
  }, SettingsSection))), 'github-agents-proxy: settings page')
}

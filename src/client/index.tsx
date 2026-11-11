/**
 * Browser half: the GitHub App token settings page.
 *
 * Values live in the active profile's volatile Config fields and are read and
 * written through `ctx.configForms`, so `cordis.patch.yml`, the settings page,
 * and the running Host share one source of truth. Edits are written as one
 * atomic mutation after a short pause; there is no Save button.
 *
 * @module @dynastxu/dsh-github-agents-proxy/client
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  credentialsComplete, credentialsEntered, draftFrom, draftWrites, EMPTY_DRAFT, validateDraft,
  type ConfigPathOp, type Draft, type GithubAppSettings,
} from './draft.ts'
import { readHostPathBridge, type HostPathBridge } from './file-picker.ts'
import { en, NS, zh, type CopyKey, type Translate } from './locales.ts'
import { describeTokenStatus, useTokenStatus, type TokenStatus } from './status.ts'
import { CSS, STYLE_MARKER } from './styles.ts'

/** Pause after the last edit before the draft is written. */
const AUTOSAVE_DELAY_MS = 500

/** How long a successful save notice stays beside the reset button. */
const SAVED_NOTICE_MS = 2000

/** Every editable namespace field, cleared by the reset action. */
const CONFIG_FIELDS = [
  'appId', 'installationId', 'privateKeyPath', 'privateKeyEnv', 'tokenPath',
  'refreshThresholdSeconds', 'apiBaseUrl', 'contextInjection', 'configureGh', 'blockRawGitCommit',
] as const

interface ConfigFormSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
  readonly writable: boolean
  readonly revision: number | undefined
}

interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigPathOp[]): Promise<boolean>
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

/** GitHub mark used as the default App avatar. */
function GitHubMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** Local live token state below the page title. */
function TokenStatusLine({ status, t }: { readonly status: TokenStatus; readonly t: Translate }): ReactNode {
  const presentation = describeTokenStatus(status, t)
  return (
    <span
      className="ghapp-token-status"
      data-tone={presentation.tone}
      title={presentation.detail === '' ? undefined : presentation.detail}
    >
      <span className="ghapp-status-dot" aria-hidden="true" />
      {presentation.text}
    </span>
  )
}

/** Folder glyph of the PEM file chooser. */
function FolderIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
    </svg>
  )
}

/** Label, hint, and the control they describe on one settings row. */
function FieldRow({ label, hint, note, children }: {
  readonly label: string
  readonly hint: string
  readonly note?: string | undefined
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="ghapp-row">
      <div className="ghapp-row-text">
        <span className="ghapp-row-title">{label}</span>
        <span className="ghapp-row-desc">{hint}</span>
        {note === undefined ? null : <span className="ghapp-row-note">{note}</span>}
      </div>
      <div className="ghapp-row-control">{children}</div>
    </div>
  )
}

/** A labeled two-state toggle. */
function SwitchRow({ label, hint, checked, disabled, onChange }: {
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}): ReactNode {
  return (
    <div className="ghapp-row">
      <div className="ghapp-row-text">
        <span className="ghapp-row-title">{label}</span>
        <span className="ghapp-row-desc">{hint}</span>
      </div>
      <div className="ghapp-row-control ghapp-row-control-end">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          className="ghapp-switch"
          onClick={() => { onChange(!checked) }}
        >
          <span className="ghapp-switch-thumb" />
        </button>
      </div>
    </div>
  )
}

/** Select control with the settings chevron drawn over a native `<select>`. */
function SelectControl({ label, value, disabled, onChange, children }: {
  readonly label: string
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <span className="ghapp-select-wrap">
      <select
        className="ghapp-select"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={event => { onChange(event.currentTarget.value) }}
      >
        {children}
      </select>
      <svg className="ghapp-select-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6l4 4 4-4" />
      </svg>
    </span>
  )
}

function SettingsSection({ t, form }: SettingsSectionProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const [draft, setDraft] = useState<Draft>(() => draftFrom(snapshot.value))
  const [edited, setEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [statusRevision, setStatusRevision] = useState(0)
  const status = useTokenStatus(statusRevision)
  /** Counts local edits so an in-flight save cannot discard a newer draft. */
  const editVersion = useRef(0)
  const [pathBridge] = useState<HostPathBridge | undefined>(() => readHostPathBridge())
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!edited) setDraft(draftFrom(snapshot.value))
  }, [snapshot.value, edited])

  useEffect(() => {
    if (message === null || message.kind !== 'ok') return
    const timer = setTimeout(() => { setMessage(null) }, SAVED_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [message])

  const editable = snapshot.status === 'ready' && snapshot.writable
  const partialCredentials = credentialsEntered(draft) && !credentialsComplete(draft)
  const update = (patch: Partial<Draft>): void => {
    editVersion.current += 1
    setDraft(current => ({ ...current, ...patch }))
    setEdited(true)
    setMessage(null)
  }

  /** Adopt the absolute path of a PEM chosen in the native file dialog. */
  const chooseKeyFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (file === undefined || pathBridge === undefined) return
    const path = pathBridge.pathFor(file)
    if (path !== '') update({ keyValue: path })
  }

  /** Persist every changed field of one draft in a single namespace mutation. */
  const commit = async (next: Draft): Promise<void> => {
    const version = editVersion.current
    const problem = validateDraft(next, t)
    if (problem !== undefined) {
      setMessage({ kind: 'error', text: problem })
      return
    }
    const completeCredentials = credentialsComplete(next) || !credentialsEntered(next)
    const ops = draftWrites(next, form.getSnapshot().value)
    if (ops.length === 0) {
      if (completeCredentials && editVersion.current === version) setEdited(false)
      return
    }
    setSaving(true)
    try {
      if (!(await form.mutate(ops))) {
        setMessage({ kind: 'error', text: t('saveFailed') })
        return
      }
      if (completeCredentials && editVersion.current === version) {
        setEdited(false)
        setMessage({ kind: 'ok', text: t('saved') })
      }
      setStatusRevision(current => current + 1)
    } catch {
      setMessage({ kind: 'error', text: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!edited || !editable) return
    const timer = setTimeout(() => { void commit(draft) }, AUTOSAVE_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [draft, edited, editable])

  const reset = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      const accepted = await form.mutate(CONFIG_FIELDS.map(field => ({ op: 'unset', path: [field] })))
      if (!accepted) {
        setMessage({ kind: 'error', text: t('saveFailed') })
        return
      }
      editVersion.current += 1
      setDraft({ ...EMPTY_DRAFT })
      setEdited(false)
      setMessage({ kind: 'ok', text: t('resetDone') })
      setStatusRevision(current => current + 1)
    } catch {
      setMessage({ kind: 'error', text: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') return <p className="ghapp-loading">{t('loading')}</p>
  if (snapshot.status === 'unavailable') return <p className="ghapp-status ghapp-status-error">{t('unavailable')}</p>

  return (
    <div className="ghapp-settings">
      <div className="ghapp-card ghapp-identity">
        <span className="ghapp-avatar" aria-hidden="true"><GitHubMark /></span>
        <div className="ghapp-identity-copy">
          <span className="ghapp-name">{t('title')}</span>
          <TokenStatusLine status={status} t={t} />
        </div>
        <div className="ghapp-identity-actions">
          {message === null ? null : (
            <span role="status" className={`ghapp-status ${message.kind === 'ok' ? 'ghapp-status-ok' : 'ghapp-status-error'}`}>
              {message.text}
            </span>
          )}
          <button className="ghapp-button" type="button" disabled={!editable || saving}
            title={t('resetHint')} onClick={() => { void reset() }}>{t('reset')}</button>
        </div>
      </div>
      {!snapshot.writable ? <p className="ghapp-status ghapp-status-error">{t('readonly')}</p> : null}
      <div className="ghapp-card ghapp-rows">
        <FieldRow label={t('appId')} hint={t('appIdHint')}>
          <input className="ghapp-input" inputMode="numeric" aria-label={t('appId')}
            value={draft.appId} disabled={!editable} onChange={event => update({ appId: event.currentTarget.value })} />
        </FieldRow>
        <FieldRow label={t('installationId')} hint={t('installationIdHint')}>
          <input className="ghapp-input" inputMode="numeric" aria-label={t('installationId')}
            value={draft.installationId} disabled={!editable} onChange={event => update({ installationId: event.currentTarget.value })} />
        </FieldRow>
        <FieldRow label={t('keySource')} hint={t('keySourceHint')}>
          <SelectControl label={t('keySource')} value={draft.keySource} disabled={!editable}
            onChange={value => update({ keySource: value === 'ref' ? 'ref' : 'path' })}>
            <option value="path">{t('keyPath')}</option>
            <option value="ref">{t('keyRef')}</option>
          </SelectControl>
        </FieldRow>
        <FieldRow label={t('keyValue')}
          hint={draft.keySource === 'ref'
            ? t('keyValueHintRef')
            : pathBridge === undefined ? t('keyValueHintPath') : t('keyValueHintPick')}
          note={partialCredentials ? t('keyPartialHint') : undefined}>
          <div className="ghapp-file-control">
            {pathBridge === undefined || draft.keySource === 'ref' ? null : (
              <>
                <button type="button" className="ghapp-icon-button" aria-label={t('chooseKeyFile')}
                  title={t('chooseKeyFile')} disabled={!editable}
                  onClick={() => { fileInput.current?.click() }}>
                  <FolderIcon />
                </button>
                <input ref={fileInput} type="file" accept=".pem" hidden onChange={chooseKeyFile} />
              </>
            )}
            <input className="ghapp-input" aria-label={t('keyValue')} title={draft.keyValue}
              value={draft.keyValue} disabled={!editable} onChange={event => update({ keyValue: event.currentTarget.value })} />
          </div>
        </FieldRow>
        <SwitchRow label={t('contextInjection')} hint={t('contextInjectionHint')}
          checked={draft.contextInjection} disabled={!editable}
          onChange={next => update({ contextInjection: next })} />
        <SwitchRow label={t('configureGh')} hint={t('configureGhHint')}
          checked={draft.configureGh} disabled={!editable}
          onChange={next => update({ configureGh: next })} />
        <SwitchRow label={t('blockRawGitCommit')} hint={t('blockRawGitCommitHint')}
          checked={draft.blockRawGitCommit} disabled={!editable}
          onChange={next => update({ blockRawGitCommit: next })} />
      </div>
      <div className="ghapp-card">
        <h3 className="ghapp-card-title">{t('advanced')}</h3>
        <div className="ghapp-rows">
          <FieldRow label={t('tokenPath')} hint={t('tokenPathHint')}>
            <input className="ghapp-input" aria-label={t('tokenPath')} placeholder="github-app-token.json"
              value={draft.tokenPath} disabled={!editable} onChange={event => update({ tokenPath: event.currentTarget.value })} />
          </FieldRow>
          <FieldRow label={t('threshold')} hint={t('thresholdHint')}>
            <input className="ghapp-input" inputMode="numeric" aria-label={t('threshold')}
              value={draft.threshold} disabled={!editable} onChange={event => update({ threshold: event.currentTarget.value })} />
          </FieldRow>
          <FieldRow label={t('apiBaseUrl')} hint={t('apiBaseUrlHint')}>
            <input className="ghapp-input" aria-label={t('apiBaseUrl')} placeholder="https://api.github.com"
              value={draft.apiBaseUrl} disabled={!editable} onChange={event => update({ apiBaseUrl: event.currentTarget.value })} />
          </FieldRow>
        </div>
      </div>
      <p className="ghapp-note">{t('note')} {t('privateKeyNote')}</p>
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

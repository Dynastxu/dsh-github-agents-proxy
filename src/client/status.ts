/**
 * Live token status for the settings page.
 *
 * The page asks the Host for the cached token's state while it is mounted,
 * keeps the last good answer across a transient failure, and ticks a local
 * countdown between answers. Polling is page-scoped: the Host still owns no
 * timer and no background refresh.
 *
 * @module @dynastxu/dsh-github-agents-proxy/client/status
 */

import { useEffect, useState } from 'react'
import { formatDuration } from '../duration.ts'
import { TOKEN_STATUS_ROUTE, type TokenStatusResponse } from '../status-contract.ts'
import type { TokenState } from '../types.ts'
import type { Translate } from './locales.ts'

/** How often the open page re-reads the Host's status. */
export const STATUS_POLL_MS = 15_000

/** Extra read after a configuration save, so the rebuilt manager is observed. */
export const STATUS_SETTLE_MS = 800

/** Countdown refresh. */
const COUNTDOWN_TICK_MS = 1_000

/** Badge tone for one presentation. */
export type StatusTone = 'active' | 'warning' | 'error' | 'idle'

/** Localized badge content. */
export interface StatusPresentation {
  readonly tone: StatusTone
  readonly text: string
  /** Tooltip lines, empty when there is nothing to add. */
  readonly detail: string
}

/** The poll phases plus the last good answer. */
export interface TokenStatus {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly report?: TokenStatusResponse
  /** Host clock minus browser clock at the answer instant, in milliseconds. */
  readonly offsetMs: number
  /** Browser clock at the latest countdown tick. */
  readonly nowMs: number
}

const TOKEN_STATES: readonly TokenState[] = ['valid', 'expiring', 'expired', 'missing', 'unconfigured', 'invalid']

/**
 * Check a decoded response body before the page trusts any field.
 * @param value - parsed JSON of an unknown route body.
 * @returns whether the body is a well-formed status answer.
 */
function isStatusBody(value: unknown): value is TokenStatusResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.status === 'string'
    && (TOKEN_STATES as readonly string[]).includes(record.status)
    && typeof record.configured === 'boolean'
    && typeof record.token_file === 'string'
    && typeof record.server_time === 'string'
    && Number.isFinite(Date.parse(record.server_time))
    && (record.app_avatar_url === undefined || typeof record.app_avatar_url === 'string')
    && (record.app_name === undefined || typeof record.app_name === 'string')
}

/**
 * Read the Host's current status once.
 * @param signal - cancellation for this request.
 * @returns the validated status body.
 * @throws when the route is absent, the response is not OK, or the body is malformed.
 */
async function readStatus(signal: AbortSignal): Promise<TokenStatusResponse> {
  const response = await fetch(TOKEN_STATUS_ROUTE, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
  const body: unknown = await response.json()
  if (!isStatusBody(body)) throw new Error('malformed status body')
  return body
}

/**
 * Poll the Host's token status while the calling component is mounted.
 *
 * A failed poll keeps the last good answer; a page that never received one
 * reports the status as unavailable.
 * @param revision - bump to re-read immediately, for example after a save.
 * @returns the poll phase, last answer, and the current countdown instant.
 */
export function useTokenStatus(revision: number): TokenStatus {
  const [phase, setPhase] = useState<TokenStatus['phase']>('loading')
  const [report, setReport] = useState<TokenStatusResponse | undefined>(undefined)
  const [offsetMs, setOffsetMs] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const load = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') return
      try {
        const next = await readStatus(controller.signal)
        if (cancelled) return
        setReport(next)
        setOffsetMs(Date.parse(next.server_time) - Date.now())
        setPhase('ready')
      } catch {
        // A transient failure or an uncomposed Host half: keep the last answer
        // and only mark the page unavailable when nothing was ever read.
        if (cancelled || controller.signal.aborted) return
        setPhase(current => current === 'ready' ? current : 'error')
      }
    }
    void load()
    const settle = setTimeout(() => { void load() }, STATUS_SETTLE_MS)
    const poll = setInterval(() => { void load() }, STATUS_POLL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(settle)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [revision])

  useEffect(() => {
    const ticker = setInterval(() => { setNowMs(Date.now()) }, COUNTDOWN_TICK_MS)
    return () => { clearInterval(ticker) }
  }, [])

  return {
    phase,
    ...(report === undefined ? {} : { report }),
    offsetMs,
    nowMs,
  }
}

/**
 * Seconds left at the countdown instant, measured on the Host clock.
 * @param report - status answer with a possible expiry.
 * @param clock - countdown instant and Host-minus-browser clock offset.
 * @returns whole seconds until expiry, or undefined without a usable expiry.
 */
export function remainingSeconds(
  report: TokenStatusResponse,
  clock: { readonly nowMs: number; readonly offsetMs: number },
): number | undefined {
  if (report.expires_at === undefined) return undefined
  const expiresAtMs = Date.parse(report.expires_at)
  if (!Number.isFinite(expiresAtMs)) return undefined
  return Math.max(0, Math.floor((expiresAtMs - (clock.nowMs + clock.offsetMs)) / 1000))
}

function fill(template: string, value: string): string {
  return template.split('{0}').join(value)
}

/**
 * Settings-page title: the App name the Host resolved, or the generic label
 * while no name is available.
 *
 * The generic label covers both a pending lookup and a failed one, so the
 * header never shows an invented name.
 * @param status - polled status, including any reported App name.
 * @param fallback - localized generic label.
 * @returns the title text to show beside the token status.
 */
export function settingsTitle(status: TokenStatus, fallback: string): string {
  const name = status.report?.app_name
  return name === undefined || name === '' ? fallback : name
}

function instantLabel(iso: string): string {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : iso
}

function detailOf(report: TokenStatusResponse, t: Translate): string {
  const lines: string[] = []
  if (report.expires_at !== undefined) lines.push(fill(t('statusExpiresAt'), instantLabel(report.expires_at)))
  lines.push(fill(t('statusTokenFile'), report.token_file))
  if (report.missing !== undefined && report.missing.length > 0) {
    lines.push(fill(t('statusMissingFields'), report.missing.join(', ')))
  }
  return lines.join('\n')
}

/**
 * Describe one status answer as badge copy.
 * @param status - polled status, including the countdown instant.
 * @param t - settings-page translator.
 * @returns the tone, localized text, and tooltip detail.
 */
export function describeTokenStatus(status: TokenStatus, t: Translate): StatusPresentation {
  const report = status.report
  if (report === undefined) {
    return status.phase === 'error'
      ? { tone: 'idle', text: t('statusUnavailable'), detail: '' }
      : { tone: 'idle', text: t('statusChecking'), detail: '' }
  }
  const detail = detailOf(report, t)
  const seconds = remainingSeconds(report, status)
  const countdown = seconds === undefined ? undefined : formatDuration(seconds)
  switch (report.status) {
    case 'valid':
      if (seconds === 0) return { tone: 'error', text: t('statusExpired'), detail }
      return {
        tone: 'active',
        text: countdown === undefined ? t('statusActive') : fill(t('statusActiveRemaining'), countdown),
        detail,
      }
    case 'expiring':
      if (seconds === 0) return { tone: 'error', text: t('statusExpired'), detail }
      return {
        tone: 'warning',
        text: countdown === undefined ? t('statusExpiring') : fill(t('statusExpiringRemaining'), countdown),
        detail,
      }
    case 'expired':
      return { tone: 'error', text: t('statusExpired'), detail }
    case 'invalid':
      return { tone: 'error', text: t('statusInvalid'), detail: report.message ?? detail }
    case 'missing':
      return { tone: 'idle', text: t('statusMissing'), detail }
    case 'unconfigured':
      return { tone: 'idle', text: t('statusUnconfigured'), detail }
  }
}

import { describe, expect, it } from 'vitest'
import { zh, type Translate } from '../src/client/locales.ts'
import { describeTokenStatus, remainingSeconds, type TokenStatus } from '../src/client/status.ts'
import type { TokenStatusResponse } from '../src/status-contract.ts'

const t: Translate = key => zh[key]

const REPORT: TokenStatusResponse = {
  status: 'valid',
  configured: true,
  needs_refresh: false,
  token_file: '/home/me/.dsh/profiles/desktop/github-app-token.json',
  threshold_seconds: 300,
  server_time: '2026-11-11T00:00:00.000Z',
}

/** One status answer measured at a browser clock of `nowMs` with no clock skew. */
function view(report: TokenStatusResponse, nowMs = Date.parse(report.server_time)): TokenStatus {
  return { phase: 'ready', report, offsetMs: Date.parse(report.server_time) - nowMs, nowMs }
}

function reportOf(overrides: Partial<TokenStatusResponse>): TokenStatusResponse {
  return { ...REPORT, ...overrides }
}

describe('live token status presentation', () => {
  it('shows a checking badge until the first answer arrives', () => {
    expect(describeTokenStatus({ phase: 'loading', offsetMs: 0, nowMs: 0 }, t)).toEqual({
      tone: 'idle',
      text: zh.statusChecking,
      detail: '',
    })
  })

  it('reports the status as unavailable when the Host never answers', () => {
    expect(describeTokenStatus({ phase: 'error', offsetMs: 0, nowMs: 0 }, t)).toEqual({
      tone: 'idle',
      text: zh.statusUnavailable,
      detail: '',
    })
  })

  it('counts down a healthy token', () => {
    const now = Date.parse(REPORT.server_time)
    const report = reportOf({ expires_at: new Date(now + 1_800_000).toISOString(), expires_in_seconds: 1800 })
    const presentation = describeTokenStatus(view(report), t)
    expect(presentation.tone).toBe('active')
    expect(presentation.text).toBe('已激活 · 剩余 30m')
    expect(presentation.detail).toContain('有效期至')
    expect(presentation.detail).toContain(report.token_file)
  })

  it('warns while the token is inside the refresh threshold', () => {
    const now = Date.parse(REPORT.server_time)
    const report = reportOf({ status: 'expiring', needs_refresh: true, expires_at: new Date(now + 120_000).toISOString() })
    const presentation = describeTokenStatus(view(report), t)
    expect(presentation.tone).toBe('warning')
    expect(presentation.text).toBe('即将过期 · 剩余 2m')
  })

  it('turns expired when the local countdown reaches zero', () => {
    const now = Date.parse(REPORT.server_time)
    const report = reportOf({ expires_at: new Date(now + 30_000).toISOString() })
    const status: TokenStatus = { phase: 'ready', report, offsetMs: 0, nowMs: now + 30_000 }
    const presentation = describeTokenStatus(status, t)
    expect(presentation.tone).toBe('error')
    expect(presentation.text).toBe(zh.statusExpired)
  })

  it('counts down against the Host clock, not the browser clock', () => {
    const now = Date.parse(REPORT.server_time)
    const skewed = now + 120_000
    const report = reportOf({
      server_time: new Date(skewed).toISOString(),
      expires_at: new Date(skewed + 600_000).toISOString(),
    })
    const status: TokenStatus = { phase: 'ready', report, offsetMs: skewed - now, nowMs: now }
    expect(remainingSeconds(report, status)).toBe(600)
    expect(describeTokenStatus(status, t).text).toBe('已激活 · 剩余 10m')
  })

  it('reports a missing token as not activated', () => {
    const presentation = describeTokenStatus(view(reportOf({ status: 'missing' })), t)
    expect(presentation.tone).toBe('idle')
    expect(presentation.text).toBe('未激活')
  })

  it('reports an unconfigured installation without counting down', () => {
    const report = reportOf({ status: 'unconfigured', configured: false, missing: ['appId', 'installationId'] })
    const presentation = describeTokenStatus(view(report), t)
    expect(presentation.tone).toBe('idle')
    expect(presentation.text).toBe('未配置')
    expect(presentation.detail).toContain('缺少配置：appId, installationId')
  })

  it('reports an unreadable token file with its reason', () => {
    const report = reportOf({ status: 'invalid', message: 'cached token has an invalid expires_at' })
    const presentation = describeTokenStatus(view(report), t)
    expect(presentation.tone).toBe('error')
    expect(presentation.text).toBe('令牌不可读')
    expect(presentation.detail).toBe('cached token has an invalid expires_at')
  })
})

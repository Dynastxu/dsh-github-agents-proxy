import { describe, expect, it, vi } from 'vitest'
import { exchangeInstallationToken } from '../src/github.ts'
import { jsonResponse } from './helpers.ts'

const BASE_REQUEST = {
  apiBaseUrl: 'https://api.github.test',
  appId: '12345',
  installationId: '67890',
  jwt: 'signed.jwt.value',
  signal: new AbortController().signal,
}

describe('exchangeInstallationToken', () => {
  it('posts the JWT to the installation endpoint and returns the token document', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      token: 'ghs_installation_token',
      expires_at: '2026-11-10T23:05:00Z',
    }))
    const token = await exchangeInstallationToken({
      ...BASE_REQUEST,
      fetch: fetchMock as typeof fetch,
    })
    expect(token).toEqual({
      version: 1,
      token: 'ghs_installation_token',
      expires_at: '2026-11-10T23:05:00Z',
      app_id: '12345',
      installation_id: '67890',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.test/app/installations/67890/access_tokens')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer signed.jwt.value')
  })

  it('surfaces the GitHub error message without exposing the JWT', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      message: 'Bad credentials',
      documentation_url: 'https://docs.github.com/rest',
    }, 401))
    await expect(exchangeInstallationToken({
      ...BASE_REQUEST,
      fetch: fetchMock as typeof fetch,
    })).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 401,
      message: 'GitHub API 401: Bad credentials',
    })
  })

  it('rejects a response that omits expires_at', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ token: 'ghs_x' }))
    await expect(exchangeInstallationToken({
      ...BASE_REQUEST,
      fetch: fetchMock as typeof fetch,
    })).rejects.toThrow(/expires_at/)
  })

  it('rejects a non-JSON success body', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('not json', { status: 201 }))
    await expect(exchangeInstallationToken({
      ...BASE_REQUEST,
      fetch: fetchMock as typeof fetch,
    })).rejects.toThrow(/non-JSON/)
  })
})

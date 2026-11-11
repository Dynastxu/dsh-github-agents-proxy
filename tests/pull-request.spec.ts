import { describe, expect, it, vi } from 'vitest'
import type { SubprocessLike } from '../src/git.ts'
import {
  createPullRequest,
  createPullRequestTool,
  parseRepository,
  parseRepositoryFromRemote,
  type PullRequestRuntime,
} from '../src/pull-request.ts'
import { abortSignal, jsonResponse } from './helpers.ts'

const API = 'https://api.github.test'

interface GitResponses {
  readonly remote?: string
  readonly branch?: string
}

function fakeSubprocess(responses: GitResponses): SubprocessLike {
  return {
    resolveExecutable: async () => 'git',
    spawn(spec) {
      const args = spec.argv.slice(1)
      let stdout = ''
      let exitCode = 0
      if (args[0] === 'config') {
        if (responses.remote === undefined) exitCode = 1
        else stdout = `${responses.remote}\n`
      }
      if (args[0] === 'rev-parse') {
        if (responses.branch === undefined) exitCode = 1
        else stdout = `${responses.branch}\n`
      }
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: exitCode === 0 ? '' : 'no such remote' }) },
        },
      }
    },
  }
}

function runtime(options: {
  readonly git?: GitResponses | undefined
  readonly fetch?: typeof fetch
  readonly access?: PullRequestRuntime['accessToken']
} = {}): PullRequestRuntime {
  const access = options.access === undefined
    ? async () => ({ ok: true as const, token: 'ghs_installation', expires_at: '2026-11-11T18:00:00Z', refreshed: false })
    : options.access
  return {
    accessToken: access,
    apiBaseUrl: () => API,
    subprocess: () => (options.git === undefined ? undefined : fakeSubprocess(options.git)),
    workingDirectory: () => ({ ensure: async () => '/repo' }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
}

const PULL_REQUEST = {
  number: 12,
  title: 'Test: pull request tool',
  html_url: 'https://github.com/Dynastxu/Test-Repo/pull/12',
  draft: false,
  user: { login: 'dsh-agents[bot]' },
  head: { ref: 'feat/pr-tool' },
  base: { ref: 'main' },
}

describe('create_pull_request tool', () => {
  it('creates a pull request from the origin remote and checked-out branch', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === `${API}/repos/Dynastxu/Test-Repo` && init?.method === 'GET') {
        return jsonResponse({ default_branch: 'main' })
      }
      if (url === `${API}/repos/Dynastxu/Test-Repo/pulls` && init?.method === 'POST') {
        return jsonResponse(PULL_REQUEST)
      }
      return new Response('unexpected request', { status: 500 })
    }) as typeof fetch
    const tool = createPullRequestTool(runtime({
      git: { remote: 'https://github.com/Dynastxu/Test-Repo.git', branch: 'feat/pr-tool' },
      fetch: fetchImpl,
    }))
    const result = await tool.execute(
      { title: 'Test: pull request tool', body: 'Created by the PR tool.', draft: false },
      { signal: abortSignal(), agent: {} },
    )
    expect(result).toEqual({
      ok: true,
      number: 12,
      title: 'Test: pull request tool',
      url: 'https://github.com/Dynastxu/Test-Repo/pull/12',
      repository: 'Dynastxu/Test-Repo',
      head: 'feat/pr-tool',
      base: 'main',
      draft: false,
      created: true,
      author: 'dsh-agents[bot]',
    })
    expect(requests.map(request => `${request.init?.method ?? 'GET'} ${request.url}`)).toEqual([
      `GET ${API}/repos/Dynastxu/Test-Repo`,
      `POST ${API}/repos/Dynastxu/Test-Repo/pulls`,
    ])
    const post = requests[1]!
    expect(post.init?.body).toBe(JSON.stringify({
      title: 'Test: pull request tool',
      head: 'feat/pr-tool',
      base: 'main',
      body: 'Created by the PR tool.',
      draft: false,
    }))
    expect((post.init?.headers as Record<string, string>).authorization).toBe('Bearer ghs_installation')
  })

  it('uses explicit repo, head, and base without reading git', async () => {
    const requests: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return jsonResponse(PULL_REQUEST)
    }) as typeof fetch
    const tool = createPullRequestTool(runtime({ fetch: fetchImpl }))
    const result = await tool.execute(
      { title: 'Test: explicit arguments', repo: 'Dynastxu/Test-Repo', head: 'feat/pr-tool', base: 'main', draft: true },
      { signal: abortSignal() },
    )
    expect(result).toMatchObject({ ok: true, number: 12, created: true })
    expect(requests).toEqual([`POST ${API}/repos/Dynastxu/Test-Repo/pulls`])
  })

  it('returns the open pull request instead of failing when one already exists', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        return jsonResponse({
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for Dynastxu:feat/pr-tool.' }],
        }, 422)
      }
      if (url.includes('/pulls?state=open&head=Dynastxu%3Afeat%2Fpr-tool')) {
        return jsonResponse([PULL_REQUEST], 200)
      }
      return new Response('unexpected request', { status: 500 })
    }) as typeof fetch
    const tool = createPullRequestTool(runtime({ fetch: fetchImpl }))
    const result = await tool.execute(
      { title: 'Test: duplicate', repo: 'Dynastxu/Test-Repo', head: 'feat/pr-tool', base: 'main' },
      { signal: abortSignal() },
    )
    expect(result).toMatchObject({
      ok: true,
      number: 12,
      created: false,
      url: 'https://github.com/Dynastxu/Test-Repo/pull/12',
    })
    const rendered = tool.output.render({ title: 'Test: duplicate' }, result)
    expect(rendered[0]?.text).toContain('Found the open pull request #12')
  })

  it('adds a push hint when the head branch is not on the remote', async () => {
    const fetchImpl = (async () => jsonResponse({
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and feat/pr-tool' }],
    }, 422)) as typeof fetch
    const tool = createPullRequestTool(runtime({ fetch: fetchImpl }))
    const result = await tool.execute(
      { title: 'Test: missing branch', repo: 'Dynastxu/Test-Repo', head: 'feat/pr-tool', base: 'main' },
      { signal: abortSignal() },
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('No commits between main and feat/pr-tool')
    expect(result.hint).toContain('Push the head branch')
  })

  it('reports a missing token as a structured failure', async () => {
    const tool = createPullRequestTool(runtime({
      access: async () => ({
        ok: false,
        message: 'GitHub App credentials are not configured; missing appId',
        hint: 'Configure appId, installationId, and privateKeyPath or privateKeyEnv for the github-agents-proxy plugin.',
      }),
    }))
    const result = await tool.execute(
      { title: 'Test: no token', repo: 'Dynastxu/Test-Repo', head: 'feat/pr-tool', base: 'main' },
      { signal: abortSignal() },
    )
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('missing appId') })
    const rendered = tool.output.render({ title: 'Test: no token' }, result)
    expect(rendered[0]?.text).toContain('Pull request failed:')
  })

  it('requires an explicit repository when the origin remote is not resolvable', async () => {
    const tool = createPullRequestTool(runtime({ git: {} }))
    const result = await tool.execute({ title: 'Test: no remote' }, { signal: abortSignal(), agent: {} })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected a failure')
    expect(result.hint).toBe('Pass repo=owner/name explicitly.')
  })

  it('rejects a detached HEAD without a head branch', async () => {
    const tool = createPullRequestTool(runtime({
      git: { remote: 'git@github.com:Dynastxu/Test-Repo.git', branch: 'HEAD' },
    }))
    const result = await tool.execute({ title: 'Test: detached' }, { signal: abortSignal(), agent: {} })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('cannot determine the head branch')
    expect(result.hint).toContain('detached HEAD')
  })

  it('rejects an empty title', async () => {
    const tool = createPullRequestTool(runtime())
    expect(await tool.execute({ title: '   ' }, { signal: abortSignal() })).toEqual({
      ok: false,
      message: 'pull request title must not be empty',
    })
  })

  it('declares the schema providers accept', () => {
    const tool = createPullRequestTool(runtime())
    expect(tool.name).toBe('create_pull_request')
    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false, required: ['title'] })
    expect(tool.output.schema).toMatchObject({ required: ['ok'] })
  })
})

describe('repository references', () => {
  it('parses owner/name references', () => {
    expect(parseRepository(' Dynastxu/Test-Repo ')).toEqual({ owner: 'Dynastxu', name: 'Test-Repo' })
    expect(parseRepository('Dynastxu')).toBeUndefined()
    expect(parseRepository('a/b/c')).toBeUndefined()
    expect(parseRepository('owner/na me')).toBeUndefined()
  })

  it('parses https, ssh, scp-like, and Enterprise remotes', () => {
    expect(parseRepositoryFromRemote('https://github.com/Dynastxu/Test-Repo.git')).toEqual({ owner: 'Dynastxu', name: 'Test-Repo' })
    expect(parseRepositoryFromRemote('git@github.com:Dynastxu/Test-Repo.git')).toEqual({ owner: 'Dynastxu', name: 'Test-Repo' })
    expect(parseRepositoryFromRemote('ssh://git@ghe.example.com:22/team/repo.git')).toEqual({ owner: 'team', name: 'repo' })
    expect(parseRepositoryFromRemote('git://github.com/Dynastxu/Test-Repo')).toEqual({ owner: 'Dynastxu', name: 'Test-Repo' })
    expect(parseRepositoryFromRemote('https://github.com/Dynastxu/Test-Repo.git/')).toEqual({ owner: 'Dynastxu', name: 'Test-Repo' })
    expect(parseRepositoryFromRemote('')).toBeUndefined()
    expect(parseRepositoryFromRemote('not-a-url')).toBeUndefined()
  })
})

describe('createPullRequest', () => {
  it('reports an unexpected response body as a failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 'twelve' })) as unknown as typeof fetch
    const result = await createPullRequest({
      apiBaseUrl: API,
      token: 'ghs_installation',
      repository: { owner: 'Dynastxu', name: 'Test-Repo' },
      title: 'Test: unexpected body',
      head: 'feat/pr-tool',
      base: 'main',
      signal: abortSignal(),
      fetch: fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, message: 'GitHub returned an unexpected pull-request response' })
  })
})

/**
 * Dedicated pull-request tool for Agent changes.
 *
 * The pull request is created with the App installation token, so GitHub
 * attributes it to the App's bot account instead of the machine's user. The
 * tool never pushes or commits: the head branch must already exist on the
 * remote. Repeating a call for the same head branch returns the open pull
 * request instead of failing, so a retried tool call converges.
 *
 * @module @dynastxu/dsh-github-agents-proxy/pull-request
 */

import { failureText, resolveWorkspaceCwd, runGit, type GitRuntime } from './git.ts'
import { GitHubApiError, githubRest, type GitHubRestRequest } from './github.ts'
import type { ToolDefinition } from './tools.ts'
import type { TokenAccess } from './types.ts'

/** A GitHub repository identified by owner and name. */
export interface RepositoryRef {
  /** Account or organization owning the repository. */
  readonly owner: string
  /** Repository name, without a `.git` suffix. */
  readonly name: string
}

/** Arguments accepted by `create_pull_request`. */
export interface PullRequestArgs {
  /** Pull-request title. */
  readonly title: string
  /** Pull-request description in Markdown. */
  readonly body?: string
  /** Branch to merge into; defaults to the repository default branch. */
  readonly base?: string
  /** Branch containing the changes; defaults to the checked-out branch. */
  readonly head?: string
  /** Open the pull request as a draft. */
  readonly draft?: boolean
  /** Repository as `owner/name`; defaults to the `origin` remote of the working directory. */
  readonly repo?: string
}

/** Successful pull-request outcome. */
export interface PullRequestSuccess {
  readonly ok: true
  /** Pull-request number in the repository. */
  readonly number: number
  /** Title GitHub stored for the pull request. */
  readonly title: string
  /** Web URL of the pull request. */
  readonly url: string
  /** Repository as `owner/name`. */
  readonly repository: string
  /** Head branch the pull request merges from. */
  readonly head: string
  /** Base branch the pull request merges into. */
  readonly base: string
  /** Whether GitHub reports the pull request as a draft. */
  readonly draft: boolean
  /** Whether this call created the pull request; false when an open one already matched. */
  readonly created: boolean
  /** Login of the account GitHub attributed the pull request to. */
  readonly author?: string
}

/** Failed pull-request outcome. */
export interface PullRequestFailure {
  readonly ok: false
  /** Bounded reason, including the GitHub error message when there is one. */
  readonly message: string
  /** Actionable next step, when the failure has one. */
  readonly hint?: string
}

/** Canonical result of `create_pull_request`. */
export type PullRequestResult = PullRequestSuccess | PullRequestFailure

/** Inputs for one pull-request creation through the REST API. */
export interface CreatePullRequestRequest {
  /** GitHub API base URL for the active installation. */
  readonly apiBaseUrl: string
  /** Installation access token; never logged or returned. */
  readonly token: string
  /** Repository receiving the pull request. */
  readonly repository: RepositoryRef
  /** Pull-request title. */
  readonly title: string
  /** Pull-request description in Markdown. */
  readonly body?: string
  /** Head branch, already pushed to the repository. */
  readonly head: string
  /** Base branch; the repository default branch is read when this is absent. */
  readonly base?: string
  /** Open as a draft. */
  readonly draft?: boolean
  /** Caller cancellation. */
  readonly signal: AbortSignal
  /** Fetch implementation; defaults to the process global. */
  readonly fetch?: typeof fetch
  /** Request deadline in milliseconds; defaults to 15 seconds. */
  readonly timeoutMs?: number
}

/** Runtime dependencies behind the pull-request tool. */
export interface PullRequestRuntime extends GitRuntime {
  /** Usable installation token, refreshed when the cached one cannot be used. */
  accessToken(signal: AbortSignal): Promise<TokenAccess>
  /** GitHub API base URL for the active installation. */
  apiBaseUrl(): string
  /** Fetch implementation used by tests; defaults to the process global. */
  readonly fetch?: typeof fetch
}

const TIMEOUT_MS = 60_000
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse an `owner/name` repository reference.
 * @param value - candidate reference, with or without surrounding spaces.
 * @returns the parsed repository, or undefined when it is not `owner/name`.
 */
export function parseRepository(value: string): RepositoryRef | undefined {
  const segments = value.trim().split('/')
  if (segments.length !== 2) return undefined
  const owner = segments[0]
  const name = segments[1]
  if (owner === undefined || name === undefined) return undefined
  if (!REPOSITORY_SEGMENT.test(owner) || !REPOSITORY_SEGMENT.test(name)) return undefined
  return { owner, name }
}

/**
 * Parse a git remote URL into its repository.
 *
 * HTTPS, `ssh://`, `git://`, and scp-like `git@host:owner/name` forms resolve to
 * the last two path segments, so a GitHub Enterprise host needs no allowlist.
 * @param remote - `git remote get-url` output.
 * @returns the parsed repository, or undefined when the URL has no owner/name pair.
 */
export function parseRepositoryFromRemote(remote: string): RepositoryRef | undefined {
  const trimmed = remote.trim()
  if (trimmed === '') return undefined
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname
    } catch {
      return undefined
    }
  } else {
    const colon = trimmed.indexOf(':')
    path = colon === -1 ? trimmed : trimmed.slice(colon + 1)
  }
  const segments = path.split('/').filter(segment => segment.length > 0)
  if (segments.length < 2) return undefined
  const name = segments[segments.length - 1]!.replace(/\.git$/i, '')
  const owner = segments[segments.length - 2]!
  return parseRepository(`${owner}/${name}`)
}

function pullRequestResult(body: unknown, created: boolean, repository: RepositoryRef): PullRequestResult | undefined {
  if (!isRecord(body)) return undefined
  const number = body.number
  const url = body.html_url
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || typeof url !== 'string') return undefined
  const head = isRecord(body.head) && typeof body.head.ref === 'string' ? body.head.ref : undefined
  const base = isRecord(body.base) && typeof body.base.ref === 'string' ? body.base.ref : undefined
  if (head === undefined || base === undefined) return undefined
  const author = isRecord(body.user) && typeof body.user.login === 'string' ? body.user.login : undefined
  return {
    ok: true,
    number,
    title: typeof body.title === 'string' ? body.title : '',
    url,
    repository: `${repository.owner}/${repository.name}`,
    head,
    base,
    draft: body.draft === true,
    created,
    ...(author === undefined ? {} : { author }),
  }
}

function hintForError(error: unknown): string | undefined {
  if (!(error instanceof GitHubApiError)) return undefined
  switch (error.status) {
    case 401:
      return 'Call refresh_ghapp_token with force=true to replace a revoked token, then retry.'
    case 403:
      return 'The installation may lack the pull-requests write permission, or the repository may be outside the installation.'
    case 404:
      return 'Check the repository, head branch, and base branch; a repository outside the installation reports 404.'
    case 422:
      return 'Push the head branch first and confirm both branches exist on the remote; GitHub only opens a pull request between existing branches.'
    default:
      return undefined
  }
}

function repoPathSegments(repository: RepositoryRef): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
}

async function recoverExistingPullRequest(
  transport: Omit<GitHubRestRequest, 'method' | 'path' | 'body'>,
  repository: RepositoryRef,
  head: string,
  original: string,
): Promise<PullRequestResult> {
  const qualifiedHead = head.includes(':') ? head : `${repository.owner}:${head}`
  try {
    const response = await githubRest({
      ...transport,
      method: 'GET',
      path: `${repoPathSegments(repository)}/pulls?state=open&head=${encodeURIComponent(qualifiedHead)}`,
    })
    if (Array.isArray(response.body)) {
      for (const entry of response.body) {
        const existing = pullRequestResult(entry, false, repository)
        if (existing !== undefined) return existing
      }
    }
    return {
      ok: false,
      message: `${original}; no open pull request for ${qualifiedHead} was found`,
      hint: 'List the repository pull requests to find the open one, or push a different head branch.',
    }
  } catch (lookupError: unknown) {
    return {
      ok: false,
      message: `${original}; reading the open pull request failed: ${messageOf(lookupError)}`,
      hint: 'List the repository pull requests to find the open one, then retry the create call only for a new branch.',
    }
  }
}

/**
 * Create a pull request with an installation token.
 * @param request - repository, branches, title, body, and transport facts.
 * @returns the created pull request, the already-open one, or a structured failure.
 */
export async function createPullRequest(request: CreatePullRequestRequest): Promise<PullRequestResult> {
  const transport = {
    apiBaseUrl: request.apiBaseUrl,
    authorization: `Bearer ${request.token}`,
    signal: request.signal,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  }
  let base = request.base
  try {
    if (base === undefined) {
      const response = await githubRest({ ...transport, method: 'GET', path: repoPathSegments(request.repository) })
      if (!isRecord(response.body) || typeof response.body.default_branch !== 'string') {
        return { ok: false, message: 'GitHub response omitted the repository default branch; pass base explicitly' }
      }
      base = response.body.default_branch
    }
    const response = await githubRest({
      ...transport,
      method: 'POST',
      path: `${repoPathSegments(request.repository)}/pulls`,
      body: {
        title: request.title,
        head: request.head,
        base,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.draft === undefined ? {} : { draft: request.draft }),
      },
    })
    const created = pullRequestResult(response.body, true, request.repository)
    if (created === undefined) {
      return { ok: false, message: 'GitHub returned an unexpected pull-request response', hint: 'Retry once; if it persists, open the pull request with gh pr create.' }
    }
    return created
  } catch (error: unknown) {
    if (error instanceof GitHubApiError && error.status === 422 && /already exists/i.test(error.message)) {
      return recoverExistingPullRequest(transport, request.repository, request.head, error.message)
    }
    const hint = hintForError(error)
    return { ok: false, message: messageOf(error), ...(hint === undefined ? {} : { hint }) }
  }
}

/**
 * Create the `create_pull_request` tool.
 * @param runtime - token, API, and git services owned by the plugin.
 * @returns a registry-ready tool declaration.
 */
export function createPullRequestTool(runtime: PullRequestRuntime): ToolDefinition<PullRequestArgs, PullRequestResult> {
  return {
    name: 'create_pull_request',
    description: 'Create a GitHub pull request with the GitHub App installation token, so GitHub attributes it to the '
      + 'App bot account. The head branch must already be pushed; this tool does not commit or push. Defaults: repository '
      + 'from the origin remote of the working directory, head from the checked-out branch, base from the repository '
      + 'default branch. An already-open pull request for the same head branch is returned instead of a duplicate error.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Pull-request title.' },
        body: { type: 'string', description: 'Pull-request description in Markdown.' },
        base: { type: 'string', description: 'Branch to merge into; defaults to the repository default branch.' },
        head: { type: 'string', description: 'Branch containing the changes; defaults to the checked-out branch.' },
        draft: { type: 'boolean', description: 'Open the pull request as a draft.' },
        repo: { type: 'string', description: 'Repository as owner/name; defaults to the origin remote of the working directory.' },
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          number: { type: 'integer' },
          title: { type: 'string' },
          url: { type: 'string' },
          repository: { type: 'string' },
          head: { type: 'string' },
          base: { type: 'string' },
          draft: { type: 'boolean' },
          created: { type: 'boolean' },
          author: { type: 'string' },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `${value.created ? 'Created' : 'Found the open'} pull request #${value.number} in ${value.repository} `
          + `(${value.head} → ${value.base})${value.draft ? ' as a draft' : ''}: ${value.url}`
          + `${value.author === undefined ? '' : ` Author: ${value.author}.`}`
        : `Pull request failed: ${value.message}${value.hint === undefined ? '' : ` ${value.hint}`}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const title = args.title.trim()
      if (title === '') return { ok: false, message: 'pull request title must not be empty' }
      const explicitRepository = args.repo === undefined ? undefined : parseRepository(args.repo)
      if (args.repo !== undefined && explicitRepository === undefined) {
        return { ok: false, message: `repo must be "owner/name": ${args.repo}` }
      }
      const subprocess = runtime.subprocess()
      const needGit = explicitRepository === undefined || args.head === undefined
      if (needGit && subprocess === undefined) {
        return {
          ok: false,
          message: 'create_pull_request requires the subprocess service to read the repository and branch',
          hint: 'Pass repo=owner/name and head=branch explicitly in this composition.',
        }
      }
      let repository = explicitRepository
      let head = args.head?.trim()
      if (needGit && subprocess !== undefined) {
        let cwd: string
        let executable: string
        try {
          cwd = await resolveWorkspaceCwd(runtime, exec)
          executable = await subprocess.resolveExecutable('git')
        } catch (error: unknown) {
          return { ok: false, message: `cannot use git in the working directory: ${messageOf(error)}` }
        }
        if (repository === undefined) {
          const remote = await runGit(subprocess, executable, cwd, ['config', '--get', 'remote.origin.url'], {}, exec.signal)
          repository = remote.code === 0 ? parseRepositoryFromRemote(remote.stdout) : undefined
          if (repository === undefined) {
            return {
              ok: false,
              message: `cannot read a GitHub repository from the origin remote: ${failureText(remote, 'git config failed')}`,
              hint: 'Pass repo=owner/name explicitly.',
            }
          }
        }
        if (head === undefined || head === '') {
          const branch = await runGit(subprocess, executable, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], {}, exec.signal)
          const current = branch.code === 0 ? branch.stdout.trim() : ''
          if (current === '' || current === 'HEAD') {
            return {
              ok: false,
              message: `cannot determine the head branch from ${cwd}: ${failureText(branch, 'git rev-parse failed')}`,
              hint: 'Pass head=branch explicitly; a detached HEAD has no branch name.',
            }
          }
          head = current
        }
      }
      if (repository === undefined) {
        return { ok: false, message: 'a repository is required', hint: 'Pass repo=owner/name.' }
      }
      if (head === undefined || head === '') {
        return { ok: false, message: 'a head branch is required', hint: 'Pass head=branch.' }
      }
      const access = await runtime.accessToken(exec.signal)
      if (!access.ok) return { ok: false, message: access.message, hint: access.hint }
      return createPullRequest({
        apiBaseUrl: runtime.apiBaseUrl(),
        token: access.token,
        repository,
        title,
        head,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.base === undefined ? {} : { base: args.base.trim() }),
        ...(args.draft === undefined ? {} : { draft: args.draft }),
        signal: exec.signal,
        ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      })
    },
  }
}

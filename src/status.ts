/**
 * The settings page's live-status endpoint.
 *
 * The route answers the same facts as `check_ghapp_token_status`, plus the Host
 * clock so the page can count down with both clocks aligned. Reading the cached
 * token file is the whole operation: no GitHub request, no refresh lock, no
 * write, and no timer. The page only polls while it is open.
 *
 * @module @dynastxu/dsh-github-agents-proxy/status
 */

import type { TokenStatusResponse } from './status-contract.ts'
import { resolveManager, tokenReport, type TokenManagerSource } from './tools.ts'

/**
 * Answer one live-status request.
 *
 * The App owner avatar comes from the identity the plugin already resolved at
 * load or after a refresh; this route never asks GitHub for it.
 * @param source - token manager owner shared with the tools and settings form.
 * @param now - Host clock in epoch milliseconds.
 * @param appAvatarUrl - avatar of the resolved App owner, undefined until the Host resolves it.
 * @returns an uncached JSON response carrying the current token facts.
 */
export async function serveTokenStatus(
  source: TokenManagerSource,
  now: () => number = Date.now,
  appAvatarUrl: () => string | undefined = () => undefined,
): Promise<Response> {
  const snapshot = await resolveManager(source).checkFromDisk()
  const avatar = appAvatarUrl()
  const body: TokenStatusResponse = {
    ...tokenReport(snapshot),
    server_time: new Date(now()).toISOString(),
    ...(avatar === undefined || avatar === '' ? {} : { app_avatar_url: avatar }),
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

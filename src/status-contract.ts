/**
 * Wire contract between the Host's status route and the settings page.
 *
 * Both halves import this module, so it may hold only values and types that are
 * valid in a browser: no Node.js imports and no Host behaviour.
 *
 * @module @dynastxu/dsh-github-agents-proxy/status-contract
 */

import type { TokenReport } from './types.ts'

/** Exact Fetch route the open settings page polls. */
export const TOKEN_STATUS_ROUTE = '/api/github-agents-proxy/status'

/** Body of {@link TOKEN_STATUS_ROUTE}. */
export interface TokenStatusResponse extends TokenReport {
  /** Host clock at the response instant, so the page counts down against the Host clock. */
  readonly server_time: string
  /**
   * App owner avatar URL resolved from `GET /app` when the Host fetched the bot
   * identity, so the settings page can show the App's owner.
   */
  readonly app_avatar_url?: string
}

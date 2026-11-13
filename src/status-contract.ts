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

/**
 * GitHub App identity the settings page shows in its header card.
 *
 * Both values come from the identity the Host resolved from the App
 * credentials; the settings page never fetches them itself.
 */
export interface AppIdentity {
  /** App name, falling back to the App slug when GitHub omits the name. */
  readonly appName: string
  /** Avatar URL of the App bot user, when GitHub reported one. */
  readonly avatarUrl?: string
}

/** Body of {@link TOKEN_STATUS_ROUTE}. */
export interface TokenStatusResponse extends TokenReport {
  /** Host clock at the response instant, so the page counts down against the Host clock. */
  readonly server_time: string
  /**
   * App avatar URL from the bot user response, exposed once the Host has
   * resolved the identity so the settings page can show the App's own avatar.
   */
  readonly app_avatar_url?: string
  /**
   * App name for the settings-page title, exposed once the Host has resolved
   * the identity. The page keeps its generic label while this is absent, which
   * covers both a pending lookup and a failed one.
   */
  readonly app_name?: string
}

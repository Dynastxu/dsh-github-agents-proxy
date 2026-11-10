/**
 * GitHub App proxy plugin for DeepSeek Harness.
 *
 * [`cordis.patch.yml`](../cordis.patch.yml) inserts the profile row that loads
 * this module. The proxy contributes no service, tool, or interface yet: its
 * implementation belongs in this module, behind the same plugin `name` the
 * bundle patch references.
 *
 * @module @dynastxu/dsh-github-agents-proxy
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name used by Loader diagnostics and profile patch rows. */
export const name = 'github-agents-proxy'

/**
 * Mount the GitHub App proxy for the lifetime of `ctx`.
 *
 * Every contribution the proxy adds must be registered through `ctx.effect()`
 * or `ctx.on()`, so disposing this plugin releases it.
 * @param _ctx - plugin context; contributions are disposed with it.
 */
export function apply(_ctx: Context): void {
  // The proxy has no contributions yet.
}

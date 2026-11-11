/**
 * PEM file chooser bridge of the Desktop app.
 *
 * The browser cannot read a local file path, so the settings page offers the
 * folder button only where the Desktop preload exposes one. Ordinary Web keeps
 * the text field, because the Host reads the path on its own machine.
 *
 * @module @dynastxu/dsh-github-agents-proxy/client/file-picker
 */

/** Narrows one File to the absolute path Electron assigned it. */
export interface HostPathBridge {
  /** @param file - file chosen through a native file input. @returns its absolute path, or the empty string. */
  pathFor(file: File): string
}

declare global {
  interface Window {
    /** Desktop preload bridge that resolves a File to its host path. */
    readonly __DSH_HOST_PATHS__?: unknown
  }
}

/**
 * Read the Desktop file-path bridge, rejecting anything that is not the
 * expected shape.
 * @param candidate - value exposed on the page, normally `window.__DSH_HOST_PATHS__`.
 * @returns the bridge, or undefined outside the Desktop app.
 */
export function hostPathBridge(candidate: unknown): HostPathBridge | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as { pathFor?: unknown }
  if (typeof bridge.pathFor !== 'function') return undefined
  const pathFor = bridge.pathFor
  return {
    pathFor: (file) => {
      const value: unknown = pathFor.call(candidate, file)
      return typeof value === 'string' ? value : ''
    },
  }
}

/**
 * Read the bridge from the current window.
 * @returns the bridge when the page runs inside the Desktop app.
 */
export function readHostPathBridge(): HostPathBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return hostPathBridge(window.__DSH_HOST_PATHS__)
}

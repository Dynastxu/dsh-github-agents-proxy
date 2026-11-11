/**
 * Remaining-time formatting shared by the Host snapshot and the settings page.
 *
 * The module has no Node.js dependency, so the browser half can format a
 * countdown from the same code the model sees.
 *
 * @module @dynastxu/dsh-github-agents-proxy/duration
 */

/**
 * Render a compact remaining-time label.
 * @param totalSeconds - remaining whole seconds.
 * @returns a label such as `45s`, `1m52s`, `28m2s`, or `1h2m`.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d${rest}h`
}

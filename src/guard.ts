/**
 * Command-shape guard for raw `git commit` invocations.
 *
 * This is a policy guard for model-issued shell tools, not a security
 * boundary: scripts, aliases, and indirect loaders can still invoke git
 * outside the command string the model submits.
 *
 * @module @dynastxu/dsh-github-agents-proxy/guard
 */

const GIT_COMMIT = /(?:^|[;&|()\s])git(?:\.exe)?(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|--paginate|--bare|--exec-path(?:=|\s+)\S+))*\s+commit(?=\s|$)/iu

/**
 * Whether a shell command contains a direct git commit invocation.
 * @param command - shell command text submitted to bash or pwsh.
 * @returns true when the command appears to invoke `git commit`.
 */
export function isGitCommitCommand(command: string): boolean {
  return GIT_COMMIT.test(command)
}

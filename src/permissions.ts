/**
 * Shared read boundary for every Claude Code process this extension starts.
 *
 * Verified on Claude Code 2.1.296 (2026-10-12):
 * - `--settings` permission deny rules apply to the coordinator and to `--agents` subagents.
 * - `Read(//**\/<glob>)` matches at any depth on every drive; a relative `**\/<glob>` only matches under cwd.
 * - With `--permission-mode dontAsk` and only `Read(./**)` allowed, reads and Grep searches outside the
 *   working directory and `--add-dir` directories are denied, while Read/Grep/Glob inside them still work.
 * - Read deny rules are also applied (best effort) to Grep and Glob.
 */

/** Secret-bearing file name globs. Also excluded from repo-mode folder snapshots. */
export const SECRET_FILE_GLOBS: readonly string[] = Object.freeze([
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials.json',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_ed25519*',
  'id_dsa*',
  'id_ecdsa*',
]);

/** Home-directory credential stores (defense in depth when cwd is the home directory). */
export const SECRET_HOME_PATHS: readonly string[] = Object.freeze([
  '~/.ssh/**',
  '~/.aws/**',
  '~/.azure/**',
  '~/.kube/**',
  '~/.gnupg/**',
  '~/.docker/config.json',
  '~/.config/gh/**',
  '~/.config/gcloud/**',
  '~/.claude/.credentials.json',
  '~/.claude.json',
  '~/.pi/agent/auth.json',
  '~/.pi/agent/codex-accounts.json',
]);

/** Paths the Claude process may read without prompting: the working directory (`--add-dir` is implicit). */
export const READ_ALLOW_RULE = 'Read(./**)';

export function buildDenyRules(): string[] {
  return [
    ...SECRET_FILE_GLOBS.map(glob => `Read(//**/${glob})`),
    ...SECRET_HOME_PATHS.map(path => `Read(${path})`),
  ];
}

export function buildPermissionSettings(): { deny: string[] } {
  return { deny: buildDenyRules() };
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/\\\\]*');
  return new RegExp(`^${source}$`, 'i');
}

const SECRET_FILE_PATTERNS = SECRET_FILE_GLOBS.map(globToRegExp);

/** True when a bare file name matches one of {@link SECRET_FILE_GLOBS} (case-insensitive). */
export function isSecretFileName(name: string): boolean {
  return SECRET_FILE_PATTERNS.some(pattern => pattern.test(name));
}

import { ReviewError } from './types.ts';

/** Shared process-wide state for every Claude Code run (review and advise). */

type ExecResult = { code: number; stdout: string; stderr: string };
export type PreflightApi = { exec(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<ExecResult> };

let running = false;
let checkedAt = 0;
let claudeVersion = 'unknown';

/** One Claude process at a time across /cc-review, approved reviews, and advisor consultations. */
export function tryAcquireLock(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function releaseLock(): void {
  running = false;
}

export function isLocked(): boolean {
  return running;
}

export function getClaudeVersion(): string {
  return claudeVersion;
}

export function throwIfCancelled(signal: AbortSignal | undefined, what = 'Claude Code review'): void {
  if (signal?.aborted) throw new ReviewError('PROCESS_CANCELLED', `${what} cancelled.`);
}

export function combinedSignal(primary: AbortSignal, external: AbortSignal | undefined): AbortSignal {
  return external ? AbortSignal.any([primary, external]) : primary;
}

export function supportsRequiredClaudeVersion(version: string) {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2
    || (major === 2 && minor > 1)
    || (major === 2 && minor === 1 && patch >= 205);
}

export async function preflight(pi: PreflightApi, cwd: string) {
  if (Date.now() - checkedAt < 300_000) return;

  const version = await pi.exec('claude', ['--version'], {
    cwd,
    timeout: 10_000,
  });
  if (version.code !== 0) {
    throw new ReviewError(
      'CLAUDE_NOT_FOUND',
      'Claude Code is unavailable. Install or repair Claude Code.',
    );
  }

  claudeVersion = version.stdout.trim();
  if (!supportsRequiredClaudeVersion(claudeVersion)) {
    throw new ReviewError(
      'CLAUDE_VERSION_UNSUPPORTED',
      'Claude Code 2.1.205 or later is required.',
    );
  }

  const auth = await pi.exec('claude', ['auth', 'status'], {
    cwd,
    timeout: 10_000,
  });
  if (auth.code !== 0) {
    throw new ReviewError(
      'CLAUDE_NOT_AUTHENTICATED',
      'Claude Code is not authenticated. Run: claude auth login',
    );
  }
  checkedAt = Date.now();
}

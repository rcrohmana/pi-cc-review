import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { LIMITS, ReviewError } from './types.ts';

export function createUtf8Accumulator(limit = Infinity) {
  const decoder = new StringDecoder('utf8'); let text = ''; let bytes = 0;
  return { push(chunk: Buffer) { const part = chunk.subarray(0, Math.max(0, limit - bytes)); bytes += part.length; text += decoder.write(part); }, finish() { return text + decoder.end(); } };
}
function bounded(text: string) {
  if (text.length <= LIMITS.patch) return { text, truncated: false };
  return {
    text: `${text.slice(0, LIMITS.patch)}\n[TRUNCATED: patch limit]`,
    truncated: true,
  };
}

async function git(
  cwd: string,
  args: string[],
  errorCode = 'NOT_A_GIT_REPOSITORY',
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const stdoutDecoder = createUtf8Accumulator(LIMITS.patch + 1024);
    const stderrDecoder = createUtf8Accumulator(4_000);

    const finish = (error?: ReviewError) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      return true;
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new ReviewError('PROCESS_TIMEOUT', 'Git evidence collection timed out.'));
    }, 10_000);

    child.stdout.on('data', value => {
      stdoutDecoder.push(value);
    });
    child.stderr.on('data', value => {
      stderrDecoder.push(value);
    });
    child.on('error', () => {
      finish(new ReviewError('NOT_A_GIT_REPOSITORY', 'Git is unavailable.'));
    });
    child.on('close', status => {
      if (!finish()) return;
      stdout = stdoutDecoder.finish(); stderr = stderrDecoder.finish();
      if (status === 0) resolve(stdout);
      else reject(new ReviewError(errorCode, stderr.trim() || 'Git command failed.'));
    });
  });
}

function untrackedStatusLines(status: string) {
  return status
    .split(/\r?\n/)
    .filter(line => line.startsWith('?? '))
    .join('\n');
}

export async function collectGit(cwd: string, base?: string) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();

  if (base) {
    await git(cwd, ['rev-parse', '--verify', `${base}^{commit}`], 'INVALID_BASE_REF');
  }

  const status = await git(cwd, ['status', '--short', '--untracked-files=all']);
  const workingNames = await git(cwd, ['diff', '--name-status']);
  const stagedNames = await git(cwd, ['diff', '--cached', '--name-status']);
  const baseNames = base
    ? await git(cwd, ['diff', '--name-status', `${base}...HEAD`])
    : '';
  const changedFiles = [
    workingNames.trimEnd(),
    stagedNames.trimEnd(),
    baseNames.trimEnd(),
    untrackedStatusLines(status),
  ].filter(Boolean).join('\n');

  const working = bounded(await git(cwd, ['diff', '--no-ext-diff', '--unified=40']));
  const staged = bounded(await git(cwd, ['diff', '--cached', '--no-ext-diff', '--unified=40']));
  const baseResult = base
    ? bounded(await git(cwd, ['diff', '--no-ext-diff', '--unified=40', `${base}...HEAD`]))
    : { text: '', truncated: false };

  if (!status.trim() && !working.text && !staged.text && !baseResult.text) {
    throw new ReviewError('NO_CODE_CHANGES', 'No reviewable Git changes found.');
  }

  return {
    root,
    branch,
    head,
    status,
    changedFiles,
    working: working.text,
    staged: staged.text,
    baseRef: base,
    baseDiff: baseResult.text,
    truncated: working.truncated || staged.truncated || baseResult.truncated,
  };
}

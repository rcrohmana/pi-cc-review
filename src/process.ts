import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ReviewError } from './types.ts';

const OUTPUT_LIMIT = 1_000_000;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ProcessRunOptions { signal?: AbortSignal; onStdoutLine?: (line: string) => void; }
export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let timer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder('utf8');
    let lineBuffer = '';
    const emitLines = (text: string, flush = false) => {
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      if (flush && lineBuffer) lines.push(lineBuffer), lineBuffer = '';
      for (const line of lines) { try { options.onStdoutLine?.(line); } catch {} }
    };

    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    const settle = (value?: ProcessResult, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };

    const killTree = () => new Promise<void>(done => {
      if (!child.pid) {
        child.kill('SIGKILL');
        done();
        return;
      }
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        done();
        return;
      }

      const killer = spawn(
        'taskkill',
        ['/pid', String(child.pid), '/t', '/f'],
        { shell: false, stdio: 'ignore', windowsHide: true },
      );
      killer.on('error', () => {
        child.kill('SIGKILL');
        done();
      });
      killer.on('close', () => done());
    });

    const stopForOutputLimit = () => {
      if (terminating || settled) return;
      terminating = true;
      void killTree().finally(() => {
        settle(
          undefined,
          new ReviewError('OUTPUT_TOO_LARGE', 'Claude output exceeded the safe capture limit.'),
        );
      });
    };

    const append = (chunks: Buffer[], currentBytes: number, value: Buffer) => {
      const available = Math.max(0, OUTPUT_LIMIT - currentBytes);
      if (available > 0) chunks.push(value.subarray(0, available));
      if (value.length > available) stopForOutputLimit();
      return currentBytes + value.length;
    };

    child.stdout.on('data', value => {
      stdoutBytes = append(stdoutChunks, stdoutBytes, value);
      emitLines(decoder.write(value));
    });
    child.stderr.on('data', value => {
      stderrBytes = append(stderrChunks, stderrBytes, value);
    });
    child.on('error', error => {
      settle(
        undefined,
        new ReviewError('CLAUDE_NOT_FOUND', `Cannot start Claude Code: ${error.message}`),
      );
    });
    child.on('close', code => {
      if (terminating) return;
      emitLines(decoder.end(), true);
      settle({
        code,
        stdout: text(stdoutChunks),
        stderr: text(stderrChunks),
        timedOut: false,
        durationMs: Date.now() - started,
      });
    });

    const abort = () => {
      if (settled || terminating) return;
      terminating = true;
      void killTree().finally(() => settle(undefined, new ReviewError('PROCESS_CANCELLED', 'Claude Code review cancelled.')));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void killTree().finally(() => {
        settle({
          code: null,
          stdout: text(stdoutChunks),
          stderr: text(stderrChunks),
          timedOut: true,
          durationMs: Date.now() - started,
        });
      });
    }, timeoutMs);
  });
}

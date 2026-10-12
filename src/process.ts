import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { ReviewError } from './types.ts';

const OUTPUT_LIMIT = 1_000_000;
const DIAGNOSTIC_TAIL_LIMIT = 64 * 1024;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ProcessRunOptions {
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  stdoutFile?: string;
  /** Extra environment variables merged over the inherited environment. */
  env?: Readonly<Record<string, string>>;
}
export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw new ReviewError('PROCESS_CANCELLED', 'Claude Code review cancelled.');
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutTail: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTailBytes = 0;
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
    const appendTail = (value: Buffer) => {
      stdoutTail.push(value);
      stdoutTailBytes += value.length;
      while (stdoutTailBytes > DIAGNOSTIC_TAIL_LIMIT && stdoutTail.length > 0) {
        const overflow = stdoutTailBytes - DIAGNOSTIC_TAIL_LIMIT;
        const first = stdoutTail[0];
        if (first.length <= overflow) {
          stdoutTail.shift();
          stdoutTailBytes -= first.length;
        } else {
          stdoutTail[0] = first.subarray(overflow);
          stdoutTailBytes -= overflow;
        }
      }
    };
    const capturedStdout = () => options.stdoutFile
      ? text(stdoutTail)
      : text(stdoutChunks);
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

    let captureFailure: ReviewError | undefined;
    const captureDone = options.stdoutFile
      ? pipeline(
          child.stdout,
          createWriteStream(options.stdoutFile, { flags: 'w', mode: 0o600 }),
        ).catch(error => {
          const captureError = new ReviewError(
            'STREAM_CAPTURE_FAILED',
            `Could not capture Claude output: ${error instanceof Error ? error.message : 'unknown stream error'}`,
          );
          captureFailure = captureError;
          if (!settled && !terminating) {
            terminating = true;
            void killTree().finally(() => settle(undefined, captureError));
          }
        })
      : Promise.resolve();
    const terminateAndFlush = async () => {
      await killTree();
      await captureDone;
    };

    child.stdout.on('data', value => {
      if (options.stdoutFile) appendTail(value);
      else stdoutBytes = append(stdoutChunks, stdoutBytes, value);
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
      void captureDone.then(() => {
        if (terminating || settled || captureFailure) return;
        settle({
          code,
          stdout: capturedStdout(),
          stderr: text(stderrChunks),
          timedOut: false,
          durationMs: Date.now() - started,
        });
      });
    });

    const abort = () => {
      if (settled || terminating) return;
      terminating = true;
      void terminateAndFlush().finally(() => settle(
        undefined,
        new ReviewError('PROCESS_CANCELLED', 'Claude Code review cancelled.'),
      ));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void terminateAndFlush().finally(() => {
        settle({
          code: null,
          stdout: capturedStdout(),
          stderr: text(stderrChunks),
          timedOut: true,
          durationMs: Date.now() - started,
        });
      });
    }, timeoutMs);
  });
}

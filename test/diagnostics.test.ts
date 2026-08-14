import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHandler } from '../src/index.ts';
import { errorText, formatDuration } from '../src/render.ts';
import { ReviewError } from '../src/types.ts';

const entries = [{ message: { role: 'user', content: 'review' } }, { message: { role: 'assistant', content: 'x'.repeat(400) } }];

test('formatDuration renders sub-second, seconds, and minutes forms', () => {
  assert.equal(formatDuration(0), '<1s');
  assert.equal(formatDuration(999), '<1s');
  assert.equal(formatDuration(1_000), '1s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(59_999), '59s');
  assert.equal(formatDuration(60_000), '1m 0s');
  assert.equal(formatDuration(252_000), '4m 12s');
  assert.equal(formatDuration(90 * 60_000), '90m 0s');
});

test('errorText rejects unsafe codes and redacts sensitive diagnostics', () => {
  const rendered = errorText({
    code: 'BAD]\nINJECTED',
    message: 'Bearer bearer-secret API_KEY=api-secret token=token-secret password=pw-secret\u0000tail',
  });

  assert.match(rendered, /^\[PROCESS_FAILED\]/);
  assert.doesNotMatch(rendered, /bearer-secret|api-secret|token-secret|pw-secret|\u0000/);
  assert.match(rendered, /\[REDACTED\]/);
});

test('errorText caps unknown messages and preserves ordinary ReviewError codes', () => {
  const long = errorText(new Error('x'.repeat(5_000)));
  assert.ok(long.length <= 520);
  assert.match(long, /^\[PROCESS_FAILED\]/);

  assert.equal(
    errorText(new ReviewError('USAGE_ERROR', 'Invalid review arguments.')),
    '[USAGE_ERROR] Invalid review arguments.',
  );
});

test('nonzero process diagnostics are bounded, redacted, cleaned, and not injected', async () => {
  const notices: string[] = [];
  const sent: unknown[] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.212 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: (message: unknown) => sent.push(message),
  };
  let cleaned = 0;
  const handler = createCommandHandler(pi, {
    bundle: async () => ({ directory: 'C:/tmp/bundle', manifestPath: 'C:/tmp/bundle/manifest.md', truncated: false, bytes: 1 }),
    cleanup: async () => { cleaned++; },
    run: async () => ({ code: 1, timedOut: false, durationMs: 1, stdout: '', stderr: `Authorization: Bearer secret-token\nAPI_KEY=abc123\nsk-ant-secret\n${'x'.repeat(800)}` }),
  } as any);
  await handler('plan --raw', { cwd: process.cwd(), ui: { notify: (message: string) => notices.push(message) }, sessionManager: { buildContextEntries: () => entries } });
  const error = notices.at(-1) ?? '';
  assert.match(error, /PROCESS_FAILED/);
  assert.match(error, /Details:/);
  assert.doesNotMatch(error, /secret-token|abc123|sk-ant-secret/);
  assert.ok(error.length <= 650);
  assert.equal(sent.length, 0);
  assert.equal(cleaned, 1);
});

test('JSON-only Claude runtime failure is surfaced and redacted', async () => {
  const notices: string[] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.222 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: () => { throw new Error('must not inject a failed review'); },
  };
  const failure = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    errors: [],
    result: 'Selected model unavailable. token=secret-token',
    api_error_status: 404,
  });
  const handler = createCommandHandler(pi, {
    bundle: async () => ({
      directory: 'C:/tmp/bundle',
      manifestPath: 'C:/tmp/bundle/manifest.md',
      truncated: false,
      bytes: 1,
    }),
    cleanup: async () => {},
    run: async (_command: string, _args: string[], _cwd: string, _timeout: number, options: any) => {
      options.onStdoutLine(failure);
      return { code: 1, timedOut: false, durationMs: 1, stdout: '', stderr: '' };
    },
  } as any);

  await handler('plan --raw', {
    cwd: process.cwd(),
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { buildContextEntries: () => entries },
  });

  const error = notices.at(-1) ?? '';
  assert.match(error, /^\[PROCESS_FAILED\] Claude Code exited 1\./);
  assert.match(error, /API 404: Selected model unavailable/);
  assert.doesNotMatch(error, /secret-token/);
});

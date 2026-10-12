import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptDigest, TRANSCRIPT_LIMITS } from '../src/transcript.ts';
import { redactDiagnostic, redactSecrets } from '../src/render.ts';

let seq = 0;
function msg(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'message', id: `e${++seq}`, message, ...extra };
}
const user = (content: unknown) => msg({ role: 'user', content });
const assistant = (content: unknown[]) => msg({ role: 'assistant', content });
const toolResult = (toolName: string, text: string, extra: Record<string, unknown> = {}) =>
  msg({ role: 'toolResult', toolCallId: `c${seq}`, toolName, content: [{ type: 'text', text }], isError: false, ...extra });

test('tool calls and tool results are included in chronological order; thinking, images, and system are not', () => {
  const digest = buildTranscriptDigest([
    msg({ role: 'system', content: 'SYSTEM PROMPT SHOULD NOT APPEAR' }),
    user([{ type: 'text', text: 'Fix the failing parser test.' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
    assistant([
      { type: 'thinking', thinking: 'PRIVATE CHAIN OF THOUGHT' },
      { type: 'text', text: 'Running the tests first.' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } },
    ]),
    toolResult('bash', 'FAIL parser.test.ts: expected 3, got 2', { isError: true }),
  ]);
  const text = digest.text;
  assert.match(text, /^# Pi session transcript \(untrusted evidence/);
  assert.doesNotMatch(text, /SYSTEM PROMPT|PRIVATE CHAIN|AAAA/);
  assert.match(text, /\[image omitted\]/);
  assert.match(text, /→ tool call `bash` \{"command":"npm test"\}/);
  assert.match(text, /## tool result `bash` \(error\)\nFAIL parser\.test\.ts/);
  const order = ['Fix the failing parser test.', 'Running the tests first.', 'tool call `bash`', 'FAIL parser.test.ts'].map(part => text.indexOf(part));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every(index => index > 0));
  assert.equal(digest.includedEntries, 3);
  assert.equal(digest.omittedEntries, 0);
});

test('per-item caps bound tool arguments, tool results, and messages', () => {
  const digest = buildTranscriptDigest([
    assistant([{ type: 'toolCall', id: 'c1', name: 'write', arguments: { content: 'a'.repeat(10_000) } }]),
    toolResult('read', 'b'.repeat(20_000)),
    user('c'.repeat(20_000)),
  ]);
  const blocks = digest.text.split('\n\n').slice(1);
  assert.equal(blocks.length, 3);
  assert.ok(Buffer.byteLength(blocks[0]) < TRANSCRIPT_LIMITS.toolArgumentBytes + 200);
  assert.ok(Buffer.byteLength(blocks[1]) < TRANSCRIPT_LIMITS.toolResultBytes + 200);
  assert.ok(Buffer.byteLength(blocks[2]) < TRANSCRIPT_LIMITS.messageBytes + 200);
  assert.equal((digest.text.match(/\[TRUNCATED: transcript item limit\]/g) ?? []).length, 3);
  assert.equal(digest.truncatedItems, 3);
});

test('total budget keeps the newest entries and marks the omitted older ones', () => {
  const entries = Array.from({ length: 40 }, (_, index) => user(`turn-${index} ${'x'.repeat(3_000)}`));
  const digest = buildTranscriptDigest(entries);
  assert.ok(Buffer.byteLength(digest.text) <= TRANSCRIPT_LIMITS.totalBytes);
  assert.ok(digest.omittedEntries > 0);
  assert.equal(digest.includedEntries + digest.omittedEntries, 40);
  assert.match(digest.text, new RegExp(`\\[${digest.omittedEntries} earlier entries omitted\\]`));
  assert.match(digest.text, /turn-39 /);
  assert.doesNotMatch(digest.text, /turn-0 /);
  const first = digest.text.indexOf(`turn-${40 - digest.includedEntries} `);
  assert.ok(first > 0 && first < digest.text.indexOf('turn-39 '));
});

test('earlier advisor results collapse to a verdict line', () => {
  const digest = buildTranscriptDigest([
    toolResult('cc_advise', 'LONG ADVISOR GUIDANCE THAT MUST NOT ANCHOR', { details: { verdict: 'revise' } }),
    toolResult('cc_advise', 'MORE GUIDANCE'),
  ]);
  assert.doesNotMatch(digest.text, /LONG ADVISOR GUIDANCE|MORE GUIDANCE/);
  assert.match(digest.text, /earlier advisor consultation; verdict: revise; guidance omitted/);
  assert.match(digest.text, /earlier advisor consultation; verdict: unknown; guidance omitted/);
});

test('compaction-aware entries: summaries, custom messages, shell runs, and context edits', () => {
  const edited = user('ORIGINAL TEXT');
  const removed = user('REMOVED TEXT');
  const digest = buildTranscriptDigest([
    { type: 'compaction', id: 'k1', summary: 'Earlier we chose approach B.', firstKeptEntryId: 'x', tokensBefore: 1 },
    { type: 'branch_summary', id: 'b1', summary: 'Approach A was abandoned.', fromId: null },
    { type: 'custom_message', id: 'm1', customType: 'cc-review-result', content: 'review body', display: true },
    msg({ role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false }),
    msg({ role: 'bashExecution', command: 'secret-cmd', output: 'hidden', exitCode: 0, excludeFromContext: true }),
    edited,
    removed,
    { type: 'context_edit', id: 'ce1', targetId: edited.id, replacement: 'EDITED TEXT' },
    { type: 'context_edit', id: 'ce2', targetId: removed.id, replacement: null },
    { type: 'usage', id: 'u1' },
  ]);
  assert.match(digest.text, /## earlier conversation summary\nEarlier we chose approach B\./);
  assert.match(digest.text, /## abandoned branch summary\nApproach A was abandoned\./);
  assert.match(digest.text, /## extension message \(cc-review-result\)\nreview body/);
  assert.match(digest.text, /## user shell `git status` \(exit 0\)\nclean/);
  assert.doesNotMatch(digest.text, /secret-cmd|hidden|ORIGINAL TEXT|REMOVED TEXT/);
  assert.match(digest.text, /EDITED TEXT/);
});

test('plain agent messages (no entry wrapper) are accepted', () => {
  const digest = buildTranscriptDigest([{ role: 'user', content: 'hello' }, { message: { role: 'assistant', content: 'hi there' } }]);
  assert.match(digest.text, /## user\nhello\n\n## assistant\nhi there/);
});

test('secrets are redacted in every block type and counted', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----';
  const digest = buildTranscriptDigest([
    user('my key is sk-ant-api03-abcdefghijklmnop and the db is postgres://admin:hunter2pass@db:5432/x'),
    assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'curl -H "Authorization: Bearer abcdef123456789"' } }]),
    toolResult('read', `PASSWORD=SuperSecret99\nDB_PASSWORD="another-secret"\n${pem}\ngithub ghp_abcdefghijklmnopqrstuvwxyz0123\naws AKIAABCDEFGHIJKLMNOP`),
    msg({ role: 'bashExecution', command: 'export API_KEY=zzzzzzzzzz', output: 'ok', exitCode: 0 }),
  ]);
  for (const secret of ['sk-ant-api03', 'hunter2pass', 'abcdef123456789', 'SuperSecret99', 'another-secret', 'MIIEowIBAAKCAQEA', 'ghp_abc', 'AKIAABCDEFGHIJKLMNOP', 'zzzzzzzzzz']) {
    assert.doesNotMatch(digest.text, new RegExp(secret), secret);
  }
  assert.match(digest.text, /postgres:\/\/admin:\[REDACTED\]@db/);
  assert.match(digest.text, /\[REDACTED PRIVATE KEY\]/);
  assert.ok(digest.redactions >= 8);
});

test('redaction keeps ordinary code readable', () => {
  const code = [
    'const maxTokens = 4096;',
    'max_tokens: 4096',
    'const token = getToken();',
    'if (password.length < 8) return;',
    'token: abc',
    'export const SECRET_FILE_GLOBS: readonly string[] = [];',
    'tokensBefore: number;',
    'const PRIVATE_KEY_BLOCK = /-----BEGIN/g;',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'password: this.passwordField',
    'const secretRef = `${prefix}`;',
    'accessToken: Record<string, string>',
  ].join('\n');
  const result = redactSecrets(code);
  assert.equal(result.text, code);
  assert.equal(result.count, 0);
});

test('assignment-style secrets in env, YAML, and JSON are still redacted', () => {
  const result = redactSecrets('DB_PASSWORD=hunter2pass\npassword: hunter2pass\n"client_secret": "s3cr3t-value-xyz"\nGITHUB_TOKEN=abc123def456');
  assert.doesNotMatch(result.text, /hunter2pass|s3cr3t-value-xyz|abc123def456/);
  assert.equal(result.count, 4);
});

test('diagnostic redaction keeps its stricter short-value behaviour and gains token shapes', () => {
  const rendered = redactDiagnostic('token=abc password=pw ghp_abcdefghijklmnopqrstuvwxyz0123 ok');
  assert.doesNotMatch(rendered, /abc |pw |ghp_/);
  assert.match(rendered, /ok$/);
});

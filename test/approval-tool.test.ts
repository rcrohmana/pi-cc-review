import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApprovalTool } from '../src/approval-tool.ts';
import { approvalParametersSchema } from '../src/approval-schema.ts';
import { createApprovalStore } from '../src/approval-state.ts';
import { ReviewError } from '../src/types.ts';
import type { ApprovalSessionReader, ApprovedReviewResult, BranchEntry, ExecuteApprovedReview } from '../src/approval-types.ts';

function entry(id: string, role: string, content: unknown): BranchEntry {
  return { id, type: 'message', message: { role, content } };
}

function context(sessionId: string, branch: BranchEntry[], cwd: string) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    } satisfies ApprovalSessionReader,
  };
}

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'cc-approval-tool-'));
  await writeFile(join(cwd, 'spec.md'), '# spec');
  return cwd;
}

function text(result: { content: Array<{ type: 'text'; text: string }> }) {
  return result.content.map(part => part.text).join('');
}

function hasCode(...codes: string[]) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && codes.includes(String(error.code));
}

function toolHarness(options: {
  cwd: string;
  branch: BranchEntry[];
  sessionId?: string;
  now?: () => number;
  executeReview?: ExecuteApprovedReview;
}) {
  const calls: Array<{ canonicalTail: string; context: unknown }> = [];
  const executeReview = options.executeReview ?? (async (canonicalTail, executionContext) => {
    calls.push({ canonicalTail, context: executionContext });
    return { content: '# External review', details: { source: 'fake-review' }, raw: true } satisfies ApprovedReviewResult;
  });
  const store = createApprovalStore();
  const tool = createApprovalTool({
    store,
    now: options.now,
    idFactory: () => 'opaque-tool-id',
    executeReview,
  });
  return { tool, store, calls, context: context(options.sessionId ?? 'session-1', options.branch, options.cwd) };
}

async function request(harness: ReturnType<typeof toolHarness>) {
  return harness.tool.execute('call-1', { phase: 'request', mode: 'spec', file: 'spec.md', raw: true }, undefined, undefined, harness.context);
}

test('tool definition has the exact name and local schema', () => {
  const h = toolHarness({ cwd: process.cwd(), branch: [entry('source', 'user', 'review')] });
  assert.equal(h.tool.name, 'cc_review_approval');
  assert.equal(h.tool.label, 'CC Review Approval');
  assert.match(h.tool.description, /confirmation-gated|existing.*cc-review|never.*Claude/i);
  assert.equal(h.tool.parameters, approvalParametersSchema);
});

test('request stores and returns a bounded canonical command without executing', async () => {
  const cwd = await workspace();
  try {
    const h = toolHarness({ cwd, branch: [entry('source', 'user', 'Review this spec')] });
    const result = await request(h);
    assert.match(text(result), /\/cc-review spec --file/);
    assert.match(text(result), /yes.*ya.*lanjut.*approve/is);
    assert.equal(h.calls.length, 0);
    assert.equal(result.details?.requestId, 'opaque-tool-id');
    assert.equal(result.details?.canonicalCommand, '/cc-review spec --file "spec.md" --raw');
    assert.equal(h.store.getActive('session-1')?.canonicalCommand, result.details?.canonicalCommand);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('request canonicalizes a leading @ notebook mention without executing', async () => {
  const cwd = await workspace();
  const notebook = 'PVT_Calculator_Kunci_Jawaban.ipynb';
  try {
    await writeFile(join(cwd, notebook), '{}\n');
    const h = toolHarness({ cwd, branch: [entry('source', 'user', 'Review this notebook')] });
    const result = await h.tool.execute(
      'call-at-file',
      { phase: 'request', mode: 'spec', file: `@${notebook}` },
      undefined,
      undefined,
      h.context,
    );
    assert.equal(result.details?.canonicalCommand, `/cc-review spec --file "${notebook}"`);
    assert.equal(result.details?.targetKind, 'file');
    assert.equal(h.store.getActive('session-1')?.file, notebook);
    assert.equal(h.calls.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('request rejects public target and execute-only or unsupported fields', async () => {
  const cwd = await workspace();
  try {
    const h = toolHarness({ cwd, branch: [entry('source', 'user', 'Review this spec')] });
    for (const params of [
      { phase: 'request', target: cwd },
      { phase: 'request', command: '/cc-review repo' },
      { phase: 'request', approved: true },
      { phase: 'execute', requestId: 'x', mode: 'plan' },
      { phase: 'execute', requestId: 'x', target: cwd },
      { phase: 'request', mode: 'repo', file: 'spec.md' },
      { phase: 'request', mode: 'spec', base: 'main' },
    ]) {
      await assert.rejects(() => h.tool.execute('call', params as never, undefined, undefined, h.context), hasCode('CC_REVIEW_INVALID_OPTIONS', 'USAGE_ERROR'));
    }
    assert.equal(h.store.getActive('session-1'), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('execute invokes the stored canonical tail once and returns the actual review after one exact newer user reply', async () => {
  const cwd = await workspace();
  try {
    const branch = [entry('source', 'user', 'Review this spec')];
    const h = toolHarness({ cwd, branch });
    const requested = await request(h);
    branch.push(entry('assistant', 'assistant', 'Confirmation prompt says yes'), entry('tool', 'toolResult', 'yes'), entry('reply', 'user', ' YES. '));
    const result = await h.tool.execute('call-2', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context);
    assert.deepEqual(h.calls.map(call => call.canonicalTail), ['spec --file "spec.md" --raw']);
    assert.equal(h.calls[0]?.context, h.context);
    assert.equal(text(result), '# External review');
    assert.equal(result.details?.status, 'completed');
    assert.deepEqual(result.details?.review, { source: 'fake-review' });
    assert.equal(result.terminate, true);
    assert.equal(h.store.getById('opaque-tool-id')?.status, 'consumed');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('same-turn and replay execute never invoke the runner', async () => {
  const cwd = await workspace();
  try {
    const branch = [entry('source', 'user', 'Review this spec')];
    const h = toolHarness({ cwd, branch });
    const requested = await request(h);
    await assert.rejects(() => h.tool.execute('call-2', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('CC_REVIEW_APPROVAL_NO_NEW_USER'));
    branch.push(entry('reply', 'user', 'yes'));
    await h.tool.execute('call-3', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context);
    await assert.rejects(() => h.tool.execute('call-4', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('CC_REVIEW_REQUEST_REUSED', 'CC_REVIEW_REQUEST_NOT_FOUND'));
    assert.equal(h.calls.length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('wrong session, expiry, and more than one user reply fail closed', async () => {
  const cwd = await workspace();
  try {
    let now = 0;
    const branch = [entry('source', 'user', 'Review this spec')];
    const h = toolHarness({ cwd, branch, now: () => now });
    const requested = await request(h);
    const wrong = { ...h.context, sessionManager: { ...h.context.sessionManager, getSessionId: () => 'other-session' } };
    branch.push(entry('reply-1', 'user', 'yes'));
    await assert.rejects(() => h.tool.execute('wrong', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, wrong), hasCode('CC_REVIEW_SESSION_MISMATCH'));
    now = 300_000;
    await assert.rejects(() => h.tool.execute('expired', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('CC_REVIEW_REQUEST_EXPIRED'));

    const secondBranch = [entry('source-2', 'user', 'Review this spec')];
    const second = toolHarness({ cwd, branch: secondBranch });
    const secondRequest = await request(second);
    secondBranch.push(entry('reply-1', 'user', 'not yet'), entry('reply-2', 'user', 'yes'));
    await assert.rejects(() => second.tool.execute('stale', { phase: 'execute', requestId: secondRequest.details!.requestId }, undefined, undefined, second.context), hasCode('CC_REVIEW_APPROVAL_STALE', 'CC_REVIEW_REQUEST_NOT_FOUND'));
    assert.equal(second.calls.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('concurrent execute calls invoke the runner at most once after synchronous consume', async () => {
  const cwd = await workspace();
  try {
    const branch = [entry('source', 'user', 'Review this spec')];
    let resolveReview!: (result: ApprovedReviewResult) => void;
    let calls = 0;
    const executeReview: ExecuteApprovedReview = async () => new Promise(resolve => {
      calls++;
      resolveReview = resolve;
    });
    const h = toolHarness({ cwd, branch, executeReview });
    const requested = await request(h);
    branch.push(entry('reply', 'user', 'yes'));
    const first = h.tool.execute('first', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context);
    await assert.rejects(() => h.tool.execute('second', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('CC_REVIEW_REQUEST_REUSED'));
    assert.equal(calls, 1);
    resolveReview({ content: '# External review', details: {}, raw: true });
    await first;
    assert.equal(h.store.getById('opaque-tool-id')?.status, 'consumed');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('runner failures consume permanently without retry', async () => {
  const cwd = await workspace();
  try {
    for (const executeReview of [
      () => { throw new ReviewError('PROCESS_FAILED', 'safe execution failure'); },
      async () => { throw new ReviewError('PROCESS_FAILED', 'safe execution failure'); },
    ]) {
      const branch = [entry('source', 'user', 'Review this spec')];
      const h = toolHarness({ cwd, branch, executeReview });
      const requested = await request(h);
      branch.push(entry('reply', 'user', 'yes'));
      await assert.rejects(() => h.tool.execute('execute', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('PROCESS_FAILED'));
      assert.equal(h.store.getById('opaque-tool-id')?.status, 'failed');
      await assert.rejects(() => h.tool.execute('retry', { phase: 'execute', requestId: requested.details!.requestId }, undefined, undefined, h.context), hasCode('CC_REVIEW_REQUEST_REUSED'));
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('details are bounded and do not expose session or branch content', async () => {
  const cwd = await workspace();
  try {
    const secret = 'SESSION_SECRET_REPOSITORY_CONTENT';
    const h = toolHarness({ cwd, branch: [entry('source', 'user', secret)] });
    const result = await request(h);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /session-1/);
    assert.ok(serialized.length < 2_000);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('approval source has no synthetic user-message queue boundary', async () => {
  const source = await readFile(new URL('../src/approval-tool.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sendUserMessage|deliverAs: 'followUp'|Queued .*cc-review/);
  assert.match(source, /executeReview/);
});

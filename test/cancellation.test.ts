import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandHandler, registerExtension } from '../src/index.ts';
import { createApprovalTool } from '../src/approval-tool.ts';
import { createApprovalStore } from '../src/approval-state.ts';
import { runProcess } from '../src/process.ts';
import { ReviewError } from '../src/types.ts';
import type { ApprovedReviewResult, BranchEntry, ExecuteApprovedReview } from '../src/approval-types.ts';

const planEntries = [
  { message: { role: 'user', content: 'Review the rollout plan carefully.' } },
  { message: { role: 'assistant', content: 'P'.repeat(400) } },
];

function validPlanStream() {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'req', name: 'Agent', input: { subagent_type: 'requirements-critic' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'arch', name: 'Agent', input: { subagent_type: 'architecture-critic' } }] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review\n\n**Verdict:** APPROVE' }),
  ].join('\n');
}

function entry(id: string, role: string, content: unknown): BranchEntry {
  return { id, type: 'message', message: { role, content } };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ReviewError && error.code === code;
}

function fakeBundle() {
  const directory = join(tmpdir(), 'cc-cancel-bundle');
  return { directory, manifestPath: join(directory, 'manifest.md'), truncated: false, bytes: 1 };
}

function fakePi() {
  return {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.212 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: () => {},
  };
}

/** Fake runner that blocks until its signal aborts, mirroring runProcess cancellation. */
function abortableRun(onStart: (signal: AbortSignal | undefined) => void) {
  return async (_c: string, _a: string[], _cwd: string, _t: number, options: { signal?: AbortSignal }) => {
    onStart(options.signal);
    return new Promise((_resolve, reject) => {
      if (!options.signal) return reject(new Error('signal was not forwarded'));
      options.signal.addEventListener('abort', () => reject(new ReviewError('PROCESS_CANCELLED', 'Claude Code review cancelled.')), { once: true });
    });
  };
}

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'cc-cancel-'));
  await writeFile(join(cwd, 'spec.md'), '# spec');
  return cwd;
}

test('approval execute with an already-aborted signal never runs and does not consume approval', async () => {
  const cwd = await workspace();
  try {
    let calls = 0;
    const store = createApprovalStore();
    const tool = createApprovalTool({
      store,
      idFactory: () => 'cancel-id',
      executeReview: async () => { calls++; return { content: 'x', details: {}, raw: true }; },
    });
    const branch = [entry('source', 'user', 'Review this spec')];
    const ctx = { cwd, sessionManager: { getSessionId: () => 's', getBranch: () => branch } };
    const requested = await tool.execute('r', { phase: 'request', mode: 'spec', file: 'spec.md' }, undefined, undefined, ctx);
    branch.push(entry('reply', 'user', 'yes'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => tool.execute('e', { phase: 'execute', requestId: requested.details!.requestId }, controller.signal, undefined, ctx),
      hasCode('PROCESS_CANCELLED'),
    );
    assert.equal(calls, 0);
    assert.equal(store.getById('cancel-id')?.status, 'pending');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('approval execute forwards its tool signal to the review runner', async () => {
  const cwd = await workspace();
  try {
    let received: AbortSignal | undefined;
    const executeReview: ExecuteApprovedReview = async (_tail, _ctx, signal) => {
      received = signal;
      return { content: 'x', details: {}, raw: true } satisfies ApprovedReviewResult;
    };
    const tool = createApprovalTool({ store: createApprovalStore(), idFactory: () => 'fwd-id', executeReview });
    const branch = [entry('source', 'user', 'Review this spec')];
    const ctx = { cwd, sessionManager: { getSessionId: () => 's', getBranch: () => branch } };
    const requested = await tool.execute('r', { phase: 'request', mode: 'spec', file: 'spec.md' }, undefined, undefined, ctx);
    branch.push(entry('reply', 'user', 'yes'));
    const controller = new AbortController();
    await tool.execute('e', { phase: 'execute', requestId: requested.details!.requestId }, controller.signal, undefined, ctx);
    assert.equal(received, controller.signal);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const mode of ['rpc', 'print']) {
  test(`aborting the approval tool signal in ${mode} mode cancels Claude, cleans up, and releases the lock`, async () => {
    const tools: any[] = [];
    let cleanups = 0;
    let started!: () => void;
    const runStarted = new Promise<void>(resolve => { started = resolve; });
    const notifications: string[] = [];
    registerExtension({ ...fakePi(), registerTool: (tool: unknown) => tools.push(tool), registerCommand: () => {} } as any, {
      bundle: async () => fakeBundle(),
      cleanup: async () => { cleanups++; },
      run: abortableRun(() => started()),
    } as any);
    const branch = [entry('source', 'user', 'Review this plan')];
    const ctx = {
      cwd: process.cwd(),
      mode,
      hasUI: false,
      ui: { notify: (message: string) => notifications.push(message), custom: () => { throw new Error('custom UI forbidden'); } },
      sessionManager: { getSessionId: () => `s-${mode}`, getBranch: () => branch, buildContextEntries: () => planEntries },
    };
    const requested = await tools[0].execute('r', { phase: 'request', mode: 'plan' }, undefined, undefined, ctx);
    branch.push(entry('reply', 'user', 'yes'));
    const controller = new AbortController();
    const pending = tools[0].execute('e', { phase: 'execute', requestId: requested.details.requestId }, controller.signal, undefined, ctx);
    await runStarted;
    controller.abort();
    await assert.rejects(() => pending, hasCode('PROCESS_CANCELLED'));
    assert.equal(cleanups, 1);
    assert.ok(notifications.some(message => /PROCESS_CANCELLED/.test(message)));

    const retry = createCommandHandler(fakePi(), {
      bundle: async () => fakeBundle(),
      cleanup: async () => {},
      run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }),
    } as any);
    const completed = await retry('plan --raw', { ...ctx, sessionManager: { buildContextEntries: () => planEntries } } as any);
    assert.ok(completed, 'lock must be released after cancellation');
  });
}

test('external signal cancels the TUI run even when the panel was not escaped', async () => {
  let runSignal: AbortSignal | undefined;
  let panelSignal: AbortSignal | undefined;
  let started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  let cleanups = 0;
  const handler = createCommandHandler(fakePi(), {
    bundle: async () => fakeBundle(),
    cleanup: async () => { cleanups++; },
    run: abortableRun(signal => { runSignal = signal; started(); }),
  } as any);
  const controller = new AbortController();
  const notifications: string[] = [];
  const ctx: any = {
    cwd: process.cwd(),
    mode: 'tui',
    hasUI: true,
    signal: controller.signal,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (factory: any) => new Promise(resolve => {
        const view = factory({ requestRender() {} }, null, null, resolve);
        panelSignal = view.signal;
      }),
    },
    sessionManager: { buildContextEntries: () => planEntries },
  };
  const pending = handler('plan --raw', ctx);
  await runStarted;
  assert.notEqual(runSignal, panelSignal);
  controller.abort();
  await pending;
  assert.equal(runSignal?.aborted, true);
  assert.equal(panelSignal?.aborted, false);
  assert.equal(cleanups, 1);
  assert.match(notifications.at(-1) ?? '', /PROCESS_CANCELLED/);
});

test('direct handler with an already-aborted signal never starts Claude', async () => {
  let runs = 0;
  const handler = createCommandHandler(fakePi(), {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => { runs++; throw new Error('must not run'); },
  } as any);
  const controller = new AbortController();
  controller.abort();
  const notifications: string[] = [];
  const result = await handler('plan --raw', {
    cwd: process.cwd(),
    signal: controller.signal,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { buildContextEntries: () => planEntries },
  });
  assert.equal(result, undefined);
  assert.equal(runs, 0);
  assert.match(notifications.at(-1) ?? '', /PROCESS_CANCELLED/);
});

// Contract guard: an aborted signal always yields PROCESS_CANCELLED (the pre-spawn check is defense in depth).
test('runProcess rejects with PROCESS_CANCELLED when its signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runProcess('definitely-not-a-real-command-cc-review', [], process.cwd(), 1_000, { signal: controller.signal }),
    hasCode('PROCESS_CANCELLED'),
  );
});

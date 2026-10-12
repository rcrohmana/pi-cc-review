import test from 'node:test';
import assert from 'node:assert/strict';
import { registerExtension } from '../src/index.ts';
import { createAdvisorState, parseBudget } from '../src/advisor-state.ts';
import { findIssuingMessage, validateAdvisorParams } from '../src/advisor-tool.ts';
import { ReviewError } from '../src/types.ts';

const GUIDANCE = '# Advisor guidance\nVerdict: proceed\n## Recommendation\nKeep going.';

function stream(text = GUIDANCE) {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }),
  ].join('\n');
}

type Run = (...args: any[]) => Promise<any>;

function setup(run?: Run) {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let active = ['read', 'bash', 'cc_review_approval'];
  const activeHistory: string[][] = [];
  let runs = 0;
  const signals: Array<AbortSignal | undefined> = [];
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.296 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: () => {},
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    on: (event: string, handler: any) => handlers.set(event, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; activeHistory.push([...names]); },
  };
  registerExtension(pi as any, {
    gitSummary: async () => undefined,
    cleanup: async () => {},
    run: run ?? (async (_c: string, _a: string[], _cwd: string, _t: number, options: any) => {
      runs++;
      signals.push(options.signal);
      return { code: 0, stdout: stream(), stderr: '', timedOut: false, durationMs: 1 };
    }),
  } as any);
  const tool = tools.find(item => item.name === 'cc_advise');
  const notifications: Array<{ message: string; level?: string }> = [];
  const commandCtx = (sessionId = 'session-A') => ({
    cwd: process.cwd(),
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => sessionId, buildContextEntries: () => [] },
  });
  const advisor = (input: string, sessionId = 'session-A') => commands.get('cc-advisor').handler(input, commandCtx(sessionId));
  const toolCtx = (sessionId = 'session-A', branch: unknown[] = []) => ({
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, buildContextEntries: () => [] },
  });
  const call = (id: string, params: unknown = { question: 'Is this the right approach?' }, ctx: any = toolCtx(), signal?: AbortSignal) =>
    tool.execute(id, params, signal, undefined, ctx);
  return {
    tool, commands, handlers, notifications, advisor, call, toolCtx,
    get active() { return active; },
    get runs() { return runs; },
    activeHistory, signals,
  };
}

const rejectsWith = (code: string) => (error: unknown) => error instanceof Error && error.message.startsWith(`[${code}]`);

test('cc_advise is registered inactive, read-only annotated, and strictly parameterised', () => {
  const h = setup();
  assert.equal(h.tool.defaultActive, false);
  assert.equal(h.active.includes('cc_advise'), false);
  assert.deepEqual(h.tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(h.tool.executionMode, 'sequential');
  assert.deepEqual(h.tool.parameters.required, ['question']);
  assert.equal(h.tool.parameters.additionalProperties, false);
  assert.equal(h.tool.parameters.oneOf, undefined);
});

test('without a grant the tool never starts Claude', async () => {
  const h = setup();
  await assert.rejects(() => h.call('c1'), rejectsWith('CC_ADVISOR_NOT_ENABLED'));
  assert.equal(h.runs, 0);
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /CC advisor off/);
});

test('/cc-advisor on activates the tool with the default budget and a cost notice', async () => {
  const h = setup();
  await h.advisor('on');
  assert.ok(h.active.includes('cc_advise'));
  assert.deepEqual(h.active.filter(name => name !== 'cc_advise'), ['read', 'bash', 'cc_review_approval'], 'other active tools are preserved');
  const notice = h.notifications.at(-1)!.message;
  assert.match(notice, /CC advisor on \(fable, high effort, 3 consultations this session\)/);
  assert.match(notice, /usage credits/);
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /3 of 3 consultations left/);
  await h.advisor('on');
  assert.equal(h.active.filter(name => name === 'cc_advise').length, 1, 'activation is idempotent');
});

test('--max bounds are enforced and invalid input never activates', async () => {
  for (const input of ['on --max 0', 'on --max 11', 'on --max abc', 'on --max', 'on extra', 'off now', 'enable']) {
    const h = setup();
    await h.advisor(input);
    assert.equal(h.active.includes('cc_advise'), false, input);
    assert.match(h.notifications.at(-1)!.message, /^\[USAGE_ERROR\]/, input);
  }
  assert.equal(parseBudget(undefined), 3);
  assert.equal(parseBudget('10'), 10);
  assert.throws(() => parseBudget('1.5'), ReviewError);
});

test('each consultation consumes budget; exhaustion revokes the grant and deactivates the tool', async () => {
  const h = setup();
  await h.advisor('on --max 2');
  const first = await h.call('c1');
  assert.match(first.content[0].text, /Advisor verdict: \*\*proceed\*\*/);
  assert.match(first.content[0].text, /Advisor consultations remaining: 1 of 2\./);
  assert.equal(first.details.kind, 'cc-advise');
  assert.equal(first.details.verdict, 'proceed');
  assert.equal(first.details.remaining, 1);
  assert.ok(h.active.includes('cc_advise'));

  const second = await h.call('c2');
  assert.match(second.content[0].text, /budget is now used up/);
  assert.equal(h.active.includes('cc_advise'), false);
  await assert.rejects(() => h.call('c3'), rejectsWith('CC_ADVISOR_NOT_ENABLED'));
  assert.equal(h.runs, 2);
});

test('failed consultations are not refunded', async () => {
  let runs = 0;
  const h = setup(async () => { runs++; throw new ReviewError('PROCESS_FAILED', 'boom'); });
  await h.advisor('on --max 2');
  await assert.rejects(() => h.call('c1'), rejectsWith('PROCESS_FAILED'));
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /1 of 2 consultations left/);
  await assert.rejects(() => h.call('c2'), rejectsWith('PROCESS_FAILED'));
  assert.equal(h.active.includes('cc_advise'), false);
  assert.equal(runs, 2);
});

test('the grant is bound to the session that created it', async () => {
  const h = setup();
  await h.advisor('on', 'session-A');
  await assert.rejects(() => h.call('c1', undefined, h.toolCtx('session-B')), rejectsWith('CC_ADVISOR_NOT_ENABLED'));
  await h.advisor('status', 'session-B');
  assert.match(h.notifications.at(-1)!.message, /CC advisor off/);
  assert.equal(h.runs, 0);
});

test('only one consultation per assistant message', async () => {
  const h = setup();
  await h.advisor('on --max 5');
  const branch = [{ id: 'assistant-1', type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'c1', name: 'cc_advise', arguments: {} },
    { type: 'toolCall', id: 'c2', name: 'cc_advise', arguments: {} },
  ] } }];
  await h.call('c1', undefined, h.toolCtx('session-A', branch));
  await assert.rejects(() => h.call('c2', undefined, h.toolCtx('session-A', branch)), rejectsWith('CC_ADVISOR_RATE_LIMITED'));
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /4 of 5 consultations left/, 'rate-limited call is not charged');
  assert.equal(findIssuingMessage(branch as any, 'c2'), 'assistant-1');
  assert.equal(findIssuingMessage(branch as any, 'missing'), undefined);
});

test('a busy Claude lock rejects without consuming budget', async () => {
  let release!: () => void;
  let started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  const h = setup(async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return { code: 0, stdout: stream(), stderr: '', timedOut: false, durationMs: 1 };
  });
  await h.advisor('on --max 3');
  const first = h.call('c1');
  await runStarted;
  await assert.rejects(() => h.call('c2'), rejectsWith('ALREADY_RUNNING'));
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /2 of 3 consultations left/);
  release();
  await first;
});

test('invalid parameters are rejected before any reservation', async () => {
  const h = setup();
  await h.advisor('on --max 1');
  for (const params of [{}, { question: '' }, { question: '   ' }, { question: 'x'.repeat(2_001) }, { question: 'ok', extra: 1 }, { question: 'ok', focus: '' }, null]) {
    await assert.rejects(() => h.call('c', params), rejectsWith('CC_ADVISOR_INVALID_OPTIONS'));
  }
  await h.advisor('status');
  assert.match(h.notifications.at(-1)!.message, /1 of 1 consultations left/);
  assert.deepEqual(validateAdvisorParams({ question: 'q', focus: 'f' }), { question: 'q', focus: 'f' });
});

test('session boundaries and /cc-advisor off revoke the grant and deactivate the tool', async () => {
  for (const reset of ['session_start', 'off'] as const) {
    const h = setup();
    await h.advisor('on');
    assert.ok(h.active.includes('cc_advise'));
    if (reset === 'off') await h.advisor('off');
    else await h.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, {});
    assert.equal(h.active.includes('cc_advise'), false, reset);
    await assert.rejects(() => h.call('c1'), rejectsWith('CC_ADVISOR_NOT_ENABLED'));
  }
  const h = setup();
  await h.advisor('on');
  await h.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, {});
  await assert.rejects(() => h.call('c1'), rejectsWith('CC_ADVISOR_NOT_ENABLED'));
});

test('the tool abort signal reaches the Claude process', async () => {
  const h = setup();
  await h.advisor('on');
  const controller = new AbortController();
  await h.call('c1', undefined, h.toolCtx(), controller.signal);
  assert.equal(h.signals[0], controller.signal);
});

test('advisor state unit: reserve checks order and session binding', () => {
  const state = createAdvisorState(() => 42);
  assert.throws(() => state.reserve('s', undefined), /not enabled/);
  const grant = state.grant('s', 1);
  assert.equal(grant.grantedAt, 42);
  assert.deepEqual(state.reserve('s', 'm1'), { remaining: 0, total: 1 });
  assert.throws(() => state.reserve('s', 'm2'), /used up/);
  assert.equal(state.current('other'), undefined);
  assert.throws(() => state.grant('', 1), /identity is unavailable/);
});

test('cc_advise carries its consultation guidelines (system prompt only while active)', () => {
  const h = setup();
  assert.ok(Array.isArray(h.tool.promptGuidelines) && h.tool.promptGuidelines.length >= 4);
  const text = h.tool.promptGuidelines.join('\n');
  assert.match(text, /decision points/);
  assert.match(text, /before writing the implementation, not after/);
  assert.match(text, /Do not call it on every turn/);
  assert.match(text, /verify it against files and test results/);
  assert.match(text, /stop verdict means pause and consult the user/);
  assert.match(text, /not a substitute for a full review/);
});

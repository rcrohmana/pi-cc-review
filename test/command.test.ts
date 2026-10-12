import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { createCommandHandler, registerExtension } from '../src/index.ts';
import { ReviewError } from '../src/types.ts';

const planEntries = [
  { message: { role: 'user', content: 'Review the rollout plan carefully.' } },
  { message: { role: 'assistant', content: 'P'.repeat(400) } },
];

function agentCall(name: string, id = `call-${name}`, isError = false) {
  return [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: name } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? `Agent type '${name}' not found.` : 'review done' }] } }),
  ];
}

function validPlanStream() {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
    ...agentCall('requirements-critic', 'req'),
    ...agentCall('architecture-critic', 'arch'),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'req', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'assistant', message: { parent_tool_use_id: 'arch', model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review\n\n**Verdict:** APPROVE' }),
  ].join('\n');
}

function harness(entries = planEntries) {
  const notifications: Array<{ message: string; level: string }> = [];
  const sent: Array<{ message: any; options: any }> = [];
  let execCount = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      execCount++;
      return args[0] === '--version'
        ? { code: 0, stdout: '2.1.212 (Claude Code)', stderr: '' }
        : { code: 0, stdout: 'loggedIn: true', stderr: '' };
    },
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { buildContextEntries: () => entries },
  };
  return { pi, ctx, notifications, sent, get execCount() { return execCount; } };
}

function fakeBundle(path = join(tmpdir(), 'cc-command-bundle')) {
  return { directory: path, manifestPath: join(path, 'manifest.md'), truncated: false, bytes: 100 };
}

test('extension registers exactly one approval tool and the explicit slash command', () => {
  const commands: Array<{ name: string; definition: any }> = [];
  const tools: any[] = [];
  extension({
    registerCommand: (name: string, definition: any) => commands.push({ name, definition }),
    registerTool: (definition: any) => tools.push(definition),
    on: () => { throw new Error('must not register lifecycle handlers'); },
  } as any);
  assert.equal(commands.length, 1);
  assert.equal(tools.length, 1);
  assert.equal(commands[0].name, 'cc-review');
  assert.equal(tools[0].name, 'cc_review_approval');
  assert.equal(typeof commands[0].definition.handler, 'function');
  assert.equal(typeof tools[0].execute, 'function');
});

test('registered approval tool runs the shared TUI workflow and returns the actual report', async () => {
  const branch = [{ id: 'source', type: 'message', message: { role: 'user', content: 'Review this plan' } }];
  const notifications: Array<{ message: string; level: string }> = [];
  const sent: unknown[] = [];
  const tools: any[] = [];
  const commands: any[] = [];
  let customCalls = 0;
  let runCalls = 0;
  let cleanupCalls = 0;
  let userMessageCalls = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.212 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: (message: unknown) => sent.push(message),
    sendUserMessage: () => { userMessageCalls++; },
    registerTool: (tool: unknown) => tools.push(tool),
    registerCommand: (_name: string, command: unknown) => commands.push(command),
  };
  const toolContext = {
    cwd: process.cwd(),
    mode: 'tui',
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      custom: (factory: any) => new Promise(resolve => {
        customCalls++;
        factory({ requestRender() {} }, null, null, resolve);
      }),
    },
    sessionManager: {
      getSessionId: () => 'tool-session',
      getBranch: () => branch,
      buildContextEntries: () => planEntries,
    },
  };
  registerExtension(pi as any, {
    bundle: async () => fakeBundle(),
    cleanup: async () => { cleanupCalls++; },
    run: async (_: string, __: string[], ___: string, ____: number, options: any) => {
      runCalls++;
      for (const line of validPlanStream().split('\n')) options.onStdoutLine(line);
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 7 };
    },
  } as any);

  const tool = tools[0];
  const requested = await tool.execute('request', { phase: 'request', mode: 'plan' }, undefined, undefined, toolContext);
  branch.push({ id: 'approved', type: 'message', message: { role: 'user', content: 'yes' } });
  const completed = await tool.execute('execute', { phase: 'execute', requestId: requested.details.requestId }, undefined, undefined, toolContext);

  assert.equal(commands.length, 1);
  assert.equal(customCalls, 1);
  assert.equal(runCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(sent.length, 0);
  assert.equal(userMessageCalls, 0);
  assert.match(completed.content[0].text, /external, untrusted review data/i);
  assert.equal(completed.details.status, 'completed');
  assert.equal(completed.details.review.mode, 'plan');
  assert.equal(completed.terminate, undefined);
  assert.ok(notifications.some(item => /Starting Claude Code plan review/.test(item.message)));
});

test('approval modules have no process/lifecycle access and index owns registration', async () => {
  const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal((indexSource.match(/pi\.registerTool\(/g) ?? []).length, 1);
  assert.equal((indexSource.match(/pi\.registerCommand\(/g) ?? []).length, 1);
  const files = ['approval-types.ts', 'approval-schema.ts', 'approval-canonical.ts', 'approval-state.ts', 'approval-tool.ts'];
  const sources = await Promise.all(files.map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
  const approvalSource = sources.join('\n');
  assert.equal((approvalSource.match(/registerTool\(/g) ?? []).length, 0);
  assert.doesNotMatch(approvalSource, /pi\.on\(|pi\.exec\(|spawn\(|runProcess\(|createBundle\(|fetch\(/);
  assert.doesNotMatch(approvalSource, /bypassPermissions|--bare|dangerously/);
  assert.doesNotMatch(approvalSource, /sendUserMessage|deliverAs: 'followUp'|Queued .*cc-review/);
  assert.match(approvalSource, /executeReview/);
});

test('help short-circuits before preflight, bundle creation, or Claude process', async () => {
  const h = harness();
  let runs = 0;
  let bundles = 0;
  const handler = createCommandHandler(h.pi, {
    run: async () => { runs++; throw new Error('must not run'); },
    bundle: async () => { bundles++; return fakeBundle(); },
  } as any);

  await handler('--help', h.ctx);

  assert.equal(h.execCount, 0);
  assert.equal(runs, 0);
  assert.equal(bundles, 0);
  assert.match(h.notifications[0]?.message ?? '', /cc-review/);
});

test('invalid file modes fail before preflight, bundle creation, or Claude process', async () => {
  for (const mode of ['code', 'repo', 'auto']) {
    const h = harness();
    let bundles = 0;
    let runs = 0;
    const handler = createCommandHandler(h.pi, {
      bundle: async () => { bundles++; return fakeBundle(); },
      run: async () => { runs++; throw new Error('must not run'); },
    } as any);

    await handler(`${mode} --file evidence.md`, h.ctx);

    assert.equal(h.execCount, 0, `${mode} must fail before preflight`);
    assert.equal(bundles, 0);
    assert.equal(runs, 0);
    assert.equal(h.sent.length, 0);
    assert.match(h.notifications.at(-1)?.message ?? '', /\[USAGE_ERROR\].*only valid for plan or spec/i);
  }
});

test('raw review uses native fake Agent events and injects complete metadata without triggering Pi', async () => {
  const h = harness();
  const cleanupCalls: string[] = [];
  let argv: string[] = [];
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async (directory: string) => { cleanupCalls.push(directory); },
    run: async (_command: string, args: string[]) => {
      argv = args;
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 42 };
    },
  } as any);

  await handler('plan --raw', h.ctx);

  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false, deliverAs: 'followUp' });
  assert.equal(h.sent[0].message.display, true);
  assert.match(h.sent[0].message.content, /external, untrusted review data/i);
  assert.deepEqual(h.sent[0].message.details, {
    source: 'claude-code',
    explicitInvocation: true,
    mode: 'plan',
    requiredAgents: ['requirements-critic', 'architecture-critic'],
    invokedAgents: ['requirements-critic', 'architecture-critic'],
    completedAgents: ['requirements-critic', 'architecture-critic'],
    validDelegation: true,
    claudeVersion: '2.1.212 (Claude Code)',
    coordinatorModel: 'fable',
    reviewerModel: 'sonnet',
    observedCoordinatorModel: 'claude-fable-5',
    observedModels: ['claude-fable-5', 'claude-sonnet-4-6'],
    coordinatorModelVerified: true,
    reviewerModels: { 'requirements-critic': ['claude-sonnet-4-6'], 'architecture-critic': ['claude-sonnet-4-6'] },
    reviewerModelVerified: true,
    deep: false,
    durationMs: 42,
    bundleTruncated: false,
    bundleRetained: false,
    stopHookFired: false,
    stopHookBlocks: 0,
  });
  assert.ok(!argv.includes('--safe-mode')); assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  assert.ok(argv.includes('--agents'));
  assert.equal(cleanupCalls.length, 1);
});

test('return delivery uses the shared TUI workflow and returns the review without Pi injection', async () => {
  const h = harness();
  let customCalls = 0;
  let cleanupCalls = 0;
  let view: any;
  const ctx: any = {
    ...h.ctx,
    mode: 'tui',
    hasUI: true,
    ui: {
      ...h.ctx.ui,
      custom: (factory: any) => new Promise(resolve => {
        customCalls++;
        view = factory({ requestRender() {} }, null, null, resolve);
      }),
    },
  };
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => { cleanupCalls++; },
    run: async (_: string, __: string[], ___: string, ____: number, options: any) => {
      for (const line of validPlanStream().split('\n')) options.onStdoutLine(line);
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 42 };
    },
  } as any, { delivery: 'return', rethrow: true });

  const completed = await handler('plan --raw', ctx);

  assert.equal(customCalls, 1);
  assert.ok(view);
  assert.equal(cleanupCalls, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(completed?.raw, true);
  assert.match(completed?.content ?? '', /external, untrusted review data/i);
  assert.equal(completed?.details.mode, 'plan');
  assert.match(completed?.completionNotice ?? '', /completed/);
});

test('return delivery rethrows bounded failure and releases the shared lock', async () => {
  const h = harness();
  let cleanupCalls = 0;
  let runs = 0;
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => { cleanupCalls++; },
    run: async () => {
      runs++;
      if (runs === 1) return { code: 1, stdout: '', stderr: 'safe failure', timedOut: false, durationMs: 1 };
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 };
    },
  } as any, { delivery: 'return', rethrow: true });

  await assert.rejects(() => handler('plan', h.ctx), (error: unknown) => error instanceof ReviewError && error.code === 'PROCESS_FAILED');
  const retry = await handler('plan --raw', h.ctx);
  assert.equal(runs, 2);
  assert.equal(cleanupCalls, 2);
  assert.equal(h.sent.length, 0);
  assert.equal(retry?.raw, true);
  assert.ok(h.notifications.some(item => /PROCESS_FAILED/.test(item.message)));
});

test('command fails closed when coordinator model evidence is missing or mismatched', async () => {
  const cases = [
    {
      expectedCode: 'COORDINATOR_MODEL_UNVERIFIED',
      stream: validPlanStream().split('\n').slice(1).join('\n'),
    },
    {
      expectedCode: 'COORDINATOR_MODEL_MISMATCH',
      stream: validPlanStream().replace('claude-fable-5', 'claude-opus-4-6'),
    },
  ];

  for (const item of cases) {
    const h = harness();
    const handler = createCommandHandler(h.pi, {
      bundle: async () => fakeBundle(),
      cleanup: async () => {},
      run: async () => ({ code: 0, stdout: item.stream, stderr: '', timedOut: false, durationMs: 1 }),
    } as any);

    await handler('plan --raw', h.ctx);

    assert.equal(h.sent.length, 0);
    assert.match(h.notifications.at(-1)?.message ?? '', new RegExp(item.expectedCode));
  }
});

test('reviewer model remains explicitly unverified when Sonnet is not observed', async () => {
  const h = harness();
  const stream = validPlanStream().split('\n')
    .filter(line => !line.includes('claude-sonnet'))
    .join('\n');
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: stream, stderr: '', timedOut: false, durationMs: 1 }),
  } as any);

  await handler('plan --raw', h.ctx);

  assert.equal(h.sent[0]?.message.details.coordinatorModelVerified, true);
  assert.equal(h.sent[0]?.message.details.reviewerModelVerified, false);
  assert.deepEqual(h.sent[0]?.message.details.observedModels, ['claude-fable-5']);
});

test('repo uses only bounded folder evidence and bundle cwd', async () => {
  const h = harness([]); let gitCalls = 0; let cleanupCalls = 0; let argv: string[] = []; let runCwd = ''; let captured: any;
  const stream = (names: string[]) => [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
    ...names.flatMap(name => agentCall(name)),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, {
    git: async () => { gitCalls++; throw new Error('must not use git'); },
    folder: async () => ({ root: h.ctx.cwd, artifact: '# snapshot', truncated: false, includedFiles: 1, excludedFiles: 0 }),
    bundle: async (data: any) => { captured = data; return fakeBundle('C:/tmp/repo-bundle'); },
    cleanup: async () => { cleanupCalls++; },
    run: async (_command: string, args: string[], cwd: string) => { argv = args; runCwd = cwd; return { code: 0, stdout: stream(['correctness-reviewer', 'test-reviewer']), stderr: '', timedOut: false, durationMs: 1 }; },
  } as any);
  await handler('repo --raw', h.ctx);
  assert.equal(gitCalls, 0); assert.equal(captured.mode, 'repo'); assert.equal(captured.artifact, '# snapshot'); assert.equal(runCwd, 'C:/tmp/repo-bundle'); assert.equal(cleanupCalls, 1);
  assert.deepEqual(h.sent[0]?.options, { triggerTurn: false, deliverAs: 'followUp' });
  assert.equal(h.sent[0]?.message.details.mode, 'repo'); assert.deepEqual(h.sent[0]?.message.details.requiredAgents, ['correctness-reviewer', 'test-reviewer']); assert.deepEqual(h.sent[0]?.message.details.invokedAgents, ['correctness-reviewer', 'test-reviewer']); assert.equal(h.sent[0]?.message.details.validDelegation, true); assert.equal(h.sent[0]?.message.details.coordinatorModel, 'fable'); assert.equal(h.sent[0]?.message.details.reviewerModel, 'sonnet'); assert.equal(h.sent[0]?.message.details.bundleRetained, false);
  assert.ok(!argv.includes('--safe-mode')); assert.equal(argv[argv.indexOf('--setting-sources') + 1], ''); assert.ok(argv.includes('fable')); assert.ok(argv.includes('high')); assert.ok(argv.includes('Agent,Read,Grep,Glob')); assert.ok(argv.includes('Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch,mcp__*'));
});

test('deep repo requires security reviewer and uses 18 turns', async () => {
  const h = harness([]); let argv: string[] = [];
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
    ...['correctness-reviewer', 'test-reviewer', 'security-reviewer'].flatMap(name => agentCall(name)),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, { folder: async () => ({ artifact: 'snapshot', truncated: false }), bundle: async () => fakeBundle(), cleanup: async () => {}, run: async (_: string, args: string[]) => { argv = args; return { code: 0, stdout: stream, stderr: '', timedOut: false, durationMs: 1 }; } } as any);
  await handler('repo --deep --raw', h.ctx);
  assert.deepEqual(h.sent[0]?.message.details.requiredAgents, ['correctness-reviewer', 'test-reviewer', 'security-reviewer']); assert.deepEqual(h.sent[0]?.message.details.invokedAgents, ['correctness-reviewer', 'test-reviewer', 'security-reviewer']); assert.equal(argv[argv.indexOf('--max-turns') + 1], '24');
});

test('repo missing native reviewer fails closed without injecting a result', async () => {
  const h = harness([]);
  const incomplete = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } }] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, { folder: async () => ({ artifact: 'snapshot', truncated: false }), bundle: async () => fakeBundle(), cleanup: async () => {}, run: async () => ({ code: 0, stdout: incomplete, stderr: '', timedOut: false, durationMs: 1 }) } as any);
  await handler('repo --raw', h.ctx);
  assert.equal(h.sent.length, 0); assert.match(h.notifications.at(-1)?.message ?? '', /REQUIRED_AGENTS_MISSING/);
});

test('TUI success mounts once, streams native events, validates, and cleans once', async () => {
  const h = harness(); let customCalls = 0; let cleanupCalls = 0; let view: any;
  const ctx: any = { ...h.ctx, mode: 'tui', hasUI: true, ui: { ...h.ctx.ui, custom: (factory: any) => new Promise(resolve => { view = factory({ requestRender() {} }, null, null, resolve); }) } };
  const handler = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => { cleanupCalls++; }, run: async (_: string, __: string[], ___: string, ____: number, options: any) => { customCalls++; assert.ok(options.signal); for (const line of validPlanStream().split('\n')) options.onStdoutLine(line); return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }; } } as any);
  await handler('plan --raw', ctx);
  assert.equal(customCalls, 1); assert.ok(view); assert.equal(h.sent.length, 1); assert.equal(cleanupCalls, 1);
});

test('TUI escape returns typed cancellation, cleans, and releases the lock', async () => {
  const h = harness(); let cleanupCalls = 0;
  const tuiCtx: any = { ...h.ctx, mode: 'tui', hasUI: true, ui: { ...h.ctx.ui, custom: (factory: any) => new Promise(resolve => { const view = factory({ requestRender() {} }, null, null, resolve); queueMicrotask(() => { view.handleInput('\u001b'); assert.equal(view.signal.aborted, false); view.handleInput('\u001b'); }); }) } };
  const cancelled = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => { cleanupCalls++; }, run: async (_: string, __: string[], ___: string, ____: number, options: any) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new ReviewError('PROCESS_CANCELLED', 'Claude Code review cancelled.')))) } as any);
  await cancelled('plan --raw', tuiCtx); assert.equal(h.sent.length, 0); assert.equal(cleanupCalls, 1); assert.match(h.notifications.at(-1)?.message ?? '', /PROCESS_CANCELLED/);
  const retry = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => {}, run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }) } as any); await retry('plan --raw', h.ctx); assert.equal(h.sent.length, 1);
});

test('RPC and print modes never request custom UI', async () => {
  for (const mode of ['rpc', 'print']) { const h = harness(); const ctx: any = { ...h.ctx, mode, hasUI: false, ui: { ...h.ctx.ui, custom: () => { throw new Error('custom UI forbidden'); } } }; const handler = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => {}, run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }) } as any); await handler('plan --raw', ctx); assert.equal(h.sent.length, 1); }
});

const streamHeartbeatRun = async (_: string, __: string[], ___: string, ____: number, options: any) => {
  for (const line of validPlanStream().split('\n')) options.onStdoutLine(line);
  return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 };
};

test('non-TUI runs emit ordered plain-text reviewer heartbeats and a synthesis line', async () => {
  const h = harness();
  const ctx: any = { ...h.ctx, mode: 'rpc', hasUI: false, ui: { ...h.ctx.ui, custom: () => { throw new Error('custom UI forbidden'); } } };
  const handler = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => {}, run: streamHeartbeatRun } as any);

  await handler('plan --raw', ctx);

  const heartbeats = h.notifications
    .map(item => item.message)
    .filter(message => message.startsWith('Reviewer ') || message === 'All reviewers invoked; reconciling evidence…');
  assert.deepEqual(heartbeats, [
    'Reviewer requirements-critic invoked (1/2).',
    'Reviewer architecture-critic invoked (2/2).',
    'All reviewers invoked; reconciling evidence…',
  ]);
  assert.equal(heartbeats.some(message => message.startsWith('[')), false);
});

test('TUI progress path emits none of the plain-text heartbeat strings', async () => {
  const h = harness();
  const ctx: any = { ...h.ctx, mode: 'tui', hasUI: true, ui: { ...h.ctx.ui, custom: (factory: any) => new Promise(resolve => { factory({ requestRender() {} }, null, null, resolve); }) } };
  const handler = createCommandHandler(h.pi, { bundle: async () => fakeBundle(), cleanup: async () => {}, run: streamHeartbeatRun } as any);

  await handler('plan --raw', ctx);

  assert.equal(h.notifications.some(item => item.message.startsWith('Reviewer ')), false);
  assert.equal(h.notifications.some(item => item.message === 'All reviewers invoked; reconciling evidence…'), false);
});

test('standard review triggers a Pi follow-up', async () => {
  const h = harness();
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);

  await handler('plan', h.ctx);

  assert.deepEqual(h.sent[0]?.options, { triggerTurn: true, deliverAs: 'followUp' });
});

test('missing native reviewer rejects the result and does not inject it', async () => {
  const h = harness();
  const incomplete = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'requirements-critic' } }] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: incomplete, stderr: '', timedOut: false, durationMs: 1 }),
  } as any);

  await handler('plan', h.ctx);

  assert.equal(h.sent.length, 0);
  assert.match(h.notifications.at(-1)?.message ?? '', /REQUIRED_AGENTS_MISSING/);
  assert.match(h.notifications.at(-1)?.message ?? '', /Observed native Agent calls: requirements-critic.*stream\.ndjson/);
});

test('overlapping invocation is rejected while preserving the active run', async () => {
  const first = harness();
  const second = harness();
  let resolveRun!: (value: any) => void;
  let runCount = 0;
  const pending = new Promise(resolve => { resolveRun = resolve; });
  const handler = createCommandHandler(first.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => { runCount++; return pending as any; },
  } as any);

  const active = handler('plan', first.ctx);
  await new Promise(resolve => setTimeout(resolve, 10));
  await handler('plan', second.ctx);
  await handler('--help', second.ctx);
  const third = handler('plan', second.ctx);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runCount, 1);
  resolveRun({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 });
  await Promise.all([active, third]);

  assert.equal(
    second.notifications.filter(item => item.message.includes('ALREADY_RUNNING')).length,
    2,
  );
  assert.equal(first.sent.length, 1);
});

test('timeout cleans the bundle and releases the running lock', async () => {
  const h = harness();
  const cleaned: string[] = [];
  let attempts = 0;
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(join(tmpdir(), `cc-timeout-${attempts}`)),
    cleanup: async (directory: string) => { cleaned.push(directory); },
    run: async () => {
      attempts++;
      if (attempts === 1) return { code: null, stdout: '', stderr: '', timedOut: true, durationMs: 5 };
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 5 };
    },
  } as any);

  await handler('plan', h.ctx);
  await handler('plan', h.ctx);

  assert.equal(attempts, 2);
  assert.equal(cleaned.length, 2);
  assert.equal(h.sent.length, 1);
  assert.ok(h.notifications.some(item => item.message.includes('PROCESS_TIMEOUT')));
  assert.ok(h.notifications.some(item => item.message.includes('Try --focus or a smaller --base range')));
});

test('auto mode falls back only for non-repo or clean-repo outcomes', async () => {
  const h = harness();
  let runs = 0;
  const planFallback = createCommandHandler(h.pi, {
    git: async () => { const error: any = new Error('clean'); error.code = 'NO_CODE_CHANGES'; throw error; },
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => {
      runs++;
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 };
    },
  } as any);
  await planFallback('', h.ctx);
  assert.equal(runs, 1);
  assert.equal(h.sent[0]?.message.details.mode, 'plan');
  assert.ok(h.notifications.some(item => item.message === 'No reviewable Git changes — falling back to plan review.'));

  const failed = harness();
  const timeout = createCommandHandler(failed.pi, {
    git: async () => { const error: any = new Error('git timed out'); error.code = 'PROCESS_TIMEOUT'; throw error; },
    run: async () => { runs++; throw new Error('must not run'); },
  } as any);
  await timeout('', failed.ctx);
  assert.equal(runs, 1);
  assert.match(failed.notifications.at(-1)?.message ?? '', /PROCESS_TIMEOUT/);
});

test('auto with --base surfaces the Git error instead of falling back to plan', async () => {
  const h = harness();
  let runs = 0;
  const handler = createCommandHandler(h.pi, {
    git: async () => { const error: any = new Error('clean'); error.code = 'NO_CODE_CHANGES'; throw error; },
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => { runs++; return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }; },
  } as any);

  await handler('auto --base main', h.ctx);

  assert.equal(runs, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.notifications.some(item => item.message.includes('falling back to plan')), false);
  assert.match(h.notifications.at(-1)?.message ?? '', /NO_CODE_CHANGES/);
});

test('Pi injection failure is distinct, cleans evidence, and releases the lock', async () => {
  const h = harness();
  h.pi.sendMessage = () => { throw new Error('session unavailable'); };
  let cleanupCalls = 0;
  let runs = 0;
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => { cleanupCalls++; },
    run: async () => {
      runs++;
      return { code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 };
    },
  } as any);

  await handler('plan', h.ctx);
  h.pi.sendMessage = (message: any, options: any) => h.sent.push({ message, options });
  await handler('plan --raw', h.ctx);

  assert.equal(runs, 2);
  assert.equal(cleanupCalls, 2);
  assert.match(h.notifications.find(item => item.message.includes('PI_INJECTION_FAILED'))?.message ?? '', /PI_INJECTION_FAILED/);
  assert.equal(h.sent.length, 1);
});

test('keep-bundle retains evidence and reports its path', async () => {
  const h = harness();
  let cleanupCalls = 0;
  const path = join(tmpdir(), 'cc-retained-bundle');
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(path),
    cleanup: async () => { cleanupCalls++; },
    run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);

  await handler('plan --keep-bundle --raw', h.ctx);

  assert.equal(cleanupCalls, 0);
  assert.equal(h.sent[0]?.message.details.bundleRetained, true);
  assert.equal(h.sent[0]?.message.details.bundlePath, path);
});

test('supplied file is byte-bounded and does not require an assistant artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-file-command-'));
  const artifactPath = join(directory, 'artifact.md');
  await writeFile(artifactPath, 'é'.repeat(150_000));
  const h = harness([{ message: { role: 'user', content: 'Review the supplied specification.' } }]);
  let capturedArtifact = '';
  const handler = createCommandHandler(h.pi, {
    file: async () => artifactPath,
    bundle: async (data: any) => { capturedArtifact = data.artifact; return fakeBundle(); },
    cleanup: async () => {},
    run: async () => ({
      code: 0,
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
        ...agentCall('requirements-critic'),
        ...agentCall('implementation-feasibility-reviewer'),
        JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
      ].join('\n'),
      stderr: '', timedOut: false, durationMs: 1,
    }),
  } as any);

  try {
    await handler('spec --file artifact.md --raw', { ...h.ctx, cwd: directory });
    assert.equal(h.sent.length, 1);
    assert.ok(Buffer.byteLength(capturedArtifact) <= 200_100);
    assert.match(capturedArtifact, /TRUNCATED: artifact file limit/);
    assert.equal(h.sent[0].message.details.bundleTruncated, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keep-bundle retains fake JSON stream on nonzero exit', async () => {
  const h = harness();
  const dir = await mkdtemp(join(tmpdir(), 'cc-stream-process-fail-'));
  const failure = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Runtime unavailable',
  });
  const handler = createCommandHandler(h.pi, {
    bundle: async () => ({
      directory: dir,
      manifestPath: join(dir, 'manifest.md'),
      truncated: false,
      bytes: 100,
    }),
    cleanup: async () => {},
    run: async () => ({
      code: 1,
      stdout: failure,
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }),
  } as any);

  try {
    await handler('plan --keep-bundle --raw', h.ctx);
    assert.equal(await readFile(join(dir, 'stream.ndjson'), 'utf8'), failure);
    assert.match(h.notifications.at(-1)?.message ?? '', /Runtime unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('incremental collector delivers the complete final review when stdout result is only a tail', async () => {
  const h = harness();
  const finalReview = `# Claude Code Review\n\n${'finding '.repeat(20_000)}`;
  const stream = [
    ...validPlanStream().split('\n').slice(0, -1),
    JSON.stringify({ type: 'result', result: finalReview }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async (_command: string, _args: string[], _cwd: string, _timeout: number, options: any) => {
      for (const line of stream.split('\n')) options.onStdoutLine(line);
      return {
        code: 0,
        stdout: stream.slice(-64 * 1024),
        stderr: '',
        timedOut: false,
        durationMs: 1,
      };
    },
  } as any);

  await handler('plan --raw', h.ctx);

  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].message.content.endsWith(finalReview));
});

test('keep-bundle writes stream.ndjson into the bundle on success', async () => {
  const h = harness();
  const dir = await mkdtemp(join(tmpdir(), 'cc-stream-ok-'));
  const stream = validPlanStream();
  const handler = createCommandHandler(h.pi, {
    bundle: async () => ({ directory: dir, manifestPath: join(dir, 'manifest.md'), truncated: false, bytes: 100 }),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: stream, stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  try {
    await handler('plan --keep-bundle --raw', h.ctx);
    assert.equal(await readFile(join(dir, 'stream.ndjson'), 'utf8'), stream);
    assert.equal(h.sent[0]?.message.details.bundleRetained, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keep-bundle writes stream.ndjson even when delegation validation fails', async () => {
  const h = harness();
  const dir = await mkdtemp(join(tmpdir(), 'cc-stream-fail-'));
  const incomplete = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'requirements-critic' } }] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
  const handler = createCommandHandler(h.pi, {
    bundle: async () => ({ directory: dir, manifestPath: join(dir, 'manifest.md'), truncated: false, bytes: 100 }),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: incomplete, stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  try {
    await handler('plan --keep-bundle', h.ctx);
    assert.equal(h.sent.length, 0);
    assert.match(h.notifications.at(-1)?.message ?? '', /REQUIRED_AGENTS_MISSING/);
    assert.equal(await readFile(join(dir, 'stream.ndjson'), 'utf8'), incomplete);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop-hook state surfaces in metadata and notifies when it corrected delegation', async () => {
  const h = harness();
  const dir = await mkdtemp(join(tmpdir(), 'cc-stophook-meta-'));
  await writeFile(join(dir, 'stop-hook-state.json'), JSON.stringify({ fired: 3, blocks: 2 }));
  const handler = createCommandHandler(h.pi, {
    bundle: async () => ({ directory: dir, manifestPath: join(dir, 'manifest.md'), truncated: false, bytes: 100 }),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  try {
    await handler('plan --raw', h.ctx);
    assert.equal(h.sent[0]?.message.details.stopHookFired, true);
    assert.equal(h.sent[0]?.message.details.stopHookBlocks, 2);
    assert.ok(h.notifications.some(item => item.message === 'Stop hook corrected delegation (2 block(s)).'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('metadata reports no stop-hook activity and emits no correction notice when it never blocked', async () => {
  const h = harness();
  const handler = createCommandHandler(h.pi, {
    bundle: async () => fakeBundle(),
    cleanup: async () => {},
    run: async () => ({ code: 0, stdout: validPlanStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  await handler('plan --raw', h.ctx);
  assert.equal(h.sent[0]?.message.details.stopHookFired, false);
  assert.equal(h.sent[0]?.message.details.stopHookBlocks, 0);
  assert.equal(h.notifications.some(item => /Stop hook corrected delegation/.test(item.message)), false);
});

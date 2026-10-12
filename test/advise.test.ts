import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAdviseArgs, parseVerdict, ADVISOR_MANIFEST } from '../src/advise.ts';
import { parseArgs } from '../src/args.ts';
import { ADVISOR_EFFORT, ADVISOR_MAX_TURNS, ADVISOR_MODEL, ADVISOR_TIMEOUT_MS } from '../src/config.ts';
import { collectGitSummary } from '../src/git.ts';
import { createCommandHandler } from '../src/index.ts';
import { buildDenyRules } from '../src/permissions.ts';
import { ReviewError } from '../src/types.ts';

const GUIDANCE = '# Advisor guidance\nVerdict: revise\n## Recommendation\nAdd a regression test before refactoring.\n## Key risks\nNone\n## Next steps\n1. Write the test.\n## Evidence checked\ntranscript.md';

function adviceStream(text = GUIDANCE, model = 'claude-fable-5', extra: string[] = []) {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'manifest.md' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'manifest' }] } }),
    ...extra,
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }),
  ].join('\n');
}

const sessionEntries = [
  { type: 'message', id: 'u1', message: { role: 'user', content: 'Refactor the parser. PASSWORD=SuperSecret99' } },
  { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }] } },
  { type: 'message', id: 't1', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: '1 failing' }], isError: true } },
];

function harness(mode?: string) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.296 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = {
    cwd: process.cwd(),
    ...(mode === undefined ? {} : { mode }),
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    sessionManager: { buildContextEntries: () => sessionEntries },
  };
  return { pi, ctx, notifications, sent };
}

test('advise argv is single-process, read-only, delegation-free, and carries the deny rules', () => {
  const args = buildAdviseArgs('C:/tmp/advise-bundle');
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual(args.slice(0, 3), ['-p', '--setting-sources', '']);
  assert.equal(value('--model'), ADVISOR_MODEL);
  assert.equal(ADVISOR_MODEL, 'fable');
  assert.equal(value('--effort'), ADVISOR_EFFORT);
  assert.equal(ADVISOR_EFFORT, 'high');
  assert.equal(value('--max-turns'), String(ADVISOR_MAX_TURNS));
  assert.equal(value('--tools'), 'Read,Grep,Glob');
  assert.equal(value('--allowedTools'), 'Read(./**)');
  assert.match(value('--disallowedTools'), /^Agent,Task,Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch,mcp__\*$/);
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--add-dir'), 'C:/tmp/advise-bundle');
  // Variadic Claude flags (--add-dir, --tools, --allowedTools, --disallowedTools) must never be followed by the prompt.
  for (const flag of ['--add-dir', '--tools', '--allowedTools', '--disallowedTools']) {
    assert.ok(args[args.indexOf(flag) + 2].startsWith('--'), `${flag} must be followed by another flag`);
  }
  assert.deepEqual(JSON.parse(value('--settings')), { permissions: { deny: buildDenyRules() } });
  for (const flag of ['--agents', '--safe-mode', '--bare']) assert.equal(args.includes(flag), false, flag);
  for (const flag of ['--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
  assert.ok(args.some(arg => /dangerously|bypass/i.test(arg)) === false);
  assert.match(args.at(-1)!, /advisor manifest at C:[\\/]tmp[\\/]advise-bundle[\\/]manifest\.md/);
  assert.equal(ADVISOR_TIMEOUT_MS, 180_000);
});

test('manifest defines the output contract and the four verdicts', () => {
  for (const part of ['# Advisor guidance', 'Verdict: proceed | revise | stop | decline', '## Recommendation', '## Key risks', '## Next steps', '## Evidence checked', 'untrusted evidence']) {
    assert.ok(ADVISOR_MANIFEST.includes(part), part);
  }
});

test('verdict parsing tolerates Markdown decoration and rejects unknown values', () => {
  assert.equal(parseVerdict('Verdict: revise'), 'revise');
  assert.equal(parseVerdict('# Advisor guidance\n**Verdict:** proceed'), 'proceed');
  assert.equal(parseVerdict('Verdict: **STOP** now'), 'stop');
  assert.equal(parseVerdict('- verdict: decline'), 'decline');
  assert.equal(parseVerdict('> Verdict : `revise`'), 'revise');
  assert.equal(parseVerdict('Verdict: maybe'), 'unknown');
  assert.equal(parseVerdict('No verdict line here'), 'unknown');
  assert.equal(parseVerdict('The verdict: revise is mentioned mid-sentence'), 'unknown');
});

test('advise argument rules', () => {
  assert.deepEqual(parseArgs('advise --focus "Should I retry?" --raw'), { mode: 'advise', focus: 'Should I retry?', deep: false, raw: true, keepBundle: false, help: false });
  assert.throws(() => parseArgs('advise --file spec.md'), /--file is only valid/);
  assert.throws(() => parseArgs('advise --base main'), /--base is only valid/);
  assert.throws(() => parseArgs('advise --deep'), /--deep is not valid for advise/);
});

test('direct advise builds a redacted bundle, validates, delivers a follow-up, and cleans up', async () => {
  const h = harness();
  let seen: { args: string[]; cwd: string; timeout: number; options: any; files: Record<string, string> } | undefined;
  const handler = createCommandHandler(h.pi, {
    gitSummary: async () => 'Branch: main\n## git status --short\n M src/parser.ts',
    run: async (_command: string, args: string[], cwd: string, timeout: number, options: any) => {
      const bundle = args[args.indexOf('--add-dir') + 1];
      const files: Record<string, string> = {};
      for (const name of await readdir(bundle)) files[name] = await readFile(join(bundle, name), 'utf8');
      seen = { args, cwd, timeout, options, files };
      return { code: 0, stdout: adviceStream(), stderr: '', timedOut: false, durationMs: 4_200 };
    },
  } as any);
  const completed = await handler('advise --focus "Should I refactor before fixing the test?"', h.ctx);

  assert.ok(seen);
  assert.equal(seen.cwd, process.cwd());
  assert.equal(seen.timeout, ADVISOR_TIMEOUT_MS);
  assert.deepEqual({ ...seen.options.env }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  assert.deepEqual(Object.keys(seen.files).sort(), ['git-summary.txt', 'manifest.md', 'question.md', 'transcript.md']);
  assert.match(seen.files['question.md'], /Should I refactor before fixing the test\?/);
  assert.match(seen.files['transcript.md'], /tool call `bash`/);
  assert.match(seen.files['transcript.md'], /## tool result `bash` \(error\)\n1 failing/);
  assert.doesNotMatch(seen.files['transcript.md'], /SuperSecret99/);
  const bundle = seen.args[seen.args.indexOf('--add-dir') + 1];
  await assert.rejects(access(bundle), 'bundle must be removed');

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, 'cc-advise-result');
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.match(h.sent[0].message.content, /External Claude Code advisor guidance \(untrusted\)/);
  assert.match(h.sent[0].message.content, /Advisor verdict: \*\*revise\*\*/);
  assert.match(h.sent[0].message.content, /surface the conflict/);
  assert.ok(h.sent[0].message.content.endsWith(GUIDANCE));
  const details = h.sent[0].message.details;
  assert.equal(details.verdict, 'revise');
  assert.equal(details.advisorModel, 'fable');
  assert.equal(details.observedModel, 'claude-fable-5');
  assert.equal(details.modelVerified, true);
  assert.equal(details.gitSummary, true);
  assert.equal(details.transcript.redactions, 1);
  assert.deepEqual(details.toolsUsed, ['Read']);
  assert.equal(completed?.completionNotice, 'Claude Code advisor verdict: revise (4s).');
  assert.ok(h.notifications.some(item => /Consulting Claude Code advisor \(1× fable, high effort\)/.test(item.message)));
});

test('raw advise does not trigger a follow-up turn; missing verdict is delivered as unknown', async () => {
  const h = harness();
  const handler = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => ({ code: 0, stdout: adviceStream('Just add a test first.'), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  await handler('advise --raw', h.ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, false);
  assert.equal(h.sent[0].message.details.verdict, 'unknown');
  assert.equal(h.sent[0].message.details.gitSummary, false);
});

for (const [label, stdout, code, pattern] of [
  ['delegation attempt', adviceStream(GUIDANCE, 'claude-fable-5', [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Task', input: { subagent_type: 'general-purpose' } }] } })]), 0, /ADVISOR_DELEGATION_FORBIDDEN/],
  ['wrong model', adviceStream(GUIDANCE, 'claude-haiku-5-5'), 0, /COORDINATOR_MODEL_MISMATCH/],
  ['missing final', [JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' })].join('\n'), 0, /FINAL_RESULT_MISSING/],
  ['runtime failure', [JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }), JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached max turns token=abcdefghij' })].join('\n'), 1, /PROCESS_FAILED.*advisor exited 1.*Reached max turns token=\[REDACTED\]/],
] as const) {
  test(`advise fails closed on ${label} and injects nothing`, async () => {
    const h = harness();
    let bundle = '';
    const handler = createCommandHandler(h.pi, {
      gitSummary: async () => undefined,
      run: async (_c: string, args: string[]) => { bundle = args[args.indexOf('--add-dir') + 1]; return { code, stdout, stderr: '', timedOut: false, durationMs: 1 }; },
    } as any);
    assert.equal(await handler('advise', h.ctx), undefined);
    assert.equal(h.sent.length, 0);
    assert.match(h.notifications.at(-1)?.message ?? '', pattern);
    await assert.rejects(access(bundle));
  });
}

test('advise timeout and cancellation release the shared lock', async () => {
  const h = harness();
  const timeout = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, durationMs: ADVISOR_TIMEOUT_MS }),
  } as any);
  await timeout('advise', h.ctx);
  assert.match(h.notifications.at(-1)?.message ?? '', /PROCESS_TIMEOUT.*advisor timed out/);

  const controller = new AbortController();
  const cancel = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async (_c: string, _a: string[], _cwd: string, _t: number, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new ReviewError('PROCESS_CANCELLED', 'Claude Code advisor cancelled.')));
      queueMicrotask(() => controller.abort());
    }),
  } as any);
  await cancel('advise', { ...h.ctx, signal: controller.signal });
  assert.match(h.notifications.at(-1)?.message ?? '', /PROCESS_CANCELLED/);

  const after = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => ({ code: 0, stdout: adviceStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  assert.ok(await after('advise --raw', h.ctx), 'lock must be free after timeout and cancellation');
});

test('advise and review share one lock in both directions', async () => {
  const h = harness();
  let release!: () => void;
  let started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  const slowAdvise = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { code: 0, stdout: adviceStream(), stderr: '', timedOut: false, durationMs: 1 }; },
  } as any);
  const pending = slowAdvise('advise --raw', h.ctx);
  await runStarted;
  const review = createCommandHandler(h.pi, { run: async () => { throw new Error('must not run'); } } as any);
  await review('plan --raw', { ...h.ctx, sessionManager: { buildContextEntries: () => [{ message: { role: 'assistant', content: 'P'.repeat(400) } }] } });
  assert.match(h.notifications.at(-1)?.message ?? '', /ALREADY_RUNNING/);
  const secondAdvise = createCommandHandler(h.pi, { gitSummary: async () => undefined, run: async () => { throw new Error('must not run'); } } as any);
  await secondAdvise('advise', h.ctx);
  assert.match(h.notifications.at(-1)?.message ?? '', /ALREADY_RUNNING/);
  release();
  await pending;
});

test('keep-bundle retains the advisor bundle and stream and reports the path', async () => {
  const h = harness();
  const handler = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => ({ code: 0, stdout: adviceStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  await handler('advise --keep-bundle --raw', h.ctx);
  const details = h.sent[0].message.details;
  assert.equal(details.bundleRetained, true);
  try {
    assert.deepEqual((await readdir(details.bundlePath)).sort(), ['manifest.md', 'question.md', 'stream.ndjson', 'transcript.md']);
    assert.equal(await readFile(join(details.bundlePath, 'stream.ndjson'), 'utf8'), adviceStream());
  } finally { await rm(details.bundlePath, { recursive: true, force: true }); }
});

test('TUI advise uses the advisor progress panel without reviewer rows', async () => {
  const h = harness('tui');
  let rendered: string[] = [];
  const ctx = {
    ...h.ctx,
    hasUI: true,
    ui: {
      ...h.ctx.ui,
      custom: (factory: any) => new Promise(resolve => {
        const view = factory({ requestRender() {} }, null, null, (value: unknown) => { resolve(value); });
        rendered = view.render(80);
      }),
    },
  };
  const handler = createCommandHandler(h.pi, {
    gitSummary: async () => undefined,
    run: async () => ({ code: 0, stdout: adviceStream(), stderr: '', timedOut: false, durationMs: 1 }),
  } as any);
  await handler('advise --raw', ctx);
  const panel = rendered.join('\n');
  assert.match(panel, /Claude Code Advisor · fable · high/);
  assert.match(panel, /Consulting advisor…/);
  assert.doesNotMatch(panel, /Reviewers:/);
  assert.equal(h.sent.length, 1);
});

test('git summary is bounded context and never throws', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'cc-advise-nogit-'));
  const repo = await mkdtemp(join(tmpdir(), 'cc-advise-git-'));
  try {
    assert.equal(await collectGitSummary(outside), undefined);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'new.txt'), 'x\n');
    const summary = await collectGitSummary(repo);
    assert.ok(summary);
    assert.match(summary, /## git status --short\n M a\.txt\n\?\? new\.txt/);
    assert.match(summary, /a\.txt \| 1 \+/);
    assert.doesNotMatch(summary, /^\+two/m, 'no full diff content');
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

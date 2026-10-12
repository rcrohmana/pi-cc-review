import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClaudeArgs, CLAUDE_ENV, requiredAgents } from '../src/agents.ts';
import { createCommandHandler } from '../src/index.ts';
import { runProcess } from '../src/process.ts';
import { parseStream, validateRun } from '../src/stream.ts';

function agentStream(resultFor: (name: string, id: string) => unknown) {
  const names = ['correctness-reviewer', 'test-reviewer'];
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    ...names.flatMap(name => [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `id-${name}`, name: 'Agent', input: { subagent_type: name } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `id-${name}`, ...resultFor(name, `id-${name}`) as object }] } }),
    ]),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n');
}

test('an async-launch acknowledgement is not a completed reviewer', () => {
  const parsed = parseStream(agentStream(name => name === 'test-reviewer'
    ? { content: [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata.) agentId: a1' }] }
    : { content: 'review done' }));
  assert.deepEqual(parsed.invokedAgents, ['correctness-reviewer', 'test-reviewer']);
  assert.deepEqual(parsed.completedAgents, ['correctness-reviewer']);
  assert.throws(
    () => validateRun(parsed, ['correctness-reviewer', 'test-reviewer'], { coordinator: 'fable' }),
    (error: any) => error?.code === 'REQUIRED_AGENTS_FAILED'
      && /test-reviewer \(launched in the background without a returned report\)/.test(error.message),
  );
});

test('review argv records Agent outcomes through PostToolUse hooks and keeps the Stop hook', () => {
  const bundle = join(tmpdir(), 'cc-delegation-bundle');
  const names = requiredAgents('code', false);
  const args = buildClaudeArgs(bundle, 'C:/repo', names, false);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    const entries = settings.hooks[event];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].matcher, 'Agent|Task');
    const command: string = entries[0].hooks[0].command;
    assert.match(command, /stop-delegation-guard\.mjs" --record "/);
    assert.ok(command.includes(join(bundle, 'agent-outcomes.jsonl')));
  }
  const stop: string = settings.hooks.Stop[0].hooks[0].command;
  assert.ok(stop.includes(join(bundle, 'stop-hook-state.json')));
  assert.ok(stop.endsWith(` 2 ${names.join(',')}`));
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /run_in_background false/);
});

test('Claude runs with background tasks disabled', async () => {
  assert.deepEqual({ ...CLAUDE_ENV }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  let received: unknown;
  const handler = createCommandHandler({
    exec: async (_command: string, args: string[]) => args[0] === '--version'
      ? { code: 0, stdout: '2.1.296 (Claude Code)', stderr: '' }
      : { code: 0, stdout: 'loggedIn: true', stderr: '' },
    sendMessage: () => {},
  }, {
    bundle: async () => ({ directory: join(tmpdir(), 'cc-env-bundle'), manifestPath: 'm', truncated: false, bytes: 1 }),
    cleanup: async () => {},
    run: async (_c: string, _a: string[], _cwd: string, _t: number, options: any) => {
      received = options.env;
      return { code: 0, stdout: '{"type":"result","result":"x"}', stderr: '', timedOut: false, durationMs: 1 };
    },
  } as any);
  await handler('plan --raw', {
    cwd: process.cwd(),
    ui: { notify: () => {} },
    sessionManager: { buildContextEntries: () => [{ message: { role: 'assistant', content: 'P'.repeat(400) } }] },
  });
  assert.equal(received, CLAUDE_ENV);
});

test('runProcess merges extra env over the inherited environment', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ flag: process.env.CC_TEST_FLAG, path: Boolean(process.env.PATH || process.env.Path) }))'],
    process.cwd(),
    10_000,
    { env: { CC_TEST_FLAG: 'on' } },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { flag: 'on', path: true });
});

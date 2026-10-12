import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP, isContainedRelative, parseArgs, containedFile } from '../src/args.ts';
import { COORDINATOR_MODEL, REVIEWER_MODEL, REVIEW_EFFORT } from '../src/config.ts';
import { win32 } from 'node:path';
import { requiredAgents, buildAgents, buildClaudeArgs } from '../src/agents.ts';
import {
  createStreamCollector,
  parseStream,
  reviewersMatchModel,
  streamFailureDiagnostic,
  validateRun,
} from '../src/stream.ts';

test('help and normal path do not create an invocation plan', () => {
  assert.equal(parseArgs('--help').help, true);
  assert.equal(parseArgs('').mode, 'auto');
});
test('parser supports quoted focus and rejects invalid combinations', () => {
  assert.equal(parseArgs('code --focus "race conditions" --deep').focus, 'race conditions');
  assert.equal(parseArgs('repo').mode, 'repo');
  assert.equal(parseArgs('repo --deep --focus "security and tests"').focus, 'security and tests');
  assert.throws(() => parseArgs('repo --base main'), /only valid for code review/i);
  for (const mode of ['code', 'repo', 'auto']) assert.throws(() => parseArgs(`${mode} --file evidence.md`), /only valid for plan or spec/i);
  assert.throws(() => parseArgs('auto auto')); assert.throws(() => parseArgs('code code')); assert.throws(() => parseArgs('plan --raw --raw')); assert.throws(() => parseArgs('plan --focus x --focus x'));
  assert.match(HELP, /repo/);
  assert.throws(() => parseArgs('plan --base main'));
  assert.throws(() => containedFile('C:/workspace', '../secret'));
});
test('rich HELP documents the file restriction, account cost, and configured models', () => {
  assert.equal(HELP.split('\n')[0].startsWith('/cc-review [auto|plan|spec|code|repo|advise]'), true);
  assert.match(HELP, /advise +Ask one advisor/);
  assert.match(HELP, /--file <path>[^\n]*plan and spec only/);
  assert.match(HELP, /account usage/i);
  assert.ok(HELP.includes(COORDINATOR_MODEL));
  assert.ok(HELP.includes(REVIEWER_MODEL));
  assert.ok(HELP.includes(REVIEW_EFFORT));
});

test('containment rejects Windows cross-volume paths deterministically', () => {
  const rel = win32.relative('C:\\workspace', 'D:\\secret.md');
  assert.equal(win32.isAbsolute(rel), true);
  assert.equal(isContainedRelative(rel, win32), false);
  assert.equal(isContainedRelative('child.txt', win32), true);
});

test('safe invocation is exact and read-only', () => {
  assert.deepEqual(requiredAgents('repo', false), ['correctness-reviewer', 'test-reviewer']);
  assert.deepEqual(requiredAgents('repo', true), ['correctness-reviewer', 'test-reviewer', 'security-reviewer']);
  const agents = requiredAgents('code', false);
  const args = buildClaudeArgs('C:/tmp/bundle', 'C:/repo', agents, false);
  assert.deepEqual(args.slice(0, 5), ['-p', '--setting-sources', '', '--model', 'fable']);
  assert.ok(!args.includes('--safe-mode'));
  const agentDefinitions = JSON.parse(args[args.indexOf('--agents') + 1]);
  for (const definition of Object.values(agentDefinitions) as any[]) {
    // Claude Code rejects object-valued mcpServers once --agents are actually loaded.
    assert.ok(Array.isArray(definition.mcpServers), 'mcpServers must be an array');
    assert.ok(Array.isArray(definition.skills), 'skills must be an array');
  }
  assert.ok(args.includes('--max-turns') && args.includes('16'));
  assert.ok(args.includes('--agents'));
  assert.ok(args.includes('Agent,Read,Grep,Glob'));
  assert.ok(args.includes('Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch,mcp__*'));
  assert.equal(args.some(x => x.includes('bypass')), false);
  const verboseIndex = args.indexOf('--verbose');
  const outputFormatIndex = args.indexOf('--output-format');
  assert.ok(verboseIndex >= 0);
  assert.ok(outputFormatIndex >= 0);
  assert.ok(verboseIndex < outputFormatIndex);
  assert.equal(args[args.indexOf('--model') + 1], 'fable');
  const appendIndex = args.indexOf('--append-system-prompt');
  assert.ok(appendIndex >= 0, 'coordinator must receive an extension-controlled append instruction');
  const coordinatorInstruction = args[appendIndex + 1];
  assert.match(coordinatorInstruction, /read the (review )?manifest/i);
  assert.match(coordinatorInstruction, /before ANY independent analysis/i);
  assert.match(coordinatorInstruction, /single batch of native Agent calls/i);
  assert.match(coordinatorInstruction, /reconcile/i);
  for (const name of agents) assert.match(coordinatorInstruction, new RegExp(name));
  assert.match(coordinatorInstruction, /Textual simulation is invalid/i);
  const settingsValue = JSON.parse(args[args.indexOf('--settings') + 1]);
  const stopCommand = settingsValue.hooks.Stop[0].hooks[0].command;
  assert.match(stopCommand, /stop-delegation-guard\.mjs/);
  assert.ok(stopCommand.includes('stop-hook-state.json'));
  assert.match(stopCommand, /" 2 /);
  for (const name of agents) assert.ok(stopCommand.includes(name));
  const userPrompt = args[args.length - 1];
  assert.match(userPrompt, /read the manifest/i);
  assert.match(userPrompt, /single batch of native Agent calls/i);
  assert.match(userPrompt, /reconcile/i);
  const definitions = buildAgents(agents);
  assert.deepEqual(Object.keys(definitions).sort(), agents.sort());
  assert.equal(definitions['correctness-reviewer'].permissionMode, 'dontAsk');
  assert.equal(definitions['correctness-reviewer'].model, 'sonnet');
  assert.equal(definitions['correctness-reviewer'].effort, 'high');
  for (const name of agents) assert.ok(Object.hasOwn(definitions, name));
  assert.deepEqual(Object.keys(definitions).sort(), [...new Set(agents)].sort());
  assert.deepEqual(definitions['correctness-reviewer'].tools, ['Read', 'Grep', 'Glob']);
  const deepArgs = buildClaudeArgs('C:/tmp/bundle', 'C:/repo', requiredAgents('code', true), true);
  assert.equal(deepArgs[deepArgs.indexOf('--max-turns') + 1], '24');
});
test('stream records runtime models and verifies the configured coordinator family', () => {
  const parsed = parseStream([
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));

  assert.equal(parsed.initModel, 'claude-fable-5');
  assert.deepEqual(parsed.observedModels, ['claude-fable-5', 'claude-sonnet-4-6']);
  assert.equal(validateRun(parsed, [], { coordinator: 'fable' }).coordinatorModelVerified, true);
  assert.throws(
    () => validateRun(parsed, [], { coordinator: 'opus' }),
    (error: any) => error?.code === 'COORDINATOR_MODEL_MISMATCH',
  );
  assert.throws(
    () => validateRun(parseStream('{"type":"result","result":"# Review"}'), [], { coordinator: 'fable' }),
    (error: any) => error?.code === 'COORDINATOR_MODEL_UNVERIFIED',
  );
});

test('incremental stream collection matches batch parsing', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'requirements-call',
          name: 'Agent',
          input: { subagent_type: 'requirements-critic' },
        }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'requirements-call',
      message: { model: 'claude-sonnet-5', content: [] },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '# Review' }),
  ];
  const collector = createStreamCollector();
  for (const line of lines) collector.ingest(line);

  assert.deepEqual(collector.snapshot(), parseStream(lines.join('\n')));
  assert.equal(collector.snapshot().finalText, '# Review');
  assert.deepEqual(collector.snapshot().reviewerModels, {
    'requirements-critic': ['claude-sonnet-5'],
  });
});

test('structured Claude error results produce actionable diagnostics', () => {
  const parsed = parseStream(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'There is an issue with the selected model.',
    errors: [],
    api_error_status: 404,
  }));

  assert.equal(parsed.finalText, '');
  assert.deepEqual(parsed.runError, {
    result: 'There is an issue with the selected model.',
    errors: [],
    subtype: 'success',
    apiStatus: 404,
  });
  assert.equal(
    streamFailureDiagnostic(parsed),
    'API 404: There is an issue with the selected model.',
  );
});

test('ordinary assistant text cannot spoof a structured runtime error', () => {
  const parsed = parseStream(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'is_error: true model unavailable' }] },
  }));

  assert.equal(parsed.runError, undefined);
  assert.equal(streamFailureDiagnostic(parsed), '');
});

test('stream validation accepts Agent agent/name aliases and ignores non-Agent spoofing', () => {
  const parsed = parseStream([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Agent', input: { agent: 'correctness-reviewer' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { name: 'test-reviewer' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'done' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { name: 'spoof-reviewer' } }] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));

  const validated = validateRun(parsed, ['correctness-reviewer', 'test-reviewer']);
  assert.deepEqual(validated.invokedAgents, ['correctness-reviewer', 'test-reviewer']);
  assert.doesNotMatch(validated.invokedAgents.join(','), /spoof-reviewer/);
});

test('reviewer model attribution only accepts parent-matched required agents', () => {
  const noParent = parseStream(`${JSON.stringify({ type:'assistant', message:{ model:'claude-fable', content:[{ type:'tool_use', id:'a', name:'Agent', input:{subagent_type:'one'} }] } })}\n${JSON.stringify({ type:'assistant', message:{ model:'claude-fable', content:[] } })}`);
  assert.equal(reviewersMatchModel(noParent, ['one'], 'fable'), false);
  const attributed = parseStream(`${JSON.stringify({ type:'assistant', message:{ content:[{ type:'tool_use', id:'a', name:'Agent', input:{subagent_type:'one'} },{ type:'tool_use', id:'b', name:'Agent', input:{subagent_type:'two'} }] } })}\n${JSON.stringify({ type:'assistant', parent_tool_use_id:'a', message:{model:'claude-sonnet',content:[]} })}\n${JSON.stringify({ type:'assistant', message:{parent_tool_use_id:'b',model:'claude-sonnet',content:[]} })}`);
  assert.equal(reviewersMatchModel(attributed, ['one','two'], 'sonnet'), true);
  assert.equal(reviewersMatchModel(attributed, ['one','missing'], 'sonnet'), false);
  const extraOnly = parseStream(`${JSON.stringify({ type:'assistant', message:{ content:[{ type:'tool_use', id:'extra', name:'Agent', input:{subagent_type:'general-purpose'} }] } })}\n${JSON.stringify({ type:'assistant', parent_tool_use_id:'extra', message:{model:'claude-sonnet',content:[]} })}`);
  assert.equal(reviewersMatchModel(extraOnly, ['one'], 'sonnet'), false);
});

test('reviewerModels attributes per-reviewer via parent_tool_use_id and kills vacuous global matches', () => {
  const attributed = parseStream([
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } },
      { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'test-reviewer' } },
    ] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu1', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu2', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));
  assert.deepEqual(attributed.reviewerModels, { 'correctness-reviewer': ['claude-sonnet-4-6'], 'test-reviewer': ['claude-sonnet-4-6'] });
  assert.equal(reviewersMatchModel(attributed, ['correctness-reviewer', 'test-reviewer'], 'sonnet'), true);

  const vacuous = parseStream([
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } }] } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));
  assert.deepEqual(vacuous.observedModels, ['claude-fable-5']);
  assert.deepEqual(vacuous.reviewerModels, {});
  assert.equal(reviewersMatchModel(vacuous, ['correctness-reviewer'], 'fable'), false);

  const partial = parseStream([
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } },
      { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'test-reviewer' } },
    ] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu1', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));
  assert.equal(reviewersMatchModel(partial, ['correctness-reviewer', 'test-reviewer'], 'sonnet'), false);
  assert.equal(reviewersMatchModel(partial, ['correctness-reviewer'], 'sonnet'), true);

  const spoof = parseStream([
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'x' } },
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } },
    ] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'read1', message: { model: 'claude-sonnet-4-6', content: [] } }),
    JSON.stringify({ type: 'result', result: '# Claude Code Review' }),
  ].join('\n'));
  assert.deepEqual(spoof.reviewerModels, {});
  assert.equal(reviewersMatchModel(spoof, ['correctness-reviewer'], 'sonnet'), false);
});

test('real Agent events are required; prose is insufficient', () => {
  const prose = parseStream('{"type":"assistant","message":{"content":[{"type":"text","text":"I asked correctness-reviewer"}]}}\n{"type":"result","result":"# Review"}');
  assert.throws(() => validateRun(prose, ['correctness-reviewer']), /Observed native Agent calls: none.*stream\.ndjson/);
  const valid = parseStream('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Agent","input":{"subagent_type":"correctness-reviewer"}}]}}\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Agent","input":{"subagent_type":"test-reviewer"}}]}}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"ok"},{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\n{"type":"result","result":"# Review"}');
  const validated = validateRun(valid, ['correctness-reviewer', 'test-reviewer']);
  assert.deepEqual(validated.invokedAgents.sort(), ['correctness-reviewer','test-reviewer']);
  assert.deepEqual(validated.completedAgents.sort(), ['correctness-reviewer','test-reviewer']);
});

test('invoked reviewers whose Agent call errored or never returned are rejected', () => {
  const lines = (resultForTest: string) => [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'c1', name: 'Agent', input: { subagent_type: 'correctness-reviewer' } },
      { type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'test-reviewer' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'review done' }] } }),
    resultForTest,
    JSON.stringify({ type: 'result', result: '# Claude Code Review (written without reviewers)' }),
  ].filter(Boolean).join('\n');

  const errored = parseStream(lines(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: "Agent type 'test-reviewer' not found. Available agents: claude, Explore" }] }] } })));
  assert.deepEqual(errored.completedAgents, ['correctness-reviewer']);
  assert.throws(
    () => validateRun(errored, ['correctness-reviewer', 'test-reviewer'], { coordinator: 'fable' }),
    (error: any) => error?.code === 'REQUIRED_AGENTS_FAILED'
      && /test-reviewer \(Agent type 'test-reviewer' not found/.test(error.message)
      && !/correctness-reviewer/.test(error.message),
  );

  const unanswered = parseStream(lines(''));
  assert.throws(
    () => validateRun(unanswered, ['correctness-reviewer', 'test-reviewer'], { coordinator: 'fable' }),
    (error: any) => error?.code === 'REQUIRED_AGENTS_FAILED' && /test-reviewer \(no successful result\)/.test(error.message),
  );

  const retried = parseStream([
    lines(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'transient' }] } })),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'test-reviewer' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'review done' }] } }),
  ].join('\n'));
  assert.deepEqual(validateRun(retried, ['correctness-reviewer', 'test-reviewer'], { coordinator: 'fable' }).completedAgents, ['correctness-reviewer', 'test-reviewer']);
});
test('missing-reviewer error names observed reviewers and points at the retained stream', () => {
  const partial = parseStream('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"correctness-reviewer"}}]}}\n{"type":"result","result":"# Review"}');
  assert.throws(
    () => validateRun(partial, ['correctness-reviewer', 'test-reviewer']),
    (error: any) => error?.code === 'REQUIRED_AGENTS_MISSING'
      && /Required native reviewers missing: test-reviewer/.test(error.message)
      && /Observed native Agent calls: correctness-reviewer/.test(error.message)
      && /stream\.ndjson/.test(error.message),
  );
});
test('malformed stream and missing final fail', () => {
  assert.throws(() => validateRun(parseStream('not-json'), []));
  assert.throws(() => validateRun(parseStream('{"type":"assistant","message":{"content":[]}}'), []));
});

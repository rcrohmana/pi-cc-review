import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  buildBlockReason,
  collectInvokedAgents,
  computeMissing,
  extractAgentName,
  readState,
} from '../hooks/stop-delegation-guard.mjs';

const script = fileURLToPath(new URL('../hooks/stop-delegation-guard.mjs', import.meta.url));

function agentLine(name: string, tool = 'Agent', key = 'subagent_type', topLevel = false) {
  const item = { type: 'tool_use', name: tool, input: { [key]: name } };
  return topLevel
    ? JSON.stringify({ type: 'assistant', content: [item] })
    : JSON.stringify({ type: 'assistant', message: { content: [item] } });
}

function invoke(stateFile: string, transcriptPath: string, required: string, maxBlocks = '2', payload?: string) {
  return spawnSync(
    process.execPath,
    [script, stateFile, maxBlocks, required],
    { input: payload ?? JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' },
  );
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-stophook-'));
  return {
    dir,
    stateFile: join(dir, 'stop-hook-state.json'),
    transcriptPath: join(dir, 'transcript.jsonl'),
    async state() { return JSON.parse(await readFile(join(dir, 'stop-hook-state.json'), 'utf8')); },
    cleanup() { return rm(dir, { recursive: true, force: true }); },
  };
}

test('extractAgentName honours subagent_type > agent > name precedence and Task alias', () => {
  assert.equal(extractAgentName({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'a', agent: 'b', name: 'c' } }), 'a');
  assert.equal(extractAgentName({ type: 'tool_use', name: 'Agent', input: { agent: 'b', name: 'c' } }), 'b');
  assert.equal(extractAgentName({ type: 'tool_use', name: 'Agent', input: { name: 'c' } }), 'c');
  assert.equal(extractAgentName({ type: 'tool_use', name: 'Task', input: { subagent_type: 't' } }), 't');
  assert.equal(extractAgentName({ type: 'tool_use', name: 'Read', input: { name: 'spoof' } }), undefined);
  assert.equal(extractAgentName({ type: 'text', text: 'x' }), undefined);
});

test('collectInvokedAgents reads message.content and top-level content and skips malformed lines', () => {
  const transcript = [
    '{ not json at all',
    agentLine('one'),
    agentLine('two', 'Task', 'agent', true),
    '',
  ].join('\n');
  assert.deepEqual(collectInvokedAgents(transcript).sort(), ['one', 'two']);
  assert.deepEqual(computeMissing(['one', 'two', 'three'], collectInvokedAgents(transcript)), ['three']);
});

test('all required reviewers present allows stop with no output and increments fired', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, [agentLine('alpha-reviewer'), agentLine('beta-reviewer')].join('\n'));
    const result = invoke(s.stateFile, s.transcriptPath, 'alpha-reviewer,beta-reviewer');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.deepEqual(await s.state(), { fired: 1, blocks: 0 });
  } finally { await s.cleanup(); }
});

test('missing reviewers block with parseable JSON naming exactly the missing reviewers', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, agentLine('alpha-reviewer'));
    const result = invoke(s.stateFile, s.transcriptPath, 'alpha-reviewer,beta-reviewer');
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /beta-reviewer/);
    assert.doesNotMatch(parsed.reason, /alpha-reviewer/);
    assert.equal(parsed.reason, buildBlockReason(['beta-reviewer']));
    assert.deepEqual(await s.state(), { fired: 1, blocks: 1 });
  } finally { await s.cleanup(); }
});

test('blocks stop at maxBlocks and the counter persists across invocations', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, agentLine('alpha-reviewer'));
    const required = 'alpha-reviewer,beta-reviewer';
    const first = invoke(s.stateFile, s.transcriptPath, required);
    assert.equal(JSON.parse(first.stdout).decision, 'block');
    assert.deepEqual(await s.state(), { fired: 1, blocks: 1 });
    const second = invoke(s.stateFile, s.transcriptPath, required);
    assert.equal(JSON.parse(second.stdout).decision, 'block');
    assert.deepEqual(await s.state(), { fired: 2, blocks: 2 });
    const third = invoke(s.stateFile, s.transcriptPath, required);
    assert.equal(third.status, 0);
    assert.equal(third.stdout, '');
    assert.deepEqual(await s.state(), { fired: 3, blocks: 2 });
  } finally { await s.cleanup(); }
});

test('corrupt state file is treated as zeros', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, agentLine('alpha-reviewer'));
    await writeFile(s.stateFile, 'not json');
    const result = invoke(s.stateFile, s.transcriptPath, 'alpha-reviewer,beta-reviewer');
    assert.equal(JSON.parse(result.stdout).decision, 'block');
    assert.deepEqual(await s.state(), { fired: 1, blocks: 1 });
    assert.deepEqual(readState(join(s.dir, 'never-written.json')), { fired: 0, blocks: 0 });
  } finally { await s.cleanup(); }
});

test('garbage stdin exits 0 with no output', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, agentLine('alpha-reviewer'));
    const result = invoke(s.stateFile, s.transcriptPath, 'alpha-reviewer,beta-reviewer', '2', 'this is not json');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally { await s.cleanup(); }
});

test('unreadable transcript path exits 0 with no output (fail-open)', async () => {
  const s = await scratch();
  try {
    const result = invoke(s.stateFile, join(s.dir, 'does-not-exist.jsonl'), 'alpha-reviewer,beta-reviewer');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally { await s.cleanup(); }
});

test('subagent_type precedence and Task alias are honoured end-to-end', async () => {
  const s = await scratch();
  try {
    await writeFile(s.transcriptPath, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'alpha-reviewer', agent: 'ignored', name: 'ignored' } }] } }),
      agentLine('beta-reviewer', 'Task'),
    ].join('\n'));
    const result = invoke(s.stateFile, s.transcriptPath, 'alpha-reviewer,beta-reviewer');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally { await s.cleanup(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressReducer } from '../src/progress.ts';

function agent(name: string) { return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: name } }] } }); }

test('progress reducer ignores malformed, text, and unknown events', () => {
  const updates: any[] = [];
  const reducer = createProgressReducer(['correctness-reviewer', 'test-reviewer'], state => updates.push(state));
  reducer.ingest('untrusted malformed reviewer text correctness-reviewer');
  reducer.ingest(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'correctness-reviewer' }] } }));
  reducer.ingest(agent('built-in-agent'));
  assert.deepEqual(reducer.snapshot(), { phase: 'starting', requiredAgents: ['correctness-reviewer', 'test-reviewer'], invokedAgents: [] });
  assert.equal(updates.length, 0);
});

test('progress supports Agent agent/name aliases but ignores non-Agent spoofing', () => {
  const reducer = createProgressReducer(['correctness-reviewer', 'test-reviewer'], () => {});
  reducer.ingest(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { agent: 'correctness-reviewer' } }] } }));
  reducer.ingest(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { name: 'test-reviewer' } }] } }));
  reducer.ingest(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { name: 'unknown' } }] } }));
  assert.deepEqual(reducer.snapshot().invokedAgents, ['correctness-reviewer', 'test-reviewer']);
});

test('progress reducer accepts exact native agents once and exposes defensive copies', () => {
  const reducer = createProgressReducer(['correctness-reviewer', 'test-reviewer'], () => {});
  reducer.ingest(agent('correctness-reviewer')); reducer.ingest(agent('correctness-reviewer'));
  assert.equal(reducer.snapshot().phase, 'delegating');
  reducer.ingest(agent('test-reviewer')); assert.equal(reducer.snapshot().phase, 'synthesizing');
  reducer.ingest(JSON.stringify({ type: 'result' })); assert.equal(reducer.snapshot().phase, 'validating');
  const copy = reducer.snapshot(); copy.invokedAgents.push('untrusted'); assert.deepEqual(reducer.snapshot().invokedAgents, ['correctness-reviewer', 'test-reviewer']);
  reducer.setPhase('cancelling'); assert.equal(reducer.snapshot().phase, 'cancelling');
});

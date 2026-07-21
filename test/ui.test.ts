import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressView } from '../src/ui.ts';

function state(phase: any = 'delegating') { return { phase, requiredAgents: ['correctness-reviewer', 'test-reviewer'], invokedAgents: ['correctness-reviewer', 'unknown'] }; }

test('progress view renders a bounded bordered factual panel', () => {
  const view = createProgressView({ requestRender() {} }, { fg: (_: string, value: string) => value }, 'repo', 'fable', 'sonnet', 'high', state(), () => 3_000);
  const lines = view.render(60);
  assert.ok(lines.every(line => line.length <= 60));
  assert.match(lines[0], /^╭/); assert.match(lines.at(-1)!, /^╰/);
  assert.match(lines.join('\n'), /repo · fable → 2× sonnet · high/); assert.match(lines.join('\n'), /Reviewers: 1\/2/);
  assert.doesNotMatch(lines.join('\n'), /unknown/); view.dispose();
});

test('progress view animates phases and disposal stops scheduled renders', () => {
  let now = 0; let tick: (() => void) | undefined; let renders = 0; let cleared = false;
  const view = createProgressView({ requestRender: () => renders++ }, null, 'code', 'fable', 'sonnet', 'high', state('starting'), () => now, callback => { tick = callback; return 1 as any; });
  const first = view.render(60).join('\n'); now = 150; tick!(); const second = view.render(60).join('\n');
  assert.notEqual(first.split('\n')[1][1], second.split('\n')[1][1]);
  for (const phase of ['starting', 'delegating', 'synthesizing', 'validating', 'cancelling'] as const) { view.update(state(phase)); assert.match(view.render(60).join('\n'), /Stage:/); }
  view.dispose(); view.dispose(); const before = renders; tick!(); assert.equal(renders, before); assert.equal(cleared, false);
});

test('first escape arms cancellation, second within window aborts once', () => {
  let aborts = 0; const view = createProgressView({ requestRender() {} }, null, 'repo', 'fable', 'sonnet', 'high', state(), () => 0);
  view.onAbort = () => aborts++;
  view.handleInput('');
  assert.equal(view.signal.aborted, false); assert.equal(aborts, 0);
  assert.match(view.render(60).join('\n'), /Press Esc again to cancel/);
  view.handleInput('');
  assert.equal(view.signal.aborted, true); assert.equal(aborts, 1);
  assert.match(view.render(60).join('\n'), /Cancelling Claude process/);
  view.handleInput('');
  assert.equal(aborts, 1); view.dispose();
});

test('escape re-arms after the 3s window expires', () => {
  let now = 0; let aborts = 0; const view = createProgressView({ requestRender() {} }, null, 'repo', 'fable', 'sonnet', 'high', state(), () => now);
  view.onAbort = () => aborts++;
  view.handleInput('');            // arm at t=0
  now = 3_001;                           // advance past the 3000 ms window
  view.handleInput('');            // window expired → re-arm, no abort
  assert.equal(view.signal.aborted, false); assert.equal(aborts, 0);
  assert.match(view.render(60).join('\n'), /Press Esc again to cancel/);
  view.handleInput('');            // second press within the new window → abort
  assert.equal(view.signal.aborted, true); assert.equal(aborts, 1); view.dispose();
});

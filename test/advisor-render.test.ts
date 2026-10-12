import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAdvice,
  extractGuidance,
  recommendationPreview,
  renderAdviceMessage,
  renderAdvisorCall,
  renderAdvisorResult,
} from '../src/advisor-render.ts';
import { wrapAdvice } from '../src/advise.ts';
import { registerExtension } from '../src/index.ts';

const GUIDANCE = [
  '# Advisor guidance',
  'Verdict: revise',
  '## Recommendation',
  'Restore the original assertion and fix the divisor in src/math.js instead of changing the test.',
  'Then rerun the test.',
  '## Key risks',
  '- Masking a real bug.',
  '## Next steps',
  '1. Revert the test.',
  '## Evidence checked',
  '- src/math.js:2',
].join('\n');

const toolText = (guidance = GUIDANCE, verdict = 'revise', note = 'Advisor consultations remaining: 1 of 2.') =>
  `${wrapAdvice(guidance, verdict as any)}\n\n${note}`;
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const marked = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `*${text}*` };

test('guidance extraction drops the untrusted wrapper and the budget note', () => {
  const guidance = extractGuidance(toolText());
  assert.equal(guidance, GUIDANCE);
  assert.equal(extractGuidance(toolText('Just add a test first.', 'unknown', 'Advisor budget is now used up; the cc_advise tool is disabled until the user runs /cc-advisor on again.')), 'Just add a test first.');
  assert.equal(recommendationPreview(GUIDANCE), 'Restore the original assertion and fix the divisor in src/math.js instead of changing the test.');
  assert.equal(recommendationPreview('# Advisor guidance\nVerdict: proceed\n- Keep going.'), 'Keep going.');
});

test('call row is static (export-safe) and the live Advising… state comes from the partial result', () => {
  const call = renderAdvisorCall({ question: 'Change the test to expect 3?\nmore detail' }, plain, {}).render(80);
  assert.deepEqual(call, ['◆ Advisor (fable · high)', '  Q: Change the test to expect 3?']);
  const partial = renderAdvisorResult({ content: [{ type: 'text', text: 'Advising…' }], details: { phase: 'advising' } }, { expanded: false, isPartial: true }, plain, {}).render(80);
  assert.deepEqual(partial, ['◌ Advising (fable · high)…']);
  const done = renderAdvisorCall({ question: 'Q1\nline two', focus: 'tests' }, plain, { expanded: true }).render(80);
  assert.equal(done[0], '◆ Advisor (fable · high)');
  assert.ok(done.includes('  Q: Q1') && done.includes('line two'));
  assert.ok(done.includes('  Focus: tests'));
});

test('reviewed result is collapsed to a status line and a recommendation preview', () => {
  const details = { verdict: 'revise', durationMs: 22_400, remaining: 1, total: 2 };
  const collapsed = renderAdvisorResult({ content: [{ type: 'text', text: toolText() }], details }, { expanded: false }, plain, {}).render(120);
  assert.deepEqual(collapsed, [
    '✓ Advisor reviewed · verdict: revise · 22s · 1 of 2 left',
    '  Restore the original assertion and fix the divisor in src/math.js instead of changing the test.',
    '  (expand the row to read the full guidance)',
  ]);
  const expanded = renderAdvisorResult({ content: [{ type: 'text', text: toolText() }], details }, { expanded: true }, plain, {}).render(120);
  assert.equal(expanded[0], '✓ Advisor reviewed · verdict: revise · 22s · 1 of 2 left');
  const body = expanded.join('\n');
  assert.match(body, /## Key risks\n- Masking a real bug\./);
  assert.doesNotMatch(body, /untrusted|consultations remaining/);
});

test('declined, unavailable, and not-run outcomes are distinct', () => {
  const declined = describeAdvice({ text: toolText('# Advisor guidance\nVerdict: decline\n## Recommendation\nNot enough evidence: share the failing output.', 'decline'), details: { verdict: 'decline', durationMs: 9_000 } });
  assert.equal(declined.status, 'declined');
  assert.equal(declined.headline, '○ Advisor declined to advise · 9s');
  assert.equal(declined.preview, 'Not enough evidence: share the failing output.');

  const unavailable = describeAdvice({ text: '[PROCESS_TIMEOUT] Claude Code advisor timed out. Ask a narrower question.', isError: true });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.headline, '✗ Advisor unavailable (PROCESS_TIMEOUT)');
  assert.equal(unavailable.preview, 'Claude Code advisor timed out. Ask a narrower question.');

  for (const code of ['CC_ADVISOR_NOT_ENABLED', 'CC_ADVISOR_BUDGET_EXHAUSTED', 'CC_ADVISOR_RATE_LIMITED', 'ALREADY_RUNNING']) {
    const view = describeAdvice({ text: `[${code}] message`, isError: true });
    assert.equal(view.status, 'not-run', code);
    assert.equal(view.headline, `✗ Advisor not run (${code})`);
  }
  assert.equal(describeAdvice({ text: 'no code here', isError: true }).headline, '✗ Advisor unavailable (PROCESS_FAILED)');

  const errorRow = renderAdvisorResult({ content: [{ type: 'text', text: '[PROCESS_FAILED] boom' }], details: undefined }, { expanded: false }, marked, { isError: true }).render(80);
  assert.deepEqual(errorRow, ['<error>✗ Advisor unavailable (PROCESS_FAILED)</error>', '<muted>  boom</muted>']);
});

test('rendered lines respect the width: status truncates, expanded guidance wraps', () => {
  const details = { verdict: 'revise', durationMs: 1_000, remaining: 0, total: 1 };
  const result = { content: [{ type: 'text', text: toolText() }], details };
  for (const width of [20, 40, 72]) {
    for (const expanded of [false, true]) {
      for (const line of renderAdvisorResult(result, { expanded }, plain, {}).render(width)) {
        assert.ok(line.length <= width, `${width}/${expanded}: ${line}`);
      }
    }
    for (const line of renderAdvisorCall({ question: 'x'.repeat(200) }, plain, {}).render(width)) assert.ok(line.length <= width);
  }
  const wrapped = renderAdvisorResult(result, { expanded: true }, plain, {}).render(40).join('\n');
  assert.match(wrapped, /Restore the original assertion and fix/);
});

test('theme colours and bold are applied per status', () => {
  const call = renderAdvisorCall({ question: 'q' }, marked, {}).render(80);
  assert.equal(call[0], '<toolTitle>*◆ Advisor (fable · high)*</toolTitle>');
  const partial = renderAdvisorResult({ content: [], details: { phase: 'advising' } }, { isPartial: true }, marked, {}).render(80);
  assert.equal(partial[0], '<accent>◌ Advising (fable · high)…</accent>');
  const declined = renderAdvisorResult({ content: [{ type: 'text', text: toolText('Verdict: decline', 'decline') }], details: { verdict: 'decline' } }, { expanded: false }, marked, {}).render(80);
  assert.match(declined[0], /^<warning>○ Advisor declined to advise<\/warning>$/);
});

test('/cc-review advise messages get a compact renderer with a header', () => {
  const lines = renderAdviceMessage({ content: wrapAdvice(GUIDANCE, 'revise'), details: { verdict: 'revise', durationMs: 36_000 } }, { expanded: false }, plain).render(120);
  assert.deepEqual(lines, [
    '◆ Claude Code advisor (fable · high) · /cc-review advise',
    '✓ Advisor reviewed · verdict: revise · 36s',
    '  Restore the original assertion and fix the divisor in src/math.js instead of changing the test.',
    '  (expand the row to read the full guidance)',
  ]);
});

test('extension wires the tool renderers and the cc-advise-result message renderer', () => {
  const tools: any[] = [];
  const renderers = new Map<string, any>();
  registerExtension({
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    sendMessage: () => {},
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    on: () => {},
    registerMessageRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
  } as any);
  const tool = tools.find(item => item.name === 'cc_advise');
  assert.equal(typeof tool.renderCall, 'function');
  assert.equal(typeof tool.renderResult, 'function');
  assert.deepEqual([...renderers.keys()], ['cc-advise-result']);
  const rendered = renderers.get('cc-advise-result')({ content: wrapAdvice(GUIDANCE, 'revise'), details: { verdict: 'revise' } }, { expanded: true }, plain).render(100);
  assert.match(rendered.join('\n'), /## Evidence checked/);
  const call = tool.renderCall({ question: 'q' }, plain, { isPartial: true }).render(80);
  assert.equal(call[0], '◆ Advisor (fable · high)');
});

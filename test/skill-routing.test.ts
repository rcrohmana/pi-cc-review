import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skillPath = new URL('../../../skills/cc-review-routing/SKILL.md', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

test('global skill has exact gated routing and anti-delegation instructions', async () => {
  const source = await readFile(skillPath, 'utf8');
  assert.match(source, /^---\nname: cc-review-routing\n/m);
  assert.match(source, /cc_review_approval/);
  assert.match(source, /phase:\s*"request"/);
  assert.match(source, /phase:\s*"execute"/);
  assert.match(source, /Do not call `execute` in the same assistant turn/i);
  assert.match(source, /pi-intercom|another session|subagent|direct Claude|direct API/i);
  assert.match(source, /ya.*yes.*lanjut.*approve|yes.*ya.*lanjut.*approve/is);
  assert.match(source, /explicit.*\/cc-review.*direct|direct.*\/cc-review/is);
  assert.match(source, /ambiguous.*clarif/i);
  assert.match(source, /never run.*Claude|must not.*Claude|does not run.*Claude/i);
  assert.match(source, /must not.*process|no direct.*API/i);
  assert.match(source, /notebook.*spec|spec.*notebook/i);
  assert.match(source, /exactly one leading `@`.*without that (mention )?marker/is);
  assert.match(source, /code.*--file.*forbidden|repo.*--file.*forbidden|never.*code.*--file/is);
  assert.match(source, /quoted.*text|repository\/session.*content|assistant.*prose|tool output|original request/is);
  assert.match(source, /Do not send cc-review work to `?pi-intercom`?/i);
  assert.match(source, /gated shared runner|same existing read-only review workflow/i);
  assert.match(source, /actual external report.*tool content/i);
  assert.doesNotMatch(source, /sendUserMessage|queues the existing/i);
});

test('README documents routing, reload invalidation, and raw semantics', async () => {
  const readme = await readFile(readmePath, 'utf8');
  assert.match(readme, /Natural-language confirmation routing/);
  assert.match(readme, /cc-review-routing\/SKILL\.md/);
  assert.match(readme, /ya.*yes.*lanjut.*approve/is);
  assert.match(readme, /same-turn.*rejected|same-turn.*execute.*rejected/is);
  assert.match(readme, /\/reload/);
  assert.match(readme, /--raw/);
  assert.match(readme, /leading `@`.*without that marker/is);
  assert.match(readme, /shared gated runner|existing review workflow through the shared/i);
  assert.match(readme, /synthetic.*slash-command|synthetic `?\/cc-review/i);
  assert.match(readme, /raw.*tool termination|tool termination.*raw/is);
  assert.doesNotMatch(readme, /sendUserMessage/);
  assert.match(readme, /fake.*live Claude|no paid\/live Claude/i);
});

test('skill explains advisor consultations without weakening the review gate', async () => {
  const source = await readFile(skillPath, 'utf8');
  assert.match(source, /^description: .*consult the Claude Code advisor/m);
  assert.match(source, /## Advisor consultations \(`cc_advise`\)/);
  assert.match(source, /never create an approval request for advice/i);
  assert.match(source, /before committing to a non-trivial approach/i);
  assert.match(source, /same error or failed attempt has recurred twice/i);
  assert.match(source, /before declaring a multi-step task complete/i);
  assert.match(source, /changed a test, an assertion, or an expected value/i);
  assert.match(source, /never more than once per assistant message/i);
  assert.match(source, /do not enable it yourself/i);
  assert.match(source, /Only a user-typed slash command enables the advisor/);
  assert.match(source, /\/cc-advisor on \[--max N\]/);
  assert.match(source, /\/cc-review advise --focus/);
  assert.match(source, /Never use `cc_advise` to bypass the review gate/);
  assert.match(source, /For reviews, the only permitted route is `cc_review_approval`/);
});

test('tool guidelines and skill agree on when to consult', async () => {
  const { ADVISOR_PROMPT_GUIDELINES } = await import('../src/advisor-tool.ts');
  const skill = await readFile(skillPath, 'utf8');
  const guidelines = ADVISOR_PROMPT_GUIDELINES.join('\n');
  for (const phrase of [
    'before committing to a non-trivial approach',
    'choosing between alternative designs',
    'before writing the implementation, not after',
    'same error or failed attempt has recurred twice',
    'before declaring a multi-step task complete',
    'changed a test, an assertion, or an expected value',
    'consult the advisor',
    'trivial edits, routine steps',
    'cc_review_approval',
  ]) {
    assert.ok(guidelines.includes(phrase), `guidelines: ${phrase}`);
    assert.ok(skill.includes(phrase), `skill: ${phrase}`);
  }
  assert.ok(ADVISOR_PROMPT_GUIDELINES.every((line: string) => line.includes('cc_advise')), 'each guideline names the tool');
});

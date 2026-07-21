import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from '../src/args.ts';
import { approvalParametersSchema, validateApprovalInput } from '../src/approval-schema.ts';
import { canonicalizeProposal, quoteArg } from '../src/approval-canonical.ts';

const validRequest = {
  phase: 'request',
  mode: 'spec',
  file: 'docs/spec.md',
  focus: 'race conditions',
  deep: true,
  raw: false,
} as const;
const validExecute = { phase: 'execute', requestId: 'opaque-test-id' } as const;

type SchemaNode = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
};

function acceptsStrictSchema(schema: SchemaNode, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.some(branch => acceptsStrictSchema(branch, value));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return schema.type !== 'object';
  if (schema.type !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (schema.required?.some(key => !(key in object))) return false;
  if (schema.additionalProperties === false && Object.keys(object).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  return Object.entries(schema.properties ?? {}).every(([key, property]) => !(key in object) || acceptsStrictSchema(property, object[key]))
    && (schema.const === undefined || value === schema.const)
    && (schema.enum === undefined || schema.enum.includes(value));
}

function schemaAccepts(schema: SchemaNode, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.some(branch => schemaAccepts(branch, value));
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some(key => !(key in object))) return false;
    if (schema.additionalProperties === false && Object.keys(object).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, property]) => !(key in object) || schemaAccepts(property, object[key]));
  }
  if (schema.type === 'string') {
    return typeof value === 'string'
      && (schema.const === undefined || value === schema.const)
      && (schema.enum === undefined || schema.enum.includes(value))
      && (schema.minLength === undefined || value.length >= schema.minLength)
      && (schema.maxLength === undefined || value.length <= schema.maxLength);
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return schema.const === undefined || value === schema.const;
}

test('schema is a strict two-branch JSON Schema without public target', () => {
  const schema = approvalParametersSchema as unknown as SchemaNode & { oneOf: SchemaNode[] };
  assert.equal(schema.type, 'object');
  assert.equal(schema.oneOf.length, 2);
  assert.ok(schema.oneOf.every(branch => branch.additionalProperties === false));
  assert.ok(schema.oneOf[0].required?.includes('phase'));
  assert.ok(schema.oneOf[1].required?.includes('requestId'));
  assert.equal('target' in (schema.oneOf[0].properties ?? {}), false);
  assert.equal('target' in (schema.oneOf[1].properties ?? {}), false);
  assert.equal(schemaAccepts(schema, validRequest), true);
  assert.equal(schemaAccepts(schema, validExecute), true);
  assert.equal(schemaAccepts(schema, { ...validRequest, target: 'C:/secret' }), false);
  assert.equal(schemaAccepts(schema, { phase: 'execute', mode: 'plan', requestId: 'x' }), false);
  assert.equal(schemaAccepts(schema, { phase: 'request', requestId: 'x' }), false);
  assert.equal(schemaAccepts(schema, { phase: 'execute', requestId: 7 }), false);
  assert.equal(acceptsStrictSchema(schema, validRequest), true);
});

test('manual validation rejects unknown and phase-incompatible fields', () => {
  assert.deepEqual(validateApprovalInput(validRequest), validRequest);
  assert.deepEqual(validateApprovalInput(validExecute), validExecute);
  for (const value of [
    { phase: 'request', requestId: 'wrong-phase' },
    { phase: 'execute', mode: 'plan', requestId: 'wrong-fields' },
    { phase: 'request', target: 'C:/secret' },
    { phase: 'execute', requestId: 'ok', approved: true },
    { mode: 'plan' },
    { phase: 'execute', requestId: '' },
    { phase: 'execute', requestId: 'x'.repeat(129) },
  ]) assert.throws(
    () => validateApprovalInput(value),
    error => typeof error === 'object' && error !== null && 'code' in error && String(error.code).startsWith('CC_REVIEW_'),
  );
});

test('quoteArg follows the no-escape parser-safe algorithm', () => {
  assert.equal(quoteArg('plain'), '"plain"');
  assert.equal(quoteArg('white space'), '"white space"');
  assert.equal(quoteArg('--leading-flag'), '"--leading-flag"');
  assert.equal(quoteArg("one'quote"), '"one\'quote"');
  assert.equal(quoteArg('one"quote'), "'one\"quote'");
  assert.throws(
    () => quoteArg('both"and\''),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_UNENCODABLE_ARGUMENT',
  );
  for (const value of ['line\nfeed', 'carriage\rreturn', 'nul\u0000byte', 'tab\tbyte', '\u001bescape', '\u007fdelete']) {
    assert.throws(
      () => quoteArg(value),
      error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_INVALID_OPTIONS',
    );
  }
  assert.throws(
    () => quoteArg(''),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_INVALID_OPTIONS',
  );
});

test('canonical command round-trips through the existing parser', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cc-approval-canonical-'));
  try {
    await writeFile(join(workspace, 'spec file.md'), '# spec');
    const proposal = await canonicalizeProposal({
      phase: 'request', mode: 'spec', file: 'spec file.md', focus: '--focus has whitespace', deep: true, raw: true,
    }, workspace);
    const parsed = parseArgs(proposal.canonicalTail);
    assert.deepEqual(
      { mode: parsed.mode, file: parsed.file, base: parsed.base, focus: parsed.focus, deep: parsed.deep, raw: parsed.raw },
      { ...proposal.canonicalArgs, base: proposal.canonicalArgs.base },
    );
    assert.equal(proposal.canonicalCommand, `/cc-review ${proposal.canonicalTail}`);
    assert.ok(proposal.canonicalCommand.length <= 16_000);
    assert.match(proposal.canonicalTail, /^spec --file /);
    assert.match(proposal.canonicalTail, / --focus /);
    assert.match(proposal.canonicalTail, / --deep --raw$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('canonicalization handles base and rejects illegal combinations and extra flags', async () => {
  const proposal = await canonicalizeProposal({ phase: 'request', mode: 'code', base: 'main branch', focus: 'focus with spaces' }, process.cwd());
  const parsed = parseArgs(proposal.canonicalTail);
  assert.equal(parsed.base, 'main branch');
  assert.equal(parsed.focus, 'focus with spaces');
  assert.throws(() => parseArgs(`${proposal.canonicalTail} --extra`), /Unknown argument/);
  assert.throws(() => parseArgs('plan --raw --raw'), /Duplicate --raw/);

  const reject = async (input: unknown) => assert.rejects(
    () => canonicalizeProposal(input as never, process.cwd()),
    error => typeof error === 'object' && error !== null && 'code' in error && ['CC_REVIEW_INVALID_OPTIONS', 'USAGE_ERROR'].includes(String(error.code)),
  );
  await reject({ phase: 'request', mode: 'repo', file: 'x.md' });
  await reject({ phase: 'request', mode: 'spec', base: 'main' });
});

test('canonicalization strips one leading @ file mention before contained validation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cc-approval-at-file-'));
  const notebook = 'PVT_Calculator_Kunci_Jawaban.ipynb';
  try {
    await writeFile(join(workspace, notebook), '{}\n');
    const interiorFile = 'PVT@Calculator.ipynb';
    await writeFile(join(workspace, interiorFile), '{}\n');
    const proposal = await canonicalizeProposal({
      phase: 'request',
      mode: 'spec',
      file: `@${notebook}`,
    }, workspace);
    assert.equal(proposal.file, notebook);
    assert.equal(proposal.targetPath, notebook);
    assert.equal(proposal.canonicalArgs.file, notebook);
    assert.equal(proposal.canonicalCommand, `/cc-review spec --file "${notebook}"`);
    const interior = await canonicalizeProposal({ phase: 'request', mode: 'spec', file: interiorFile }, workspace);
    assert.equal(interior.file, interiorFile);
    await assert.rejects(
      () => canonicalizeProposal({ phase: 'request', mode: 'spec', file: `@@${notebook}` }, workspace),
      error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ARTIFACT_NOT_FOUND',
    );
    const nonFileMention = await canonicalizeProposal({
      phase: 'request', mode: 'code', base: '@main', focus: '@focus',
    }, workspace);
    assert.equal(nonFileMention.base, '@main');
    assert.equal(nonFileMention.focus, '@focus');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a lone @ file mention is rejected as an empty path', async () => {
  await assert.rejects(
    () => canonicalizeProposal({ phase: 'request', mode: 'spec', file: '@' }, process.cwd()),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_INVALID_OPTIONS',
  );
});

test('file mention normalization preserves unsafe argument and containment rejection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cc-approval-at-safety-'));
  try {
    await assert.rejects(
      () => canonicalizeProposal({ phase: 'request', mode: 'spec', file: '@line\nfeed' }, workspace),
      error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_INVALID_OPTIONS',
    );
    await assert.rejects(
      () => canonicalizeProposal({ phase: 'request', mode: 'spec', file: '@both"and\'' }, workspace),
      error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_UNENCODABLE_ARGUMENT',
    );
    await assert.rejects(
      () => canonicalizeProposal({ phase: 'request', mode: 'spec', file: '@../outside.ipynb' }, workspace),
      error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ARTIFACT_OUTSIDE_WORKSPACE',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, symlink, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundle, cleanupBundle } from '../src/bundle.ts';
import { buildAgents } from '../src/agents.ts';
import { buildContextEntries } from '../src/context.ts';
import { validatedFile } from '../src/args.ts';

test('file-mode context does not require an assistant artifact', () => {
  const context = buildContextEntries([{ message:{ role:'user', content:'review this supplied file' }}], false);
  assert.equal(context.artifact, '');
  assert.match(context.objective, /supplied/);
});
test('bundle cap preserves complete manifest output contract', async () => {
  const bundle = await createBundle({mode:'spec',workingDirectory:'C:/repo',objective:'x'.repeat(300000),artifact:'y'.repeat(300000),context:'z'.repeat(300000),required:['requirements-critic'],truncated:false});
  assert.ok(bundle.bytes <= 500000);
  const manifest = await readFile(bundle.manifestPath,'utf8');
  assert.match(manifest, /Claude Code Review Manifest/);
  assert.match(manifest, /Recommended next actions/);
  await cleanupBundle(bundle.directory);
});
test('repo manifest limits reviewers to the bounded folder snapshot', async () => {
  const bundle = await createBundle({ mode: 'repo', workingDirectory: 'C:/folder', objective: 'review', artifact: 'snapshot', context: '', required: ['correctness-reviewer'] });
  const manifest = await readFile(bundle.manifestPath, 'utf8');
  assert.match(manifest, /folder\/repository/i);
  assert.match(manifest, /bounded artifact snapshot/i);
  assert.match(manifest, /must not claim access to excluded or original files/i);
  await cleanupBundle(bundle.directory);
});

test('bundle byte cap holds for multibyte evidence and reports actual bytes', async () => {
  const bundle = await createBundle({
    mode: 'spec',
    workingDirectory: 'C:/repo',
    objective: 'é'.repeat(300_000),
    artifact: 'é'.repeat(300_000),
    context: 'é'.repeat(300_000),
    required: ['requirements-critic'],
    truncated: false,
  });
  const names = await readdir(bundle.directory);
  let actualBytes = 0;
  for (const name of names) actualBytes += (await stat(join(bundle.directory, name))).size;
  assert.ok(actualBytes <= 500_000);
  assert.equal(bundle.bytes, actualBytes);
  await cleanupBundle(bundle.directory);
});

test('dynamic agent does not use unsupported memory value', () => assert.equal('memory' in buildAgents(['test-reviewer'])['test-reviewer'], false));
test('realpath containment rejects an escaped target deterministically', async () => {
  const operations = {
    realpath: async (path: string) => path.endsWith('workspace') ? '/safe/workspace' : '/outside/secret.md',
    stat: async () => ({ isFile: () => true }),
  };
  await assert.rejects(
    validatedFile('/safe/workspace', 'link.md', operations as any),
    (error: any) => error?.code === 'ARTIFACT_OUTSIDE_WORKSPACE',
  );
});

test('symlink file escape is rejected', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privilege varies');
  const root = await mkdtemp(join(tmpdir(),'cc-root-')); const outside = await mkdtemp(join(tmpdir(),'cc-out-'));
  await writeFile(join(outside,'secret.md'),'secret'); await symlink(join(outside,'secret.md'),join(root,'link.md'));
  await assert.rejects(validatedFile(root,'link.md'));
});

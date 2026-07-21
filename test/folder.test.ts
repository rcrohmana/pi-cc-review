import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFolder } from '../src/folder.ts';
import { LIMITS } from '../src/types.ts';

async function fixture() { return mkdtemp(join(tmpdir(), 'cc-folder-')); }

test('folder snapshot includes safe text in deterministic path order and excludes unsafe content', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'z.ts'), 'export const z = 1;');
    await writeFile(join(root, 'src', 'a.ts'), 'export const answer = 42;');
    await writeFile(join(root, '.env'), 'SECRET_TEST_VALUE');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'generated dependency');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'large.txt'), 'x'.repeat(LIMITS.repoFile + 1));
    const result = await collectFolder(root);
    assert.match(result.artifact, /src\/a\.ts/); assert.match(result.artifact, /answer = 42/);
    assert.ok(result.artifact.indexOf('src/a.ts') < result.artifact.indexOf('src/z.ts'));
    assert.doesNotMatch(result.artifact, /SECRET_TEST_VALUE|generated dependency/);
    assert.ok(Buffer.byteLength(result.artifact) <= LIMITS.repoSnapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folder snapshot cap includes final summary bytes', async () => {
  const root = await fixture();
  try {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `file-${i}.txt`), 'x'.repeat(35_972));
    const result = await collectFolder(root);
    assert.ok(Buffer.byteLength(result.artifact) <= LIMITS.repoSnapshot);
    assert.equal(result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folder includes a UTF-8-safe prefix for oversized eligible text', async () => {
  const root = await fixture();
  try { await writeFile(join(root, 'large.ts'), `${'é'.repeat(20_100)}TAIL_SECRET`); const result = await collectFolder(root); assert.match(result.artifact, /TRUNCATED: file byte limit/); assert.doesNotMatch(result.artifact, /TAIL_SECRET/); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.artifact) <= LIMITS.repoSnapshot); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('folder entry cap counts traversed directories as well as files', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'a.txt'), 'eligible');
    for (let i = 0; i < 1_100; i++) await mkdir(join(root, `empty-${i}`));
    const result = await collectFolder(root);
    assert.equal(result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folder skips symlinks', async (t) => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'safe.txt'), 'safe');
    try { await symlink(join(root, 'safe.txt'), join(root, 'linked.txt')); }
    catch { t.skip('Windows symlink privilege unavailable'); return; }
    const result = await collectFolder(root);
    assert.doesNotMatch(result.artifact, /linked\.txt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folder rejects no eligible text', async () => {
  const root = await fixture();
  try { await writeFile(join(root, '.env'), 'x'); await assert.rejects(() => collectFolder(root), (error: any) => error.code === 'NO_REVIEWABLE_CONTENT'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGit, createUtf8Accumulator } from '../src/git.ts';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return exec('git', args, { cwd, windowsHide: true });
}

test('UTF-8 accumulator reconstructs code points split across chunks', () => {
  const source = Buffer.from('Aé漢Z', 'utf8');
  const accumulator = createUtf8Accumulator();

  accumulator.push(source.subarray(0, 2));
  accumulator.push(source.subarray(2, 4));
  accumulator.push(source.subarray(4, 5));
  accumulator.push(source.subarray(5));

  const decoded = accumulator.finish();
  assert.equal(decoded, 'Aé漢Z');
  assert.doesNotMatch(decoded, /�/);
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'cc-git-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'cc-review@example.invalid');
  await git(root, 'config', 'user.name', 'CC Review Test');
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-qm', 'initial');
  const { stdout } = await git(root, 'rev-parse', 'HEAD');
  return { root, base: stdout.trim() };
}

test('non-repository and clean repository return distinct errors', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'cc-not-git-'));
  const repo = await repository();
  try {
    await assert.rejects(collectGit(outside), (error: any) => error?.code === 'NOT_A_GIT_REPOSITORY');
    await assert.rejects(collectGit(repo.root), (error: any) => error?.code === 'NO_CODE_CHANGES');
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(repo.root, { recursive: true, force: true });
  }
});

test('collector reports branch, HEAD, unstaged, staged, and untracked paths', async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo.root, 'tracked.txt'), 'unstaged\n');
    await writeFile(join(repo.root, 'staged.txt'), 'staged\n');
    await git(repo.root, 'add', 'staged.txt');
    await writeFile(join(repo.root, 'untracked ü.txt'), 'untracked\n');

    const evidence = await collectGit(repo.root);

    assert.equal(evidence.root.replaceAll('\\', '/'), repo.root.replaceAll('\\', '/'));
    assert.ok(evidence.branch.length > 0);
    assert.match(evidence.head, /^[0-9a-f]{40}$/);
    assert.match(evidence.working, /unstaged/);
    assert.match(evidence.staged, /staged/);
    assert.match(evidence.status, /untracked ü\.txt/);
    assert.match(evidence.changedFiles, /tracked\.txt/);
    assert.match(evidence.changedFiles, /staged\.txt/);
    assert.match(evidence.changedFiles, /untracked ü\.txt/);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test('base comparison includes committed diff and changed-file names', async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo.root, 'after-base.txt'), 'committed after base\n');
    await git(repo.root, 'add', 'after-base.txt');
    await git(repo.root, 'commit', '-qm', 'after base');

    const evidence = await collectGit(repo.root, repo.base);

    assert.match(evidence.baseDiff, /committed after base/);
    assert.match(evidence.changedFiles, /after-base\.txt/);
    assert.equal(evidence.baseRef, repo.base);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test('invalid base is reported as INVALID_BASE_REF', async () => {
  const repo = await repository();
  try {
    await assert.rejects(collectGit(repo.root, 'definitely-not-a-ref'), (error: any) => error?.code === 'INVALID_BASE_REF');
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test('large patches are visibly truncated', async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo.root, 'tracked.txt'), `${'x'.repeat(260_000)}\n`);
    const evidence = await collectGit(repo.root);
    assert.equal(evidence.truncated, true);
    assert.match(evidence.working, /TRUNCATED: patch limit/);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

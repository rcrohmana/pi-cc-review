import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/process.ts';

async function script(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-process-'));
  const path = join(directory, 'fixture.mjs');
  await writeFile(path, source);
  return { directory, path };
}

test('spawn error is actionable and settles once', async () => {
  await assert.rejects(
    runProcess(`missing-cc-review-${Date.now()}`, [], process.cwd(), 1_000),
    (error: any) => error?.code === 'CLAUDE_NOT_FOUND',
  );
});

test('stdout capture is bounded by bytes, including multibyte output', async () => {
  const fixture = await script("process.stdout.write('é'.repeat(600_000));");
  try {
    await assert.rejects(
      runProcess(process.execPath, [fixture.path], process.cwd(), 5_000),
      (error: any) => error?.code === 'OUTPUT_TOO_LARGE',
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('disk-backed stdout can exceed the in-memory capture limit', async () => {
  const fixture = await script("process.stdout.write('é'.repeat(600_000));");
  const stdoutFile = join(fixture.directory, 'stream.ndjson');
  try {
    const result = await runProcess(
      process.execPath,
      [fixture.path],
      process.cwd(),
      5_000,
      { stdoutFile },
    );

    assert.equal(result.code, 0);
    assert.equal(Buffer.byteLength(await readFile(stdoutFile)), 1_200_000);
    assert.ok(Buffer.byteLength(result.stdout) < 1_000_000);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('disk-backed stdout is flushed and line callbacks remain UTF-8 safe', async () => {
  const fixture = await script("process.stdout.write(Buffer.from('{\\\"x\\\":\\\"é')); setTimeout(()=>process.stdout.write(Buffer.from('\\\"}\\nsecond\\n')), 5);");
  const stdoutFile = join(fixture.directory, 'stream.ndjson');
  const lines: string[] = [];
  try {
    const result = await runProcess(
      process.execPath,
      [fixture.path],
      process.cwd(),
      5_000,
      { stdoutFile, onStdoutLine: line => lines.push(line) },
    );

    assert.equal(result.code, 0);
    assert.equal(await readFile(stdoutFile, 'utf8'), '{"x":"é"}\nsecond\n');
    assert.deepEqual(lines, ['{"x":"é"}', 'second']);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('stream capture failure is typed and does not report success', async () => {
  const fixture = await script("setInterval(() => process.stdout.write('tick\\n'), 5);");
  const stdoutFile = join(fixture.directory, 'missing-parent', 'stream.ndjson');
  try {
    await assert.rejects(
      runProcess(
        process.execPath,
        [fixture.path],
        process.cwd(),
        5_000,
        { stdoutFile },
      ),
      (error: any) => error?.code === 'STREAM_CAPTURE_FAILED',
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('stdout callback receives only complete UTF-8 lines and isolates callback errors', async () => {
  const fixture = await script("process.stdout.write(Buffer.from('{\\\"x\\\":\\\"é')); setTimeout(()=>process.stdout.write(Buffer.from('\\\"}\\nsecond\\n')), 5);");
  const lines: string[] = [];
  try { const result = await runProcess(process.execPath, [fixture.path], process.cwd(), 5_000, { onStdoutLine: line => { lines.push(line); if (line === 'second') throw new Error('UI failure'); } }); assert.deepEqual(lines, ['{\"x\":\"é\"}', 'second']); assert.equal(result.stdout, '{\"x\":\"é\"}\nsecond\n'); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('abort signal settles once with typed cancellation', async () => {
  const fixture = await script("setInterval(() => process.stdout.write('tick\\n'), 10);"); const controller = new AbortController();
  try { const pending = runProcess(process.execPath, [fixture.path], process.cwd(), 5_000, { signal: controller.signal }); setTimeout(() => controller.abort(), 30); await assert.rejects(pending, (error: any) => error?.code === 'PROCESS_CANCELLED'); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('already aborted signal does not report a successful process', async () => {
  const fixture = await script("setInterval(() => {}, 1000);"); const controller = new AbortController(); controller.abort();
  try { await assert.rejects(runProcess(process.execPath, [fixture.path], process.cwd(), 5_000, { signal: controller.signal }), (error: any) => error?.code === 'PROCESS_CANCELLED'); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('abort terminates a spawned child process tree', async t => {
  if (process.platform === 'win32') return t.skip('PID existence check is unreliable after taskkill on Windows');
  const fixture = await script("import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); writeFileSync(process.argv[2],String(child.pid)); setInterval(()=>{},1000);");
  const pidFile = join(fixture.directory, 'child.pid'); const controller = new AbortController();
  try { const pending = runProcess(process.execPath, [fixture.path, pidFile], process.cwd(), 5_000, { signal: controller.signal }); for (let i=0;i<40;i++) { try { await (await import('node:fs/promises')).access(pidFile); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } } controller.abort(); await assert.rejects(pending, (error: any) => error?.code === 'PROCESS_CANCELLED'); const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8')); let alive = true; for (let i=0;i<40&&alive;i++) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch { alive = false; } } assert.equal(alive, false); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('timeout terminates the process and returns bounded diagnostics', async () => {
  const fixture = await script("process.stdout.write('started'); setInterval(() => {}, 1_000);");
  try {
    const result = await runProcess(process.execPath, [fixture.path], process.cwd(), 50);
    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.match(result.stdout, /started/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

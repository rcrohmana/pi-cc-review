import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { COORDINATOR_MODEL, REVIEWER_MODEL, REVIEW_EFFORT } from './config.ts';
import { ReviewError, type ReviewArgs } from './types.ts';

interface FileSystemOperations {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

const defaultFileSystem: FileSystemOperations = { realpath, stat };

export const HELP = `/cc-review [auto|plan|spec|code|repo] [--file <path>] [--base <git-ref>] [--focus <text>] [--deep] [--raw] [--keep-bundle] [--help]

Read-only Claude Code second-opinion review. Invokes Claude Code and consumes
account usage: 1× ${COORDINATOR_MODEL} coordinator + 2–3× ${REVIEWER_MODEL} reviewers at ${REVIEW_EFFORT} effort.

Modes:
  auto  (default) Review Git changes; falls back to plan when none exist
  plan  Review the latest substantial assistant artifact in this Pi session
  spec  Review a specification artifact (commonly with --file)
  code  Review working-tree, staged, and optional --base Git changes
  repo  Review a bounded read-only snapshot of the current folder (no Git needed)

Options:
  --file <path>   Use this file as the review artifact (plan and spec only)
  --base <ref>    Also diff against this Git ref (code and auto only)
  --focus <text>  Reviewer focus, quoted, max 2,000 characters
  --deep          Add a third reviewer (security/risk) and a higher turn cap
  --raw           Display the review without triggering a Pi follow-up turn
  --keep-bundle   Keep the temporary evidence bundle and raw stream (stream.ndjson) and report the path
  --help          Show this help

Examples:
  /cc-review repo --deep --focus "correctness, security, tests"
  /cc-review code --base main
  /cc-review spec --file docs/spec.md`;
function tokens(input: string) {
  const output: string[] = [];
  let quote = '';
  let value = '';

  for (const character of input) {
    if (quote) {
      if (character === quote) quote = '';
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (value) {
        output.push(value);
        value = '';
      }
    } else {
      value += character;
    }
  }

  if (quote) throw new ReviewError('USAGE_ERROR', 'Unclosed quote.');
  if (value) output.push(value);
  return output;
}
export function parseArgs(input: string): ReviewArgs {
  const args = tokens(input);
  const result: ReviewArgs = {
    mode: 'auto',
    deep: false,
    raw: false,
    keepBundle: false,
    help: false,
  };
  let modeSeen = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--deep') { if (result.deep) throw new ReviewError('USAGE_ERROR', 'Duplicate --deep.'); result.deep = true; }
    else if (arg === '--raw') { if (result.raw) throw new ReviewError('USAGE_ERROR', 'Duplicate --raw.'); result.raw = true; }
    else if (arg === '--keep-bundle') { if (result.keepBundle) throw new ReviewError('USAGE_ERROR', 'Duplicate --keep-bundle.'); result.keepBundle = true; }
    else if (arg === '--file' || arg === '--base' || arg === '--focus') {
      const value = args[++index];
      if (!value) throw new ReviewError('USAGE_ERROR', `Missing value for ${arg}.`);
      const key = arg.slice(2) as 'file' | 'base' | 'focus';
      if (result[key]) throw new ReviewError('USAGE_ERROR', `Duplicate ${arg}.`);
      result[key] = value;
    } else if (['auto', 'plan', 'spec', 'code', 'repo'].includes(arg) && !modeSeen) {
      result.mode = arg as ReviewArgs['mode'];
      modeSeen = true;
    } else {
      throw new ReviewError('USAGE_ERROR', `Unknown argument: ${arg}`);
    }
  }

  if (result.file && result.mode !== 'plan' && result.mode !== 'spec') {
    throw new ReviewError('USAGE_ERROR', '--file is only valid for plan or spec review.');
  }
  if (result.base && result.mode !== 'code' && result.mode !== 'auto') {
    throw new ReviewError('USAGE_ERROR', '--base is only valid for code review.');
  }
  if ((result.focus?.length ?? 0) > 2_000) {
    throw new ReviewError('USAGE_ERROR', '--focus exceeds 2,000 characters.');
  }
  return result;
}
export function isContainedRelative(rel: string, pathOps: { sep: string; isAbsolute(path: string): boolean } = { sep, isAbsolute }) {
  return rel !== '..' && !rel.startsWith(`..${pathOps.sep}`) && !pathOps.isAbsolute(rel);
}
export function containedFile(cwd: string, file: string) {
  const full = resolve(cwd, file);
  const rel = relative(resolve(cwd), full);
  if (!isContainedRelative(rel)) {
    throw new ReviewError(
      'ARTIFACT_OUTSIDE_WORKSPACE',
      '--file must stay inside the workspace.',
    );
  }
  return full;
}
export async function validatedFile(
  cwd: string,
  file: string,
  operations: FileSystemOperations = defaultFileSystem,
) {
  const requested = containedFile(cwd, file);
  let target: string;
  let workspace: string;

  try {
    [target, workspace] = await Promise.all([
      operations.realpath(requested),
      operations.realpath(cwd),
    ]);
    const info = await operations.stat(target);
    if (!info.isFile()) {
      throw new ReviewError('ARTIFACT_NOT_FOUND', '--file must name a file.');
    }
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('ARTIFACT_NOT_FOUND', 'Specified --file does not exist.');
  }

  const rel = relative(workspace, target);
  if (!isContainedRelative(rel)) {
    throw new ReviewError(
      'ARTIFACT_OUTSIDE_WORKSPACE',
      '--file symlink resolves outside the workspace.',
    );
  }
  return target;
}

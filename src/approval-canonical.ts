import { relative, resolve } from 'node:path';
import { parseArgs, validatedFile } from './args.ts';
import { ReviewError, type ReviewArgs } from './types.ts';
import type { CanonicalArgs, CanonicalProposal, RequestInput } from './approval-types.ts';

const MAX_COMMAND = 16_000;

function assertQuoteSafe(value: string): void {
  if (!value || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', 'Review argument is empty or contains a control character.');
  }
  if (value.includes('"') && value.includes("'")) {
    throw new ReviewError('CC_REVIEW_UNENCODABLE_ARGUMENT', 'Review argument cannot be represented safely.');
  }
}

export function quoteArg(value: string): string {
  assertQuoteSafe(value);
  if (!value.includes('"')) return `"${value}"`;
  return `'${value}'`;
}

function normalizeFileInput(value: string): string {
  const normalized = value.startsWith('@') ? value.slice(1) : value;
  if (!normalized) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', '--file path is empty.');
  }
  assertQuoteSafe(normalized);
  return normalized;
}

function containedRelative(cwd: string, target: string): string {
  const relativePath = relative(resolve(cwd), resolve(target));
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(relativePath)) {
    throw new ReviewError('ARTIFACT_OUTSIDE_WORKSPACE', '--file must stay inside the workspace.');
  }
  return relativePath.replaceAll('\\', '/');
}

function canonicalArgs(input: RequestInput, file?: string): CanonicalArgs {
  const mode = input.mode ?? 'auto';
  const deep = input.deep ?? false;
  const raw = input.raw ?? false;
  if (input.focus !== undefined && (input.focus.length === 0 || input.focus.length > 2_000)) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', '--focus exceeds 2,000 characters or is empty.');
  }
  if (input.base !== undefined && (input.base.length === 0 || input.base.length > 512)) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', '--base is empty or too long.');
  }
  return {
    mode,
    file,
    base: input.base,
    focus: input.focus,
    deep,
    raw,
  };
}

function commandTail(args: CanonicalArgs): string {
  const values: string[] = [args.mode];
  if (args.file !== undefined) values.push('--file', quoteArg(args.file));
  if (args.base !== undefined) values.push('--base', quoteArg(args.base));
  if (args.focus !== undefined) values.push('--focus', quoteArg(args.focus));
  if (args.deep) values.push('--deep');
  if (args.raw) values.push('--raw');
  return values.join(' ');
}

function sameArgs(parsed: ReviewArgs, expected: CanonicalArgs): boolean {
  return parsed.mode === expected.mode
    && parsed.file === expected.file
    && parsed.base === expected.base
    && parsed.focus === expected.focus
    && parsed.deep === expected.deep
    && parsed.raw === expected.raw
    && parsed.keepBundle === false
    && parsed.help === false;
}

export async function canonicalizeProposal(
  input: RequestInput,
  cwd: string,
  validateFile: typeof validatedFile = validatedFile,
): Promise<CanonicalProposal> {
  const mode = input.mode ?? 'auto';
  if (input.file !== undefined && mode !== 'plan' && mode !== 'spec') {
    throw new ReviewError('USAGE_ERROR', '--file is only valid for plan or spec review.');
  }
  if (input.base !== undefined && mode !== 'code' && mode !== 'auto') {
    throw new ReviewError('USAGE_ERROR', '--base is only valid for code review.');
  }
  let file: string | undefined;
  let targetPath: string | undefined;
  if (input.file !== undefined) {
    const normalizedFile = normalizeFileInput(input.file);
    const absolute = await validateFile(cwd, normalizedFile);
    file = containedRelative(cwd, absolute);
    targetPath = file;
  }

  const args = canonicalArgs({ ...input, mode }, file);
  const tail = commandTail(args);
  let parsed: ReviewArgs;
  try {
    parsed = parseArgs(tail);
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', 'Review options could not be parsed.');
  }
  if (!sameArgs(parsed, args)) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', 'Canonical review options did not round-trip.');
  }

  const command = `/cc-review ${tail}`;
  if (command.length > MAX_COMMAND) {
    throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', 'Canonical review command is too long.');
  }
  const targetKind = file !== undefined
    ? 'file'
    : mode === 'repo'
      ? 'folder'
      : mode === 'code' || mode === 'auto'
        ? 'git'
        : 'session-artifact';
  return {
    ...args,
    canonicalTail: tail,
    canonicalCommand: command,
    canonicalArgs: args,
    targetKind,
    ...(targetPath === undefined ? {} : { targetPath }),
  };
}

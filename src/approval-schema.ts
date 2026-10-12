import { ReviewError } from './types.ts';
import type { ApprovalInput, ApprovalMode, ExecuteInput, RequestInput } from './approval-types.ts';

export const approvalParametersSchema = {
  type: 'object',
  properties: {
    phase: { enum: ['request', 'execute'], type: 'string' },
    mode: { enum: ['auto', 'plan', 'spec', 'code', 'repo'], type: 'string' },
    file: { type: 'string', minLength: 1, maxLength: 4_096 },
    base: { type: 'string', minLength: 1, maxLength: 512 },
    focus: { type: 'string', minLength: 1, maxLength: 2_000 },
    deep: { type: 'boolean' },
    raw: { type: 'boolean' },
    requestId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['phase'],
  additionalProperties: false,
} as const;

const modes = new Set<ApprovalMode>(['auto', 'plan', 'spec', 'code', 'repo']);
const requestKeys = new Set(['phase', 'mode', 'file', 'base', 'focus', 'deep', 'raw']);
const executeKeys = new Set(['phase', 'requestId']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message = 'Invalid approval request.'): never {
  throw new ReviewError('CC_REVIEW_INVALID_OPTIONS', message);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateRequest(value: Record<string, unknown>): RequestInput {
  if (value.phase !== 'request') invalid();
  if ([...Object.keys(value)].some(key => !requestKeys.has(key))) invalid();
  if (value.mode !== undefined && (typeof value.mode !== 'string' || !modes.has(value.mode as ApprovalMode))) invalid();
  if (value.file !== undefined && !boundedString(value.file, 4_096)) invalid();
  if (value.base !== undefined && !boundedString(value.base, 512)) invalid();
  if (value.focus !== undefined && !boundedString(value.focus, 2_000)) invalid();
  if (value.deep !== undefined && typeof value.deep !== 'boolean') invalid();
  if (value.raw !== undefined && typeof value.raw !== 'boolean') invalid();
  const file = value.file === undefined ? undefined : value.file as string;
  const base = value.base === undefined ? undefined : value.base as string;
  const focus = value.focus === undefined ? undefined : value.focus as string;
  const deep = value.deep === undefined ? undefined : value.deep as boolean;
  const raw = value.raw === undefined ? undefined : value.raw as boolean;
  return {
    phase: 'request',
    ...(value.mode === undefined ? {} : { mode: value.mode as ApprovalMode }),
    ...(file === undefined ? {} : { file }),
    ...(base === undefined ? {} : { base }),
    ...(focus === undefined ? {} : { focus }),
    ...(deep === undefined ? {} : { deep }),
    ...(raw === undefined ? {} : { raw }),
  };
}

function validateExecute(value: Record<string, unknown>): ExecuteInput {
  if (value.phase !== 'execute') invalid();
  if ([...Object.keys(value)].some(key => !executeKeys.has(key))) invalid();
  if (!boundedString(value.requestId, 128)) invalid('Invalid approval request ID.');
  return { phase: 'execute', requestId: value.requestId };
}

export function validateApprovalInput(value: unknown): ApprovalInput {
  if (!isRecord(value) || typeof value.phase !== 'string') invalid();
  return value.phase === 'request' ? validateRequest(value) : validateExecute(value);
}

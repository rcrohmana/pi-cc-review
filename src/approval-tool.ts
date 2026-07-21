import { createHash } from 'node:crypto';
import { validatedFile } from './args.ts';
import { canonicalizeProposal } from './approval-canonical.ts';
import { approvalParametersSchema, validateApprovalInput } from './approval-schema.ts';
import {
  createOpaqueRequestId,
  evaluateApproval,
  findSourceUser,
} from './approval-state.ts';
import { ReviewError } from './types.ts';
import type {
  ApprovalDecision,
  ApprovalDetails,
  ApprovalInput,
  ApprovalSessionReader,
  ExecuteApprovedReview,
  ApprovalStore,
  ApprovalToolContext,
  ApprovalToolDefinition,
  ApprovalToolResult,
  ExecuteInput,
  PendingApproval,
  RequestInput,
} from './approval-types.ts';

const EXPIRY_MS = 300_000;

function sessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function textResult(text: string, details: ApprovalDetails): ApprovalToolResult {
  return { content: [{ type: 'text', text }], details };
}

function stateDetails(
  phase: 'request' | 'execute',
  record: PendingApproval,
  status: ApprovalDetails['status'],
): ApprovalDetails {
  return {
    kind: 'cc-review-approval',
    phase,
    requestId: record.requestId,
    sessionIdHash: sessionHash(record.sessionId),
    sourceUserEntryId: record.sourceUserEntryId,
    ...(record.sourceUserTimestamp === undefined ? {} : { sourceUserTimestamp: record.sourceUserTimestamp }),
    canonicalCommand: record.canonicalCommand,
    mode: record.mode,
    targetKind: record.targetKind,
    raw: record.raw,
    deep: record.deep,
    expiresAt: record.expiresAt,
    status,
  };
}

function stateError(decision: Exclude<ApprovalDecision, { kind: 'approved' }>): never {
  switch (decision.kind) {
    case 'no-new-user':
      throw new ReviewError('CC_REVIEW_APPROVAL_NO_NEW_USER', 'Wait for one newer user affirmation before executing.');
    case 'not-exact':
      throw new ReviewError('CC_REVIEW_APPROVAL_NOT_EXACT', 'The newer user reply was not an exact affirmative; request a new review.');
    case 'stale':
      throw new ReviewError('CC_REVIEW_APPROVAL_STALE', 'The approval branch is stale; request a new review.');
    case 'expired':
      throw new ReviewError('CC_REVIEW_REQUEST_EXPIRED', 'The approval request expired; request a new review.');
    case 'session-mismatch':
      throw new ReviewError('CC_REVIEW_SESSION_MISMATCH', 'Approval belongs to a different Pi session.');
    case 'reused':
      throw new ReviewError('CC_REVIEW_REQUEST_REUSED', 'Approval request was already used; request a new review.');
    case 'not-found':
      throw new ReviewError('CC_REVIEW_REQUEST_NOT_FOUND', 'Approval request was not found; request a new review.');
  }
  throw new ReviewError('CC_REVIEW_REQUEST_NOT_FOUND', 'Approval request was not found; request a new review.');
}

function requestRecord(
  input: RequestInput,
  proposal: Awaited<ReturnType<typeof canonicalizeProposal>>,
  session: ApprovalSessionReader,
  now: number,
  idFactory: () => string,
): PendingApproval {
  const source = findSourceUser(session.getBranch());
  const sessionId = session.getSessionId();
  if (!sessionId) throw new ReviewError('CC_REVIEW_SESSION_MISMATCH', 'Current Pi session identity is unavailable.');
  return {
    ...proposal,
    requestId: idFactory(),
    sessionId,
    sourceUserEntryId: source.entry.id,
    sourceUserBranchIndex: source.index,
    ...(typeof source.entry.timestamp === 'string' ? { sourceUserTimestamp: source.entry.timestamp } : {}),
    createdAt: now,
    expiresAt: now + EXPIRY_MS,
    status: 'pending',
    mode: proposal.mode,
    deep: input.deep ?? false,
    raw: input.raw ?? false,
  };
}

export function createApprovalTool(options: {
  store: ApprovalStore;
  executeReview: ExecuteApprovedReview;
  now?: () => number;
  idFactory?: () => string;
  validateFile?: typeof validatedFile;
}): ApprovalToolDefinition {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? createOpaqueRequestId;
  const validateFile = options.validateFile ?? validatedFile;

  return {
    name: 'cc_review_approval',
    label: 'CC Review Approval',
    description: 'Creates a confirmation-gated request and, after exact user approval, runs the existing read-only /cc-review workflow directly; it never runs Claude independently.',
    promptSnippet: 'Request or execute a user-approved /cc-review workflow',
    parameters: approvalParametersSchema,
    async execute(_toolCallId, rawParams: ApprovalInput, _signal, _onUpdate, ctx: ApprovalToolContext) {
      const params = validateApprovalInput(rawParams);
      if (params.phase === 'request') {
        const createdAt = now();
        const proposal = await canonicalizeProposal(params, ctx.cwd, validateFile);
        const record = requestRecord(params, proposal, ctx.sessionManager, createdAt, idFactory);
        options.store.create(record);
        return textResult(
          `I can run this read-only review after your confirmation:\n  ${record.canonicalCommand}\nReply with exactly “yes” (or “ya”, “lanjut”, “approve”) to proceed.\nRequest ID: ${record.requestId}. Expires in five minutes.`,
          stateDetails('request', record, 'pending'),
        );
      }

      const input = params as ExecuteInput;
      const decision = evaluateApproval(options.store, ctx.sessionManager, input.requestId, now());
      if (decision.kind !== 'approved') stateError(decision);
      const record = decision.record;
      options.store.consume(record);
      try {
        const completed = await options.executeReview(record.canonicalTail, ctx);
        const details = {
          ...stateDetails('execute', record, 'completed'),
          review: completed.details,
        };
        return {
          content: [{ type: 'text', text: completed.content }],
          details,
          ...(completed.raw ? { terminate: true } : {}),
        };
      } catch (error) {
        options.store.markFailed(record);
        if (error instanceof ReviewError) throw error;
        throw new ReviewError('CC_REVIEW_EXECUTION_FAILED', 'The approved review could not complete; request a new review.');
      }
    },
  };
}

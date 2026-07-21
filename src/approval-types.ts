export type ApprovalMode = 'auto' | 'plan' | 'spec' | 'code' | 'repo';

export interface RequestInput {
  phase: 'request';
  mode?: ApprovalMode;
  file?: string;
  base?: string;
  focus?: string;
  deep?: boolean;
  raw?: boolean;
}

export interface ExecuteInput {
  phase: 'execute';
  requestId: string;
}

export type ApprovalInput = RequestInput | ExecuteInput;

export interface CanonicalArgs {
  mode: ApprovalMode;
  file?: string;
  base?: string;
  focus?: string;
  deep: boolean;
  raw: boolean;
}

export interface CanonicalProposal {
  mode: ApprovalMode;
  file?: string;
  base?: string;
  focus?: string;
  deep: boolean;
  raw: boolean;
  canonicalTail: string;
  canonicalCommand: string;
  canonicalArgs: CanonicalArgs;
  targetKind: 'git' | 'folder' | 'file' | 'session-artifact';
  targetPath?: string;
}

export interface BranchMessage {
  role?: string;
  content?: unknown;
}

export interface BranchEntry {
  id: string;
  type?: string;
  timestamp?: string;
  message?: BranchMessage;
}

export interface ApprovalSessionReader {
  getSessionId(): string;
  getBranch(): readonly BranchEntry[];
  getSessionFile?(): string | undefined;
}

export type PendingStatus = 'pending' | 'consumed' | 'denied' | 'expired' | 'stale' | 'failed';

export interface PendingApproval extends CanonicalProposal {
  requestId: string;
  sessionId: string;
  sourceUserEntryId: string;
  sourceUserBranchIndex: number;
  sourceUserTimestamp?: string;
  createdAt: number;
  expiresAt: number;
  status: PendingStatus;
}

export interface ToolTextPart {
  type: 'text';
  text: string;
}

export interface ApprovalDetails {
  kind: 'cc-review-approval';
  phase: 'request' | 'execute';
  requestId: string;
  sessionIdHash?: string;
  sourceUserEntryId?: string;
  sourceUserTimestamp?: string;
  canonicalCommand?: string;
  mode?: ApprovalMode;
  targetKind?: 'git' | 'folder' | 'file' | 'session-artifact';
  raw?: boolean;
  deep?: boolean;
  expiresAt?: number;
  status: 'pending' | 'completed' | 'denied' | 'expired' | 'stale' | 'rejected';
  review?: Record<string, unknown>;
}

export interface ApprovalToolResult {
  content: ToolTextPart[];
  details?: ApprovalDetails;
  terminate?: boolean;
}

export interface ApprovalToolContext {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  ui?: { notify(message: string, type?: 'info' | 'warning' | 'error'): void; custom?: <T>(factory: unknown) => Promise<T> };
  sessionManager: ApprovalSessionReader & { buildContextEntries?: () => unknown[] };
}

export interface ApprovedReviewResult {
  content: string;
  details: Record<string, unknown>;
  raw: boolean;
}

export type ExecuteApprovedReview = (
  canonicalTail: string,
  ctx: ApprovalToolContext,
) => Promise<ApprovedReviewResult>;

export interface ApprovalToolDefinition {
  name: 'cc_review_approval';
  label: 'CC Review Approval';
  description: string;
  promptSnippet: string;
  parameters: object;
  execute(
    toolCallId: string,
    params: ApprovalInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ApprovalToolContext,
  ): Promise<ApprovalToolResult>;
}

export interface ApprovalStore {
  create(record: PendingApproval): void;
  getById(requestId: string): PendingApproval | undefined;
  getActive(sessionId: string): PendingApproval | undefined;
  replaceActive(sessionId: string, record: PendingApproval): void;
  removeActive(sessionId: string): void;
  consume(record: PendingApproval): void;
  markFailed(record: PendingApproval): void;
  prune(now: number): void;
}

export type ApprovalDecision =
  | { kind: 'approved'; record: PendingApproval; replyEntryId: string }
  | { kind: 'no-new-user' }
  | { kind: 'not-exact'; record: PendingApproval }
  | { kind: 'stale'; record: PendingApproval }
  | { kind: 'expired'; record: PendingApproval }
  | { kind: 'session-mismatch' }
  | { kind: 'not-found' }
  | { kind: 'reused'; record: PendingApproval };

export type ApprovalErrorCode =
  | 'CC_REVIEW_INTENT_AMBIGUOUS'
  | 'CC_REVIEW_INVALID_OPTIONS'
  | 'CC_REVIEW_UNENCODABLE_ARGUMENT'
  | 'CC_REVIEW_REQUEST_NOT_FOUND'
  | 'CC_REVIEW_REQUEST_EXPIRED'
  | 'CC_REVIEW_REQUEST_REUSED'
  | 'CC_REVIEW_SESSION_MISMATCH'
  | 'CC_REVIEW_APPROVAL_NO_NEW_USER'
  | 'CC_REVIEW_APPROVAL_NOT_EXACT'
  | 'CC_REVIEW_APPROVAL_DENIED'
  | 'CC_REVIEW_APPROVAL_STALE'
  | 'CC_REVIEW_EXECUTION_FAILED';

import { randomBytes } from 'node:crypto';
import { ReviewError } from './types.ts';
import type {
  ApprovalDecision,
  ApprovalSessionReader,
  ApprovalStore,
  BranchEntry,
  PendingApproval,
} from './approval-types.ts';

const TERMINAL_RETENTION_MS = 300_000;
const AFFIRMATIVE = new Set(['ya', 'yes', 'lanjut', 'approve']);

function isUserMessage(entry: BranchEntry): boolean {
  return (entry.type === undefined || entry.type === 'message') && entry.message?.role === 'user';
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  let result = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return undefined;
    const item = part as Record<string, unknown>;
    if (item.type !== 'text' || typeof item.text !== 'string') return undefined;
    result += item.text;
  }
  return result;
}

function terminal(status: PendingApproval['status']): boolean {
  return status !== 'pending';
}

class MemoryApprovalStore implements ApprovalStore {
  private readonly byId = new Map<string, PendingApproval>();
  private readonly activeBySession = new Map<string, string>();

  create(record: PendingApproval): void {
    this.prune(record.createdAt);
    const previousId = this.activeBySession.get(record.sessionId);
    if (previousId !== undefined && previousId !== record.requestId) {
      const previous = this.byId.get(previousId);
      if (previous?.status === 'pending') previous.status = 'stale';
    }
    record.status = 'pending';
    this.byId.set(record.requestId, record);
    this.activeBySession.set(record.sessionId, record.requestId);
  }

  getById(requestId: string): PendingApproval | undefined {
    return this.byId.get(requestId);
  }

  getActive(sessionId: string): PendingApproval | undefined {
    const id = this.activeBySession.get(sessionId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  replaceActive(sessionId: string, record: PendingApproval): void {
    if (record.sessionId !== sessionId) throw new ReviewError('CC_REVIEW_SESSION_MISMATCH', 'Approval session mismatch.');
    this.create(record);
  }

  removeActive(sessionId: string): void {
    this.activeBySession.delete(sessionId);
  }

  consume(record: PendingApproval): void {
    const current = this.byId.get(record.requestId);
    if (current !== record || record.status !== 'pending') {
      throw new ReviewError('CC_REVIEW_REQUEST_REUSED', 'Approval request was already used.');
    }
    record.status = 'consumed';
    if (this.activeBySession.get(record.sessionId) === record.requestId) this.activeBySession.delete(record.sessionId);
  }

  markFailed(record: PendingApproval): void {
    const current = this.byId.get(record.requestId);
    if (current !== record) return;
    record.status = 'failed';
    if (this.activeBySession.get(record.sessionId) === record.requestId) this.activeBySession.delete(record.sessionId);
  }

  prune(now: number): void {
    for (const [id, record] of this.byId) {
      if (terminal(record.status) && now >= record.expiresAt + TERMINAL_RETENTION_MS) {
        this.byId.delete(id);
        if (this.activeBySession.get(record.sessionId) === id) this.activeBySession.delete(record.sessionId);
      }
    }
  }
}

export function createApprovalStore(): ApprovalStore {
  return new MemoryApprovalStore();
}

export function findSourceUser(branch: readonly BranchEntry[]): { entry: BranchEntry; index: number } {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (isUserMessage(branch[index])) return { entry: branch[index], index };
  }
  throw new ReviewError('CC_REVIEW_REQUEST_NOT_FOUND', 'No current user request exists.');
}

export function normalizeAffirmative(text: string): string | undefined {
  let normalized = text.normalize('NFKC').trim().toLowerCase();
  if (normalized.endsWith('.') || normalized.endsWith('!')) normalized = normalized.slice(0, -1);
  return AFFIRMATIVE.has(normalized) ? normalized : undefined;
}

function rejectTerminal(record: PendingApproval): ApprovalDecision {
  return { kind: 'reused', record };
}

export function evaluateApproval(
  store: ApprovalStore,
  session: ApprovalSessionReader,
  requestId: string,
  now: number,
): ApprovalDecision {
  store.prune(now);
  const record = store.getById(requestId);
  if (record === undefined) return { kind: 'not-found' };
  if (record.sessionId !== session.getSessionId()) return { kind: 'session-mismatch' };
  if (record.status !== 'pending') return rejectTerminal(record);
  if (now >= record.expiresAt) {
    record.status = 'expired';
    store.removeActive(record.sessionId);
    return { kind: 'expired', record };
  }

  const branch = session.getBranch();
  const sourceIndex = branch.findIndex(entry => entry.id === record.sourceUserEntryId);
  if (sourceIndex < 0 || sourceIndex !== record.sourceUserBranchIndex || !isUserMessage(branch[sourceIndex])) {
    record.status = 'stale';
    store.removeActive(record.sessionId);
    return { kind: 'stale', record };
  }

  const newerUsers = branch.slice(sourceIndex + 1).filter(isUserMessage);
  if (newerUsers.length === 0) return { kind: 'no-new-user' };
  if (newerUsers.length > 1) {
    record.status = 'stale';
    store.removeActive(record.sessionId);
    return { kind: 'stale', record };
  }

  const reply = textContent(newerUsers[0].message?.content);
  if (reply === undefined || normalizeAffirmative(reply) === undefined) {
    record.status = 'denied';
    store.removeActive(record.sessionId);
    return { kind: 'not-exact', record };
  }
  return { kind: 'approved', record, replyEntryId: newerUsers[0].id };
}

export function createOpaqueRequestId(): string {
  return randomBytes(16).toString('base64url');
}

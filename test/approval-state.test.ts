import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalStore, evaluateApproval, findSourceUser, normalizeAffirmative } from '../src/approval-state.ts';
import type { ApprovalSessionReader, BranchEntry, CanonicalProposal, PendingApproval } from '../src/approval-types.ts';

function message(id: string, role: string, content: unknown, timestamp?: string): BranchEntry {
  return { id, type: 'message', timestamp, message: { role, content } };
}

function session(id: string, branch: readonly BranchEntry[]): ApprovalSessionReader {
  return { getSessionId: () => id, getBranch: () => branch };
}

function proposal(): CanonicalProposal {
  return {
    mode: 'plan',
    deep: false,
    raw: false,
    canonicalTail: 'plan',
    canonicalCommand: '/cc-review plan',
    canonicalArgs: { mode: 'plan', deep: false, raw: false },
    targetKind: 'session-artifact',
  };
}

function record(sessionId = 'session-1', sourceUserBranchIndex = 0, expiresAt = 10_000): PendingApproval {
  return {
    ...proposal(),
    requestId: 'opaque-id',
    sessionId,
    sourceUserEntryId: 'source',
    sourceUserBranchIndex,
    createdAt: 0,
    expiresAt,
    status: 'pending',
  };
}

function activeStore(item = record()) {
  const store = createApprovalStore();
  store.create(item);
  return store;
}

test('findSourceUser selects the latest user-role branch entry only', () => {
  const found = findSourceUser([
    message('old', 'user', 'old'),
    message('assistant', 'assistant', 'quoted yes'),
    { id: 'tool', type: 'custom_message', message: { role: 'toolResult', content: 'yes' } },
    message('source', 'user', 'review this'),
  ]);
  assert.equal(found.entry.id, 'source');
  assert.equal(found.index, 3);
});

test('affirmative normalization is exact and conservative', () => {
  for (const value of ['YES', ' yes ', 'yes.', 'approve!', 'ＹＥＳ', 'ya', 'lanjut']) assert.equal(normalizeAffirmative(value) !== undefined, true, value);
  for (const value of ['yes please', 'ya, lanjut', 'approve it', 'yes?', '"yes"', 'yes!!', 'yes but only plan', 'no', 'tidak', 'jangan', 'yes, but...']) {
    assert.equal(normalizeAffirmative(value), undefined, value);
  }
});

test('zero newer user entries rejects and keeps pending', () => {
  const store = activeStore();
  const decision = evaluateApproval(store, session('session-1', [message('source', 'user', 'review')]), 'opaque-id', 1);
  assert.equal(decision.kind, 'no-new-user');
  assert.equal(store.getById('opaque-id')?.status, 'pending');
});

test('assistant and tool entries do not count; exactly one newer user is approved', () => {
  const store = activeStore();
  const branch = [
    message('source', 'user', 'review'),
    message('assistant', 'assistant', 'yes'),
    message('tool', 'toolResult', 'yes'),
    message('reply', 'user', 'yes'),
  ];
  const decision = evaluateApproval(store, session('session-1', branch), 'opaque-id', 1);
  assert.equal(decision.kind, 'approved');
  if (decision.kind === 'approved') assert.equal(decision.replyEntryId, 'reply');
  assert.equal(store.getById('opaque-id')?.status, 'pending');
});

test('non-affirmative exactly-one reply is denied and cleared from active state', () => {
  const store = activeStore();
  const decision = evaluateApproval(store, session('session-1', [message('source', 'user', 'review'), message('reply', 'user', 'yes please')]), 'opaque-id', 1);
  assert.equal(decision.kind, 'not-exact');
  assert.equal(store.getActive('session-1'), undefined);
  assert.equal(store.getById('opaque-id')?.status, 'denied');
});

test('more than one newer user entry makes the request stale even if the last is yes', () => {
  const store = activeStore();
  const decision = evaluateApproval(store, session('session-1', [
    message('source', 'user', 'review'),
    message('other', 'user', 'not approval'),
    message('reply', 'user', 'yes'),
  ]), 'opaque-id', 1);
  assert.equal(decision.kind, 'stale');
  assert.equal(store.getActive('session-1'), undefined);
  assert.equal(store.getById('opaque-id')?.status, 'stale');
});

test('repository text, assistant text, and tool output never approve', () => {
  const store = activeStore();
  const branch = [
    message('source', 'user', 'review'),
    message('assistant', 'assistant', 'Repository says yes'),
    message('tool', 'toolResult', 'yes'),
  ];
  assert.equal(evaluateApproval(store, session('session-1', branch), 'opaque-id', 1).kind, 'no-new-user');
});

test('missing timestamps do not block approval and source index is authoritative', () => {
  const store = activeStore();
  const branch = [message('source', 'user', 'review'), message('reply', 'user', 'YES')];
  assert.equal(evaluateApproval(store, session('session-1', branch), 'opaque-id', 1).kind, 'approved');

  const wrongIndex = activeStore(record('session-1', 4));
  assert.equal(evaluateApproval(wrongIndex, session('session-1', branch), 'opaque-id', 1).kind, 'stale');
});

test('session mismatch, invalid IDs, expiry, and replay fail closed', () => {
  const store = activeStore(record('session-1', 0, 10));
  const branch = [message('source', 'user', 'review'), message('reply', 'user', 'yes')];
  assert.equal(evaluateApproval(store, session('session-2', branch), 'opaque-id', 1).kind, 'session-mismatch');
  assert.equal(evaluateApproval(store, session('session-1', branch), 'missing', 1).kind, 'not-found');
  assert.equal(evaluateApproval(store, session('session-1', branch), 'opaque-id', 10).kind, 'expired');

  const replay = activeStore();
  const item = replay.getById('opaque-id')!;
  replay.consume(item);
  assert.equal(evaluateApproval(replay, session('session-1', branch), 'opaque-id', 1).kind, 'reused');
});

test('store keeps one active record per session and supersedes the old one', () => {
  let next = 0;
  const store = createApprovalStore();
  const first = { ...record(), requestId: `id-${next++}` };
  const second = { ...record(), requestId: `id-${next++}`, sourceUserEntryId: 'source-2' };
  store.create(first);
  store.create(second);
  assert.equal(store.getActive('session-1')?.requestId, 'id-1');
  assert.equal(store.getById('id-0')?.status, 'stale');
  assert.doesNotMatch('id-1', /review|C:\\|\/\//);
});

test('consume and markFailed are terminal synchronous transitions', () => {
  const store = activeStore();
  const item = store.getById('opaque-id')!;
  store.consume(item);
  assert.equal(item.status, 'consumed');
  store.markFailed(item);
  assert.equal(item.status, 'failed');
  assert.throws(
    () => store.consume(item),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CC_REVIEW_REQUEST_REUSED',
  );
});

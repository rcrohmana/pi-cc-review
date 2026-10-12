import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Claude Code's acknowledgement for a background Agent launch; not a completed review. */
export const ASYNC_LAUNCH_PATTERN = /^\s*Async agent launched/i;

export function outcomesPathFor(stateFile) {
  return join(dirname(stateFile), 'agent-outcomes.jsonl');
}

function resultText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ');
}

/**
 * PostToolUse / PostToolUseFailure hook payload -> one outcome line.
 * Status is "failed" for failures, otherwise Claude Code's tool_response.status
 * ("completed" for foreground agents, "async_launched" for background launches).
 */
export function outcomeFromPayload(payload) {
  if (payload?.tool_name !== 'Agent' && payload?.tool_name !== 'Task') return undefined;
  const input = payload.tool_input ?? {};
  const name = input.subagent_type ?? input.agent ?? input.name;
  if (typeof name !== 'string' || !name) return undefined;
  const status = payload.hook_event_name === 'PostToolUseFailure'
    ? 'failed'
    : (typeof payload.tool_response?.status === 'string' ? payload.tool_response.status : 'unknown');
  return { name, status };
}

/** A reviewer counts as completed unless every outcome for it failed or was only a background launch. */
export function completedFromOutcomes(text) {
  const completed = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let outcome;
    try { outcome = JSON.parse(line); } catch { continue; }
    if (typeof outcome?.name !== 'string' || typeof outcome.status !== 'string') continue;
    if (outcome.status === 'failed' || outcome.status.startsWith('async')) continue;
    if (!completed.includes(outcome.name)) completed.push(outcome.name);
  }
  return completed;
}

export function extractAgentName(content) {
  if (content?.type !== 'tool_use') return undefined;
  if (content.name !== 'Agent' && content.name !== 'Task') return undefined;
  return content.input?.subagent_type
    ?? content.input?.agent
    ?? content.input?.name;
}

export function collectInvokedAgents(transcript) {
  const invoked = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const content of [event?.message?.content, event?.content]) {
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const name = extractAgentName(item);
        if (typeof name === 'string' && !invoked.includes(name)) invoked.push(name);
      }
    }
  }
  return invoked;
}

/** Agents whose native Agent/Task call returned a non-error tool_result. */
export function collectCompletedAgents(transcript) {
  const calls = new Map();
  const completed = [];
  const events = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  for (const event of events) {
    for (const content of [event?.message?.content, event?.content]) {
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const name = extractAgentName(item);
        if (typeof name === 'string' && typeof item.id === 'string') calls.set(item.id, name);
      }
    }
  }
  for (const event of events) {
    for (const content of [event?.message?.content, event?.content]) {
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type !== 'tool_result' || item.is_error === true) continue;
        if (ASYNC_LAUNCH_PATTERN.test(resultText(item.content))) continue;
        const name = calls.get(item.tool_use_id);
        if (typeof name === 'string' && !completed.includes(name)) completed.push(name);
      }
    }
  }
  return completed;
}

export function computeMissing(required, invoked) {
  return required.filter(name => !invoked.includes(name));
}

export function buildBlockReason(missing) {
  const list = missing.join(', ');
  return `Required native reviewers not yet completed successfully: ${list}. Invoke each missing reviewer now with a native Agent call using its exact subagent_type name (${list}), wait for their results, then produce the final review. Text-only simulation is invalid.`;
}

export function readState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      fired: Number.isFinite(parsed?.fired) ? parsed.fired : 0,
      blocks: Number.isFinite(parsed?.blocks) ? parsed.blocks : 0,
    };
  } catch {
    return { fired: 0, blocks: 0 };
  }
}

function writeState(stateFile, state) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));
  } catch { /* best-effort */ }
}

function record(outcomesFile, payload) {
  const outcome = outcomeFromPayload(payload);
  if (!outcome || !outcomesFile) return;
  try {
    appendFileSync(outcomesFile, `${JSON.stringify(outcome)}\n`);
  } catch { /* best-effort */ }
}

function readOptional(path) {
  try { return typeof path === 'string' ? readFileSync(path, 'utf8') : undefined; } catch { return undefined; }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch { return; }

  if (process.argv[2] === '--record') {
    record(process.argv[3], payload);
    return;
  }

  const [stateFile, maxBlocksRaw, requiredCsv] = process.argv.slice(2);
  const maxBlocks = Number.parseInt(maxBlocksRaw, 10);
  const required = (requiredCsv ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);

  // Primary evidence: outcomes recorded by the PostToolUse/PostToolUseFailure hooks.
  // Fallback: the session transcript, which does not exist under --no-session-persistence.
  const completed = completedFromOutcomes(readOptional(outcomesPathFor(stateFile)) ?? '');
  const transcript = readOptional(payload?.transcript_path);
  if (transcript !== undefined) {
    for (const name of collectCompletedAgents(transcript)) if (!completed.includes(name)) completed.push(name);
  }

  const missing = computeMissing(required, completed);
  const state = readState(stateFile);
  state.fired += 1;

  if (missing.length === 0 || !Number.isFinite(maxBlocks) || state.blocks >= maxBlocks) {
    writeState(stateFile, state);
    return;
  }
  state.blocks += 1;
  writeState(stateFile, state);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: buildBlockReason(missing) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { /* fail-open: never exit non-zero */ }
}

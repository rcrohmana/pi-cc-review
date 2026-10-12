import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch { return; }

  const [stateFile, maxBlocksRaw, requiredCsv] = process.argv.slice(2);
  const maxBlocks = Number.parseInt(maxBlocksRaw, 10);
  const required = (requiredCsv ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);

  let transcript;
  try {
    transcript = readFileSync(payload?.transcript_path, 'utf8');
  } catch { return; }

  const missing = computeMissing(required, collectCompletedAgents(transcript));
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

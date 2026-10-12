import { truncateUtf8 } from './context.ts';
import { redactSecrets } from './render.ts';

/**
 * Bounded, redacted digest of the active Pi branch for the advisor (advise mode only).
 *
 * Input is `sessionManager.buildContextEntries()` (active branch, compaction-aware) or plain
 * agent messages. Output keeps the newest material within a byte budget, in chronological order.
 */

export const TRANSCRIPT_LIMITS = Object.freeze({
  totalBytes: 60_000,
  messageBytes: 8_000,
  toolArgumentBytes: 2_000,
  toolResultBytes: 4_000,
  summaryBytes: 8_000,
});

/** Tool whose earlier results are collapsed so the advisor does not anchor on its own advice. */
export const ADVISOR_TOOL_NAME = 'cc_advise';

export interface TranscriptDigest {
  text: string;
  includedEntries: number;
  omittedEntries: number;
  truncatedItems: number;
  redactions: number;
}

type Limits = typeof TRANSCRIPT_LIMITS;
type Message = Record<string, any>;

const HEADER = '# Pi session transcript (untrusted evidence; chronological, newest last)';

function textOf(content: unknown, imagePlaceholder = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'image' && imagePlaceholder) return '[image omitted]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Normalize session entries and plain messages into agent messages, applying context edits. */
function toMessages(entries: readonly unknown[]): Message[] {
  const edits = new Map<string, unknown>();
  for (const entry of entries as Message[]) {
    if (entry?.type === 'context_edit' && typeof entry.targetId === 'string') edits.set(entry.targetId, entry.replacement);
  }
  const messages: Message[] = [];
  for (const entry of entries as Message[]) {
    if (!entry || typeof entry !== 'object') continue;
    let message: Message | undefined;
    if (entry.type === 'message' || (entry.type === undefined && entry.message)) message = entry.message;
    else if (entry.type === 'compaction') message = { role: 'compactionSummary', summary: entry.summary };
    else if (entry.type === 'branch_summary') message = { role: 'branchSummary', summary: entry.summary };
    else if (entry.type === 'custom_message') message = { role: 'custom', customType: entry.customType, content: entry.content };
    else if (entry.type === undefined && typeof entry.role === 'string') message = entry;
    if (!message || typeof message.role !== 'string') continue;
    if (typeof entry.id === 'string' && edits.has(entry.id)) {
      const replacement = edits.get(entry.id);
      if (replacement === null) continue;
      message = { ...message, content: replacement };
    }
    messages.push(message);
  }
  return messages;
}

class BlockBuilder {
  truncatedItems = 0;
  redactions = 0;

  bounded(text: string, maxBytes: number): string {
    const redacted = redactSecrets(text);
    this.redactions += redacted.count;
    const bounded = truncateUtf8(redacted.text, maxBytes, '\n[TRUNCATED: transcript item limit]');
    if (bounded.truncated) this.truncatedItems++;
    return bounded.text;
  }
}

function renderMessage(message: Message, builder: BlockBuilder, limits: Limits): string | undefined {
  switch (message.role) {
    case 'user': {
      const text = textOf(message.content);
      return text.trim() ? `## user\n${builder.bounded(text, limits.messageBytes)}` : undefined;
    }
    case 'assistant': {
      const parts: string[] = [];
      for (const part of Array.isArray(message.content) ? message.content : [{ type: 'text', text: textOf(message.content) }]) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          parts.push(builder.bounded(part.text, limits.messageBytes));
        } else if (part?.type === 'toolCall' && typeof part.name === 'string') {
          let args = '';
          try { args = JSON.stringify(part.arguments ?? {}); } catch { args = '[unserializable arguments]'; }
          parts.push(`→ tool call \`${part.name}\` ${builder.bounded(args, limits.toolArgumentBytes)}`);
        }
      }
      return parts.length ? `## assistant\n${parts.join('\n')}` : undefined;
    }
    case 'toolResult': {
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown';
      const status = message.isError === true ? ' (error)' : '';
      if (name === ADVISOR_TOOL_NAME) {
        const verdict = typeof message.details?.verdict === 'string' ? message.details.verdict : 'unknown';
        return `## tool result \`${name}\`${status}\n[earlier advisor consultation; verdict: ${verdict}; guidance omitted]`;
      }
      return `## tool result \`${name}\`${status}\n${builder.bounded(textOf(message.content), limits.toolResultBytes)}`;
    }
    case 'bashExecution': {
      if (message.excludeFromContext === true) return undefined;
      const exit = message.cancelled === true ? 'cancelled' : `exit ${message.exitCode ?? 'unknown'}`;
      const command = builder.bounded(String(message.command ?? ''), limits.toolArgumentBytes);
      return `## user shell \`${command}\` (${exit})\n${builder.bounded(String(message.output ?? ''), limits.toolResultBytes)}`;
    }
    case 'custom': {
      const text = textOf(message.content);
      if (!text.trim()) return undefined;
      return `## extension message (${String(message.customType ?? 'custom')})\n${builder.bounded(text, limits.toolResultBytes)}`;
    }
    case 'compactionSummary':
    case 'branchSummary': {
      const summary = String(message.summary ?? '');
      if (!summary.trim()) return undefined;
      const label = message.role === 'compactionSummary' ? 'earlier conversation summary' : 'abandoned branch summary';
      return `## ${label}\n${builder.bounded(summary, limits.summaryBytes)}`;
    }
    default:
      return undefined; // system prompts, thinking-only content, unknown roles
  }
}

export function buildTranscriptDigest(
  entries: readonly unknown[],
  limits: Limits = TRANSCRIPT_LIMITS,
): TranscriptDigest {
  const blocks: Array<{ text: string; redactions: number; truncatedItems: number }> = [];
  for (const message of toMessages(entries)) {
    const builder = new BlockBuilder();
    const text = renderMessage(message, builder, limits);
    if (text !== undefined) blocks.push({ text, redactions: builder.redactions, truncatedItems: builder.truncatedItems });
  }

  const separatorBytes = 2;
  const reserve = Buffer.byteLength(HEADER) + 64; // header + omission marker
  let used = reserve;
  const kept: typeof blocks = [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(blocks[index].text) + separatorBytes;
    if (used + size > limits.totalBytes) break;
    kept.push(blocks[index]);
    used += size;
  }
  kept.reverse();
  const omitted = blocks.length - kept.length;
  const sections = [HEADER, ...(omitted > 0 ? [`[${omitted} earlier entries omitted]`] : []), ...kept.map(block => block.text)];
  return {
    text: sections.join('\n\n'),
    includedEntries: kept.length,
    omittedEntries: omitted,
    truncatedItems: kept.reduce((sum, block) => sum + block.truncatedItems, 0),
    redactions: kept.reduce((sum, block) => sum + block.redactions, 0),
  };
}

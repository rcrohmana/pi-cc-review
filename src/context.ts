import { LIMITS, ReviewError } from './types.ts';

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join('');
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n[TRUNCATED: character limit]`, truncated: true };
}

export function truncateUtf8(
  text: string,
  maxBytes: number,
  marker = '\n[TRUNCATED: byte limit]',
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };

  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return { text: '', truncated: true };
  const contentBudget = maxBytes - markerBytes;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }

  return { text: `${text.slice(0, low)}${marker}`, truncated: true };
}

export function buildContextEntries(entries: any[], requireArtifact = true) {
  const messages = entries.map(entry => entry.message ?? entry)
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => ({ role: message.role, text: contentText(message.content) }))
    .filter(message => message.text.trim());
  const objective = [...messages].reverse().find(message => message.role === 'user')?.text ?? '';
  const artifact = [...messages].reverse().find(message => message.role === 'assistant' && message.text.replace(/\s/g, '').length >= 300)?.text ?? '';
  if (requireArtifact && !artifact) throw new ReviewError('NO_REVIEWABLE_CONTENT', 'No substantial assistant artifact exists. Specify --file or review code.');
  const pieces = messages.slice(-6).map(message => `## ${message.role}\n${truncateText(message.text, LIMITS.message).text}`);
  const bounded = truncateText(pieces.join('\n\n'), LIMITS.context);
  const objectiveBounded = truncateText(objective, LIMITS.message);
  const artifactBounded = truncateText(artifact, LIMITS.message);
  return { objective: objectiveBounded.text, artifact: artifactBounded.text, context: bounded.text, truncated: bounded.truncated || objectiveBounded.truncated || artifactBounded.truncated };
}

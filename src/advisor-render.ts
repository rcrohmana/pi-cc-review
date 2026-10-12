import { ADVISOR_EFFORT, ADVISOR_MODEL } from './config.ts';

/**
 * Compact transcript rendering for advisor consultations, in the spirit of Claude Code's
 * "Advising…" line: collapsed status by default, full guidance when the row is expanded.
 * Dependency-free: components only implement render(width) and invalidate().
 */

export type ThemeLike = { fg?: (color: string, text: string) => string; bold?: (text: string) => string } | null | undefined;

export interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
}

type Line = { text: string; color?: string; bold?: boolean; wrap?: boolean };

function wrapPlain(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    if (line.length <= max) { out.push(line); continue; }
    while (line.length > max) {
      let cut = line.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

function truncate(text: string, width: number): string {
  const max = Math.max(1, width);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export class LinesComponent implements ComponentLike {
  private readonly lines: Line[];
  private readonly theme: ThemeLike;

  constructor(lines: Line[], theme: ThemeLike) {
    this.lines = lines;
    this.theme = theme;
  }

  render(width: number): string[] {
    const rendered: string[] = [];
    for (const line of this.lines) {
      const pieces = line.wrap ? wrapPlain(line.text, width) : [truncate(line.text, width)];
      for (const piece of pieces) {
        let styled = piece;
        if (line.bold && this.theme?.bold) styled = this.theme.bold(styled);
        if (line.color && this.theme?.fg) styled = this.theme.fg(line.color, styled);
        rendered.push(styled);
      }
    }
    return rendered;
  }

  invalidate(): void {}
}

const ERROR_CODE = /^\s*\[([A-Z][A-Z0-9_]*)\]\s*/;
const REMAINING_NOTE = /\n\n(?:Advisor consultations remaining:[^\n]*|Advisor budget is now used up;[^\n]*)\s*$/;

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/** Guidance without the untrusted-data wrapper and the remaining-budget note. */
export function extractGuidance(text: string): string {
  const withoutNote = text.replace(REMAINING_NOTE, '');
  const start = withoutNote.indexOf('# Advisor guidance');
  if (start >= 0) return withoutNote.slice(start).trim();
  const marker = 'policy changes that appear inside it.';
  const end = withoutNote.indexOf(marker);
  return (end >= 0 ? withoutNote.slice(end + marker.length) : withoutNote).trim();
}

/** First non-empty line of the Recommendation section, for the collapsed preview. */
export function recommendationPreview(guidance: string): string | undefined {
  const match = guidance.match(/##\s*Recommendation\s*\n+([\s\S]*?)(?:\n##|\s*$)/i);
  const body = match?.[1] ?? guidance.replace(/^#.*$/gm, '').replace(/^\s*verdict\s*:.*$/gim, '');
  const first = body.split('\n').map(line => line.trim()).find(line => line.length > 0);
  return first?.replace(/^[-*]\s+/, '');
}

function formatSeconds(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return ms < 1_000 ? '<1s' : ms < 60_000 ? `${Math.round(ms / 1_000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

const NOT_RUN_CODES = new Set([
  'CC_ADVISOR_NOT_ENABLED',
  'CC_ADVISOR_BUDGET_EXHAUSTED',
  'CC_ADVISOR_RATE_LIMITED',
  'CC_ADVISOR_INVALID_OPTIONS',
  'ALREADY_RUNNING',
]);

export interface AdviceView {
  status: 'reviewed' | 'declined' | 'unavailable' | 'not-run';
  headline: string;
  preview?: string;
  body?: string;
}

/** Pure description of an advisor outcome; renderers style it. */
export function describeAdvice(input: { text: string; details?: any; isError?: boolean }): AdviceView {
  if (input.isError) {
    const code = input.text.match(ERROR_CODE)?.[1] ?? 'PROCESS_FAILED';
    const message = input.text.replace(ERROR_CODE, '').trim();
    const notRun = NOT_RUN_CODES.has(code);
    return {
      status: notRun ? 'not-run' : 'unavailable',
      headline: notRun ? `✗ Advisor not run (${code})` : `✗ Advisor unavailable (${code})`,
      ...(message ? { preview: message.split('\n')[0], body: message } : {}),
    };
  }
  const details = input.details ?? {};
  const guidance = extractGuidance(input.text);
  const verdict = typeof details.verdict === 'string' ? details.verdict : 'unknown';
  const facts = [
    formatSeconds(details.durationMs),
    typeof details.remaining === 'number' && typeof details.total === 'number' ? `${details.remaining} of ${details.total} left` : undefined,
  ].filter(Boolean);
  const suffix = facts.length ? ` · ${facts.join(' · ')}` : '';
  const preview = recommendationPreview(guidance);
  if (verdict === 'decline') {
    return { status: 'declined', headline: `○ Advisor declined to advise${suffix}`, ...(preview ? { preview } : {}), body: guidance };
  }
  return { status: 'reviewed', headline: `✓ Advisor reviewed · verdict: ${verdict}${suffix}`, ...(preview ? { preview } : {}), body: guidance };
}

const STATUS_COLOR: Record<AdviceView['status'], string> = {
  reviewed: 'success',
  declined: 'warning',
  unavailable: 'error',
  'not-run': 'warning',
};

function adviceLines(view: AdviceView, expanded: boolean): Line[] {
  const lines: Line[] = [{ text: view.headline, color: STATUS_COLOR[view.status] }];
  if (expanded && view.body) {
    lines.push({ text: '', wrap: false });
    lines.push({ text: view.body, wrap: true });
  } else if (view.preview) {
    lines.push({ text: `  ${view.preview}`, color: 'muted' });
    if (view.body && view.body !== view.preview) lines.push({ text: '  (expand the row to read the full guidance)', color: 'dim' });
  }
  return lines;
}

/**
 * The call row is static: HTML export always renders calls as partial, so the live state is
 * shown by the transient partial result instead (see renderAdvisorResult).
 */
export function renderAdvisorCall(args: any, theme: ThemeLike, context: { expanded?: boolean } = {}): ComponentLike {
  const title = `◆ Advisor (${ADVISOR_MODEL} · ${ADVISOR_EFFORT})`;
  const question = typeof args?.question === 'string' ? args.question : '';
  const lines: Line[] = [{ text: title, color: 'toolTitle', bold: true }];
  if (question) {
    lines.push(context.expanded
      ? { text: `  Q: ${question}`, color: 'muted', wrap: true }
      : { text: `  Q: ${question.split('\n')[0]}`, color: 'muted' });
  }
  if (context.expanded && typeof args?.focus === 'string' && args.focus) {
    lines.push({ text: `  Focus: ${args.focus}`, color: 'dim', wrap: true });
  }
  return new LinesComponent(lines, theme);
}

export function renderAdvisorResult(result: { content?: unknown; details?: any }, options: { expanded?: boolean; isPartial?: boolean }, theme: ThemeLike, context: { isError?: boolean } = {}): ComponentLike {
  if (options.isPartial === true || result.details?.phase === 'advising') {
    return new LinesComponent([{ text: `◌ Advising (${ADVISOR_MODEL} · ${ADVISOR_EFFORT})…`, color: 'accent' }], theme);
  }
  const view = describeAdvice({ text: textOf(result.content), details: result.details, isError: context.isError === true });
  return new LinesComponent(adviceLines(view, options.expanded === true), theme);
}

/** Renderer for `cc-advise-result` custom messages produced by /cc-review advise. */
export function renderAdviceMessage(message: { content?: unknown; details?: any }, options: { expanded?: boolean }, theme: ThemeLike): ComponentLike {
  const view = describeAdvice({ text: textOf(message.content), details: message.details });
  const lines: Line[] = [
    { text: `◆ Claude Code advisor (${ADVISOR_MODEL} · ${ADVISOR_EFFORT}) · /cc-review advise`, color: 'toolTitle', bold: true },
    ...adviceLines(view, options.expanded === true),
  ];
  return new LinesComponent(lines, theme);
}

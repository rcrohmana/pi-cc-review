import type { AdviceResult, AdviseContext, AdviseRequest, AdviseRunOptions } from './advise.ts';
import { parseBudget, type AdvisorState } from './advisor-state.ts';
import { ADVISOR_EFFORT, ADVISOR_MAX_BUDGET, ADVISOR_MODEL } from './config.ts';
import { errorText } from './render.ts';
import { isLocked } from './runtime.ts';
import { ADVISOR_TOOL_NAME } from './transcript.ts';
import { ReviewError } from './types.ts';

export { ADVISOR_TOOL_NAME };

const FIELD_LIMIT = 2_000;

export const advisorParametersSchema = {
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 1, maxLength: FIELD_LIMIT, description: 'The specific decision or problem you want advice on.' },
    focus: { type: 'string', minLength: 1, maxLength: FIELD_LIMIT, description: 'Optional constraint or area the advisor should concentrate on.' },
  },
  required: ['question'],
  additionalProperties: false,
} as const;

export interface AdvisorToolParams {
  question: string;
  focus?: string;
}

export function validateAdvisorParams(value: unknown): AdvisorToolParams {
  const invalid = () => { throw new ReviewError('CC_ADVISOR_INVALID_OPTIONS', 'cc_advise accepts only question (required) and focus, each 1–2,000 characters.'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'question' && key !== 'focus')) invalid();
  const ok = (field: unknown) => typeof field === 'string' && field.trim().length > 0 && field.length <= FIELD_LIMIT;
  if (!ok(record.question)) invalid();
  if (record.focus !== undefined && !ok(record.focus)) invalid();
  return {
    question: record.question as string,
    ...(record.focus === undefined ? {} : { focus: record.focus as string }),
  };
}

type BranchEntry = { id?: string; type?: string; message?: { role?: string; content?: unknown } };

export interface AdvisorToolContext extends AdviseContext {
  sessionManager: AdviseContext['sessionManager'] & {
    getSessionId(): string;
    getBranch?(): readonly BranchEntry[];
  };
}

/** Entry id of the assistant message that issued this tool call, when Pi has persisted it. */
export function findIssuingMessage(branch: readonly BranchEntry[] | undefined, toolCallId: string): string | undefined {
  if (!branch) return undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    const issued = entry.message.content.some((part: any) => part?.type === 'toolCall' && part.id === toolCallId);
    if (issued) return typeof entry.id === 'string' ? entry.id : undefined;
  }
  return undefined;
}

export type AdviseRunnerFn = (request: AdviseRequest, ctx: AdviseContext, options?: AdviseRunOptions) => Promise<AdviceResult>;

export interface AdvisorActivation {
  activate(): void;
  deactivate(): void;
}

export function createAdvisorTool(options: {
  state: AdvisorState;
  runAdvice: AdviseRunnerFn;
  activation: AdvisorActivation;
}) {
  const consult = async (toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, ctx: AdvisorToolContext) => {
    const params = validateAdvisorParams(rawParams);
    const sessionId = ctx.sessionManager.getSessionId();
    const messageKey = findIssuingMessage(ctx.sessionManager.getBranch?.(), toolCallId);
    // Do not consume budget when the shared Claude lock is busy; the runner acquires the lock
    // synchronously right after the reservation, so nothing can slip in between.
    if (isLocked()) {
      throw new ReviewError('ALREADY_RUNNING', 'A Claude Code review or advisor consultation is already running.');
    }
    const reservation = options.state.reserve(sessionId, messageKey);
    try {
      const advice = await options.runAdvice(
        { question: params.question, ...(params.focus === undefined ? {} : { focus: params.focus }) },
        ctx,
        signal === undefined ? {} : { signal },
      );
      const remainingNote = reservation.remaining === 0
        ? 'Advisor budget is now used up; the cc_advise tool is disabled until the user runs /cc-advisor on again.'
        : `Advisor consultations remaining: ${reservation.remaining} of ${reservation.total}.`;
      return {
        content: [{ type: 'text' as const, text: `${advice.content}\n\n${remainingNote}` }],
        details: {
          ...advice.details,
          kind: 'cc-advise',
          verdict: advice.verdict,
          remaining: reservation.remaining,
          total: reservation.total,
          // Whether the one-per-assistant-message rule could identify the issuing message.
          issuingMessageFound: messageKey !== undefined,
        },
      };
    } finally {
      if (reservation.remaining === 0) {
        options.state.revoke();
        options.activation.deactivate();
      }
    }
  };

  return {
    name: ADVISOR_TOOL_NAME,
    label: 'CC Advisor',
    description: `Consult a stronger Claude Code advisor (${ADVISOR_MODEL}, ${ADVISOR_EFFORT} effort) for short strategic guidance at a decision point. The advisor reads a redacted digest of this session and the repository read-only, then returns a verdict (proceed, revise, stop, or decline) with a recommendation. Each call uses one consultation from the user's limited budget and takes up to a few minutes.`,
    promptSnippet: 'Consult a stronger Claude Code advisor at key decision points (limited budget)',
    parameters: advisorParametersSchema,
    defaultActive: false,
    executionMode: 'sequential' as const,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },

    async execute(toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: AdvisorToolContext) {
      try {
        return await consult(toolCallId, rawParams, signal, ctx);
      } catch (error) {
        // Failed tool result with a stable `[CODE] message` prefix and redacted detail.
        throw new Error(errorText(error));
      }
    },
  };
}

export type AdvisorCommandContext = {
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void };
  sessionManager: { getSessionId?(): string };
};

const ADVISOR_USAGE = 'Usage: /cc-advisor on [--max N] | off | status';

export const ADVISOR_HELP = `/cc-advisor on [--max N] | off | status

Let the Pi model consult a Claude Code advisor (${ADVISOR_MODEL}, ${ADVISOR_EFFORT} effort) on its own at
decision points, up to N times in this session (default 3, max ${ADVISOR_MAX_BUDGET}). Each consultation
consumes Claude usage; Fable may bill to usage credits on some plans. The grant lasts only for this
session and resets on /reload, new, resume, or fork. For a one-off consultation use /cc-review advise.`;

export function createAdvisorCommand(options: { state: AdvisorState; activation: AdvisorActivation }) {
  return async (input: string, ctx: AdvisorCommandContext): Promise<void> => {
    try {
      const tokens = input.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? 'status';
      const sessionId = ctx.sessionManager.getSessionId?.() ?? '';
      if (action === 'on') {
        let budgetText: string | undefined;
        const rest = tokens.slice(1);
        if (rest.length === 2 && rest[0] === '--max') budgetText = rest[1];
        else if (rest.length !== 0) throw new ReviewError('USAGE_ERROR', ADVISOR_USAGE);
        const budget = parseBudget(budgetText);
        options.state.grant(sessionId, budget);
        options.activation.activate();
        ctx.ui.notify(
          `CC advisor on (${ADVISOR_MODEL}, ${ADVISOR_EFFORT} effort, ${budget} consultation${budget === 1 ? '' : 's'} this session). Each consultation consumes Claude usage; Fable may bill to usage credits on some plans. Turn off with /cc-advisor off.`,
          'info',
        );
        return;
      }
      if (tokens.length !== 1) throw new ReviewError('USAGE_ERROR', ADVISOR_USAGE);
      if (action === 'off') {
        options.state.revoke();
        options.activation.deactivate();
        ctx.ui.notify('CC advisor off. The cc_advise tool is no longer available to the model.', 'info');
        return;
      }
      if (action === 'status') {
        const grant = options.state.current(sessionId);
        ctx.ui.notify(
          grant
            ? `CC advisor on: ${grant.remaining} of ${grant.total} consultations left (${ADVISOR_MODEL}, ${ADVISOR_EFFORT} effort).`
            : 'CC advisor off. Enable with /cc-advisor on [--max N].',
          'info',
        );
        return;
      }
      if (action === '--help' || action === 'help') {
        ctx.ui.notify(ADVISOR_HELP, 'info');
        return;
      }
      throw new ReviewError('USAGE_ERROR', ADVISOR_USAGE);
    } catch (error) {
      ctx.ui.notify(errorText(error), 'error');
    }
  };
}

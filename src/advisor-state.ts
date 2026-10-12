import { ADVISOR_DEFAULT_BUDGET, ADVISOR_MAX_BUDGET } from './config.ts';
import { ReviewError } from './types.ts';

/**
 * In-memory, session-scoped advisor grant. Only a user-typed `/cc-advisor on` creates it;
 * `off`, budget exhaustion, any session_start (startup, reload, new, resume, fork), and
 * session_shutdown clear it. Nothing is persisted.
 */
export interface AdvisorGrant {
  sessionId: string;
  total: number;
  remaining: number;
  grantedAt: number;
  /** Assistant messages that already consulted the advisor (one consultation per message). */
  consultedMessages: Set<string>;
}

export type AdvisorReservation = { remaining: number; total: number };

export function parseBudget(value: string | undefined): number {
  if (value === undefined) return ADVISOR_DEFAULT_BUDGET;
  if (!/^\d+$/.test(value)) throw new ReviewError('USAGE_ERROR', `--max must be a whole number from 1 to ${ADVISOR_MAX_BUDGET}.`);
  const budget = Number(value);
  if (budget < 1 || budget > ADVISOR_MAX_BUDGET) {
    throw new ReviewError('USAGE_ERROR', `--max must be a whole number from 1 to ${ADVISOR_MAX_BUDGET}.`);
  }
  return budget;
}

export function createAdvisorState(now: () => number = Date.now) {
  let grant: AdvisorGrant | undefined;

  return {
    grant(sessionId: string, budget: number): AdvisorGrant {
      if (!sessionId) throw new ReviewError('CC_ADVISOR_SESSION_UNAVAILABLE', 'Current Pi session identity is unavailable.');
      grant = { sessionId, total: budget, remaining: budget, grantedAt: now(), consultedMessages: new Set() };
      return grant;
    },

    revoke(): void {
      grant = undefined;
    },

    current(sessionId: string): AdvisorGrant | undefined {
      return grant && grant.sessionId === sessionId ? grant : undefined;
    },

    /**
     * Check every precondition, then consume one consultation. Throws without consuming when
     * the grant is missing, exhausted, or this assistant message already consulted.
     */
    reserve(sessionId: string, messageKey: string | undefined): AdvisorReservation {
      const active = grant && grant.sessionId === sessionId ? grant : undefined;
      if (!active) {
        throw new ReviewError('CC_ADVISOR_NOT_ENABLED', 'The advisor is not enabled for this session. The user can enable it with /cc-advisor on.');
      }
      if (active.remaining <= 0) {
        throw new ReviewError('CC_ADVISOR_BUDGET_EXHAUSTED', 'The advisor consultation budget for this grant is used up.');
      }
      if (messageKey !== undefined && active.consultedMessages.has(messageKey)) {
        throw new ReviewError('CC_ADVISOR_RATE_LIMITED', 'Only one advisor consultation is allowed per assistant message.');
      }
      if (messageKey !== undefined) active.consultedMessages.add(messageKey);
      active.remaining -= 1;
      return { remaining: active.remaining, total: active.total };
    },
  };
}

export type AdvisorState = ReturnType<typeof createAdvisorState>;

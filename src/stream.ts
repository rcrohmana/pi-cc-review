import { ReviewError } from './types.ts';

export interface Parsed {
  finalText: string;
  invokedAgents: string[];
  malformed: string[];
  events: number;
  initModel?: string;
  observedModels: string[];
  coordinatorModelVerified: boolean;
  reviewerModels: Record<string, string[]>;
  usage?: unknown;
}

export interface ModelExpectations {
  coordinator: string;
}

const MODEL_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku']);

export function modelMatches(expected: string, observed: string) {
  const configured = expected.trim().toLowerCase();
  const actual = observed.trim().toLowerCase();
  if (!configured || !actual) return false;
  if (configured === actual) return true;
  return MODEL_ALIASES.has(configured)
    && actual.split(/[^a-z0-9]+/).includes(configured);
}

export function extractAgentName(content: any) {
  if (content?.type !== 'tool_use' || content?.name !== 'Agent') return undefined;
  return content.input?.subagent_type
    ?? content.input?.agent
    ?? content.input?.name;
}

export function parseStream(stdout: string): Parsed {
  const parsed: Parsed = {
    finalText: '',
    invokedAgents: [],
    malformed: [],
    events: 0,
    observedModels: [],
    coordinatorModelVerified: false,
    reviewerModels: {},
  };
  const agentCalls = new Map<string, string>();

  const recordModel = (model: unknown) => {
    if (typeof model === 'string' && !parsed.observedModels.includes(model)) {
      parsed.observedModels.push(model);
    }
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
      parsed.events++;
    } catch {
      if (parsed.malformed.length < 5) parsed.malformed.push(line.slice(0, 500));
      continue;
    }

    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      parsed.initModel ??= event.model;
    }
    recordModel(event.model);
    recordModel(event.message?.model);
    const parentId = event.parent_tool_use_id ?? event.parentToolUseId ?? event.message?.parent_tool_use_id ?? event.message?.parentToolUseId;
    const reviewer = typeof parentId === 'string' ? agentCalls.get(parentId) : undefined;
    const reviewerModel = event.message?.model ?? event.model;
    if (reviewer && typeof reviewerModel === 'string') {
      const models = parsed.reviewerModels[reviewer] ??= [];
      if (!models.includes(reviewerModel)) models.push(reviewerModel);
    }

    if (event.type === 'result' && typeof event.result === 'string') {
      parsed.finalText = event.result;
    }
    if (event.usage) parsed.usage = event.usage;

    for (const content of event.message?.content ?? []) {
      if (content.type === 'tool_use' && content.name === 'Agent') {
        const name = extractAgentName(content);
        if (typeof name === 'string' && !parsed.invokedAgents.includes(name)) {
          parsed.invokedAgents.push(name);
        }
        if (typeof name === 'string' && typeof content.id === 'string') agentCalls.set(content.id, name);
      }
      if (content.type === 'text' && !parsed.finalText && event.type === 'result') {
        parsed.finalText = content.text;
      }
    }
  }
  return parsed;
}

export function reviewersMatchModel(parsed: Parsed, required: string[], expected: string) {
  return required.every(name => (parsed.reviewerModels[name] ?? []).some(model => modelMatches(expected, model)));
}

export function validateRun(
  parsed: Parsed,
  required: string[],
  models?: ModelExpectations,
) {
  if (parsed.malformed.length) {
    throw new ReviewError(
      'STREAM_PARSE_FAILED',
      'Claude output contained malformed NDJSON.',
    );
  }
  if (!parsed.finalText) {
    throw new ReviewError('FINAL_RESULT_MISSING', 'Claude did not return a final review.');
  }
  if (models) {
    if (!parsed.initModel) {
      throw new ReviewError(
        'COORDINATOR_MODEL_UNVERIFIED',
        'Claude did not expose its coordinator model in the init event.',
      );
    }
    if (!modelMatches(models.coordinator, parsed.initModel)) {
      throw new ReviewError(
        'COORDINATOR_MODEL_MISMATCH',
        'Observed coordinator model does not match the configured model family.',
      );
    }
    parsed.coordinatorModelVerified = true;
  }

  const missing = required.filter(name => !parsed.invokedAgents.includes(name));
  if (missing.length) {
    const observed = parsed.invokedAgents.length ? parsed.invokedAgents.join(', ') : 'none';
    throw new ReviewError(
      'REQUIRED_AGENTS_MISSING',
      `Required native reviewers missing: ${missing.join(', ')}. Observed native Agent calls: ${observed}. Re-run with --keep-bundle to retain the bundle and the raw stream (stream.ndjson).`,
    );
  }
  return parsed;
}

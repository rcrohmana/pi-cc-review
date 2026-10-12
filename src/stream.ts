import { ReviewError } from './types.ts';

export interface StreamRunError {
  result?: string;
  errors: string[];
  subtype?: string;
  apiStatus?: string | number;
}

export interface Parsed {
  finalText: string;
  invokedAgents: string[];
  completedAgents: string[];
  failedAgents: Record<string, string>;
  malformed: string[];
  events: number;
  initModel?: string;
  observedModels: string[];
  coordinatorModelVerified: boolean;
  reviewerModels: Record<string, string[]>;
  runError?: StreamRunError;
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

function stringErrors(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join(' ');
}

function cloneParsed(parsed: Parsed): Parsed {
  return {
    ...parsed,
    invokedAgents: [...parsed.invokedAgents],
    completedAgents: [...parsed.completedAgents],
    failedAgents: { ...parsed.failedAgents },
    malformed: [...parsed.malformed],
    observedModels: [...parsed.observedModels],
    reviewerModels: Object.fromEntries(
      Object.entries(parsed.reviewerModels)
        .map(([name, models]) => [name, [...models]]),
    ),
    ...(parsed.runError === undefined ? {} : {
      runError: {
        ...parsed.runError,
        errors: [...parsed.runError.errors],
      },
    }),
  };
}

export function createStreamCollector() {
  const parsed: Parsed = {
    finalText: '',
    invokedAgents: [],
    completedAgents: [],
    failedAgents: {},
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

  const ingest = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
      parsed.events++;
    } catch {
      if (parsed.malformed.length < 5) parsed.malformed.push(line.slice(0, 500));
      return;
    }

    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      parsed.initModel ??= event.model;
    }
    recordModel(event.model);
    recordModel(event.message?.model);

    const parentId = event.parent_tool_use_id
      ?? event.parentToolUseId
      ?? event.message?.parent_tool_use_id
      ?? event.message?.parentToolUseId;
    const reviewer = typeof parentId === 'string' ? agentCalls.get(parentId) : undefined;
    const reviewerModel = event.message?.model ?? event.model;
    if (reviewer && typeof reviewerModel === 'string') {
      const models = parsed.reviewerModels[reviewer] ??= [];
      if (!models.includes(reviewerModel)) models.push(reviewerModel);
    }

    if (event.type === 'result') {
      const failed = event.is_error === true
        || (typeof event.subtype === 'string' && event.subtype.startsWith('error_'));
      if (failed) {
        parsed.runError = {
          ...(typeof event.result === 'string' ? { result: event.result } : {}),
          errors: stringErrors(event.errors),
          ...(typeof event.subtype === 'string' ? { subtype: event.subtype } : {}),
          ...(
            typeof event.api_error_status === 'string'
            || typeof event.api_error_status === 'number'
              ? { apiStatus: event.api_error_status }
              : {}
          ),
        };
      } else if (typeof event.result === 'string') {
        parsed.finalText = event.result;
      }
    }
    if (event.usage) parsed.usage = event.usage;

    for (const content of event.message?.content ?? []) {
      if (content.type === 'tool_use' && content.name === 'Agent') {
        const name = extractAgentName(content);
        if (typeof name === 'string' && !parsed.invokedAgents.includes(name)) {
          parsed.invokedAgents.push(name);
        }
        if (typeof name === 'string' && typeof content.id === 'string') {
          agentCalls.set(content.id, name);
        }
      }
      if (content.type === 'tool_result' && typeof content.tool_use_id === 'string') {
        const name = agentCalls.get(content.tool_use_id);
        if (name !== undefined) {
          if (content.is_error === true) {
            if (!parsed.completedAgents.includes(name)) {
              parsed.failedAgents[name] = toolResultText(content.content).slice(0, 300);
            }
          } else if (!parsed.completedAgents.includes(name)) {
            parsed.completedAgents.push(name);
            delete parsed.failedAgents[name];
          }
        }
      }
      if (
        content.type === 'text'
        && !parsed.finalText
        && event.type === 'result'
        && parsed.runError === undefined
      ) {
        parsed.finalText = content.text;
      }
    }
  };

  return {
    ingest,
    snapshot: () => cloneParsed(parsed),
  };
}

export function parseStream(stdout: string): Parsed {
  const collector = createStreamCollector();
  for (const line of stdout.split(/\r?\n/)) collector.ingest(line);
  return collector.snapshot();
}

export function streamFailureDiagnostic(parsed: Parsed): string {
  if (!parsed.runError) return '';
  const message = parsed.runError.result
    || parsed.runError.errors.join('; ')
    || parsed.runError.subtype
    || '';
  if (!message) return '';
  return parsed.runError.apiStatus === undefined
    ? message
    : `API ${parsed.runError.apiStatus}: ${message}`;
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
  const unsuccessful = required.filter(name => !parsed.completedAgents.includes(name));
  if (unsuccessful.length) {
    const details = unsuccessful
      .map(name => parsed.failedAgents[name] ? `${name} (${parsed.failedAgents[name]})` : `${name} (no successful result)`)
      .join('; ');
    throw new ReviewError(
      'REQUIRED_AGENTS_FAILED',
      `Required native reviewers did not complete successfully: ${details}. Re-run with --keep-bundle to retain the bundle and the raw stream (stream.ndjson).`,
    );
  }
  return parsed;
}

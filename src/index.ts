type ExecResult = { code: number; stdout: string; stderr: string };
type TuiLike = { requestRender(): void };
type ThemeLike = { fg?: (name: string, text: string) => string };
type CommandDefinition = { description: string; getArgumentCompletions(prefix: string): Array<{ value: string; label: string }>; handler: (input: string, ctx: CommandContext) => Promise<void> };
export type CommandPiApi = { exec(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<ExecResult>; sendMessage(message: unknown, options: unknown): void };
type ExtensionAPI = CommandPiApi & {
  registerCommand: (name: string, definition: CommandDefinition) => void;
  registerTool: (definition: ApprovalToolDefinition) => void;
};
type UiLike = { notify(message: string, type?: 'info'|'warning'|'error'): void; custom?: <T>(factory: (tui: TuiLike, theme: ThemeLike, keys: unknown, done: (result: T) => void) => unknown) => Promise<T> };
export type CommandContext = { cwd: string; mode?: string; hasUI?: boolean; ui: UiLike; sessionManager: { buildContextEntries(): unknown[] } };
export interface CompletedReview {
  content: string;
  details: Record<string, unknown>;
  raw: boolean;
  completionNotice: string;
}
export type ReviewDelivery = 'session' | 'return';
type RunOutcome = { result: ProcessResult; parsed: ReturnType<typeof validateRun> };
type UiOutcome = { ok: true; value: RunOutcome } | { ok: false; error: unknown };
type ExecutionOptions = ProcessRunOptions & { reducer?: ReturnType<typeof createProgressReducer> };
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HELP, parseArgs, validatedFile } from './args.ts';
import { buildClaudeArgs, requiredAgents } from './agents.ts';
import { cleanupBundle, createBundle } from './bundle.ts';
import { COORDINATOR_MODEL, REVIEWER_MODEL, REVIEW_EFFORT } from './config.ts';
import { buildContextEntries, truncateUtf8 } from './context.ts';
import { collectGit } from './git.ts';
import { collectFolder } from './folder.ts';
import { runProcess, type ProcessRunOptions, type ProcessResult } from './process.ts';
import type { ReviewProgressView } from './ui.ts';
import { errorText, formatDuration, redactDiagnostic, wrapReview } from './render.ts';
import {
  createStreamCollector,
  parseStream,
  reviewersMatchModel,
  streamFailureDiagnostic,
  validateRun,
} from './stream.ts';
import { createProgressReducer } from './progress.ts';
import { createProgressView } from './ui.ts';
import { createApprovalTool } from './approval-tool.ts';
import { createApprovalStore } from './approval-state.ts';
import type { ApprovalToolContext, ApprovalToolDefinition } from './approval-types.ts';
import { LIMITS, ReviewError, type EffectiveMode } from './types.ts';

type Deps = {
  run?: typeof runProcess;
  git?: typeof collectGit;
  bundle?: typeof createBundle;
  cleanup?: typeof cleanupBundle;
  file?: typeof validatedFile;
  folder?: typeof collectFolder;
};

const AUTO_FALLBACK_ERRORS = new Set([
  'NOT_A_GIT_REPOSITORY',
  'NO_CODE_CHANGES',
]);

let running = false;
let checkedAt = 0;
let claudeVersion = 'unknown';

function errorCode(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined; }
function supportsRequiredClaudeVersion(version: string) {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2
    || (major === 2 && minor > 1)
    || (major === 2 && minor === 1 && patch >= 205);
}

async function preflight(pi: CommandPiApi, cwd: string) {
  if (Date.now() - checkedAt < 300_000) return;

  const version = await pi.exec('claude', ['--version'], {
    cwd,
    timeout: 10_000,
  });
  if (version.code !== 0) {
    throw new ReviewError(
      'CLAUDE_NOT_FOUND',
      'Claude Code is unavailable. Install or repair Claude Code.',
    );
  }

  claudeVersion = version.stdout.trim();
  if (!supportsRequiredClaudeVersion(claudeVersion)) {
    throw new ReviewError(
      'CLAUDE_VERSION_UNSUPPORTED',
      'Claude Code 2.1.205 or later is required.',
    );
  }

  const auth = await pi.exec('claude', ['auth', 'status'], {
    cwd,
    timeout: 10_000,
  });
  if (auth.code !== 0) {
    throw new ReviewError(
      'CLAUDE_NOT_AUTHENTICATED',
      'Claude Code is not authenticated. Run: claude auth login',
    );
  }
  checkedAt = Date.now();
}

async function readStopHookState(directory: string): Promise<{ fired: number; blocks: number }> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'stop-hook-state.json'), 'utf8'));
    return {
      fired: typeof parsed.fired === 'number' ? parsed.fired : 0,
      blocks: typeof parsed.blocks === 'number' ? parsed.blocks : 0,
    };
  } catch {
    return { fired: 0, blocks: 0 };
  }
}

async function retainInjectedStream(path: string, stdout: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, stdout, { mode: 0o600 }).catch(() => {});
  }
}

export function createCommandHandler(
  pi: CommandPiApi,
  overrides: Deps = {},
  options: { delivery?: ReviewDelivery; rethrow?: boolean } = {},
): (input: string, ctx: CommandContext) => Promise<CompletedReview | undefined> {
  const delivery = options.delivery ?? 'session';
  const rethrow = options.rethrow ?? false;
  const run = overrides.run ?? runProcess;
  const git = overrides.git ?? collectGit;
  const bundleFactory = overrides.bundle ?? createBundle;
  const cleanup = overrides.cleanup ?? cleanupBundle;
  const file = overrides.file ?? validatedFile;
  const folder = overrides.folder ?? collectFolder;

  return async (input: string, ctx: CommandContext) => {
    let bundle: Awaited<ReturnType<typeof createBundle>> | undefined;
    let args: ReturnType<typeof parseArgs> | undefined;
    let ownsLock = false;

    try {
      args = parseArgs(input);
      if (args.help) {
        ctx.ui.notify(HELP, 'info');
        return;
      }
      if (running) {
        ctx.ui.notify(
          '[ALREADY_RUNNING] A Claude Code review is already running.',
          'warning',
        );
        return;
      }
      running = true;
      ownsLock = true;

      await preflight(pi, ctx.cwd);

      let mode: EffectiveMode;
      let evidence: Awaited<ReturnType<typeof collectGit>> | undefined;
      let folderEvidence: Awaited<ReturnType<typeof collectFolder>> | undefined;
      if (args.mode === 'repo') {
        mode = 'repo';
        folderEvidence = await folder(ctx.cwd);
      } else if (args.mode === 'code' || args.mode === 'auto') {
        try {
          evidence = await git(ctx.cwd, args.base);
          mode = 'code';
        } catch (error) {
          const code = errorCode(error);
          if (args.mode === 'code' || args.base || !AUTO_FALLBACK_ERRORS.has(code ?? '')) throw error;
          mode = 'plan';
          ctx.ui.notify('No reviewable Git changes — falling back to plan review.', 'info');
        }
      } else {
        mode = args.mode;
      }

      if (args.file && (mode === 'code' || mode === 'repo')) {
        throw new ReviewError('USAGE_ERROR', '--file is only valid for plan or spec review.');
      }
      const entries = ctx.sessionManager.buildContextEntries();
      const extracted = buildContextEntries(
        entries,
        mode !== 'code' && mode !== 'repo' && !args.file,
      );
      let objective = extracted.objective;
      let context = extracted.context;
      let artifact = extracted.artifact;
      let truncated = extracted.truncated || Boolean(evidence?.truncated) || Boolean(folderEvidence?.truncated);
      if (mode === 'repo') {
        artifact = folderEvidence!.artifact;
        if (!objective) objective = 'Review the current folder from a bounded read-only source snapshot.';
      } else if (mode === 'code') {
        artifact = 'See bounded Git evidence files.';
        if (!objective) objective = 'Review current Git changes.';
      } else if (args.file) {
        const target = await file(ctx.cwd, args.file);
        const source = await readFile(target, 'utf8');
        const boundedArtifact = truncateUtf8(source, LIMITS.artifactBytes, '\n[TRUNCATED: artifact file limit]');
        artifact = boundedArtifact.text;
        truncated ||= boundedArtifact.truncated;
      }

      const reviewers = requiredAgents(mode, args.deep);
      try {
        bundle = await bundleFactory({
          mode,
          workingDirectory: ctx.cwd,
          objective,
          artifact,
          context,
          required: reviewers,
          focus: args.focus,
          git: evidence,
          truncated,
        });
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        throw new ReviewError('BUNDLE_CREATION_FAILED', 'Could not create the review bundle.');
      }

      ctx.ui.notify(`Starting Claude Code ${mode} review (1× ${COORDINATOR_MODEL} + ${reviewers.length}× ${REVIEWER_MODEL}, ${REVIEW_EFFORT} effort)…`, 'info');
      const executeRunAndValidate = async (options: ExecutionOptions = {}): Promise<RunOutcome> => {
        const streamPath = join(bundle!.directory, 'stream.ndjson');
        const collector = createStreamCollector();
        const onStdoutLine = (line: string) => {
          collector.ingest(line);
          options.onStdoutLine?.(line);
        };
        const result = await run(
          'claude',
          buildClaudeArgs(bundle!.directory, ctx.cwd, reviewers, args!.deep),
          mode === 'repo' ? bundle!.directory : ctx.cwd,
          LIMITS.timeout,
          { ...options, onStdoutLine, stdoutFile: streamPath },
        );
        if (args!.keepBundle) await retainInjectedStream(streamPath, result.stdout);

        const streamed = collector.snapshot();
        const parsed = streamed.events > 0 ? streamed : parseStream(result.stdout);

        if (result.timedOut) {
          throw new ReviewError(
            'PROCESS_TIMEOUT',
            'Claude Code review timed out. Try --focus or a smaller --base range.',
          );
        }
        if (result.code !== 0) {
          const nonJsonStdout = result.stdout
            .split(/\r?\n/)
            .filter((line: string) => !line.trimStart().startsWith('{'))
            .join('\n');
          const candidate = streamFailureDiagnostic(parsed)
            || result.stderr
            || nonJsonStdout;
          const detail = redactDiagnostic(candidate);
          throw new ReviewError(
            'PROCESS_FAILED',
            `Claude Code exited ${result.code}.${detail ? ` Details: ${detail}` : ''}`,
          );
        }

        ctx.ui.notify('Claude Code review completed; validating delegation…', 'info');
        options.reducer?.setPhase('validating');
        return {
          result,
          parsed: validateRun(parsed, reviewers, { coordinator: COORDINATOR_MODEL }),
        };
      };
      const useProgressUi = ctx.mode === 'tui' && ctx.hasUI === true && typeof ctx.ui.custom === 'function';
      let runOutcome: RunOutcome;
      if (useProgressUi) {
        const custom = ctx.ui.custom;
        if (!custom) throw new ReviewError('UI_UNAVAILABLE', 'Interactive progress UI is unavailable.');
        const outcome = await custom<UiOutcome>((tui, theme, _keys, done) => {
          let view: ReviewProgressView;
          const reducer = createProgressReducer(reviewers, state => view?.update(state));
          view = createProgressView(tui, theme, mode, COORDINATOR_MODEL, REVIEWER_MODEL, REVIEW_EFFORT, reducer.snapshot());
          view.onAbort = () => reducer.setPhase('cancelling');
          void executeRunAndValidate({ signal: view.signal, onStdoutLine: reducer.ingest, reducer })
            .then(value => { view.dispose(); done({ ok: true, value }); })
            .catch(error => { view.dispose(); done({ ok: false, error }); });
          return view;
        });
        if (outcome.ok === false) throw outcome.error;
        runOutcome = outcome.value;
      } else {
        let heartbeatSeen = 0;
        const reducer = createProgressReducer(reviewers, state => {
          for (let index = heartbeatSeen; index < state.invokedAgents.length; index++) {
            ctx.ui.notify(`Reviewer ${state.invokedAgents[index]} invoked (${index + 1}/${state.requiredAgents.length}).`, 'info');
          }
          heartbeatSeen = state.invokedAgents.length;
          if (state.phase === 'synthesizing') ctx.ui.notify('All reviewers invoked; reconciling evidence…', 'info');
        });
        runOutcome = await executeRunAndValidate({ onStdoutLine: reducer.ingest, reducer });
      }
      const result = runOutcome.result;
      const parsed = runOutcome.parsed;
      const stopHookState = await readStopHookState(bundle.directory);
      const metadata = {
        source: 'claude-code',
        explicitInvocation: true,
        mode,
        requiredAgents: reviewers,
        invokedAgents: parsed.invokedAgents,
        validDelegation: true,
        claudeVersion,
        coordinatorModel: COORDINATOR_MODEL,
        reviewerModel: REVIEWER_MODEL,
        observedCoordinatorModel: parsed.initModel,
        observedModels: parsed.observedModels,
        coordinatorModelVerified: parsed.coordinatorModelVerified,
        reviewerModels: parsed.reviewerModels,
        reviewerModelVerified: reviewersMatchModel(parsed, reviewers, REVIEWER_MODEL),
        deep: args.deep,
        durationMs: result.durationMs,
        bundleTruncated: truncated || bundle.truncated,
        bundleRetained: args.keepBundle,
        stopHookFired: stopHookState.fired > 0,
        stopHookBlocks: stopHookState.blocks,
        ...(args.keepBundle ? { bundlePath: bundle.directory } : {}),
      };

      const content = wrapReview(parsed.finalText);
      const completionNotice = args.raw
        ? `Claude Code review completed in ${formatDuration(result.durationMs)} · ${reviewers.length} reviewers.`
        : delivery === 'session'
          ? `Claude Code review added to Pi (${formatDuration(result.durationMs)} · ${reviewers.length} reviewers).`
          : `Claude Code review completed in ${formatDuration(result.durationMs)} · ${reviewers.length} reviewers.`;
      const completed: CompletedReview = { content, details: metadata, raw: args.raw, completionNotice };
      if (delivery === 'session') {
        try {
          pi.sendMessage(
            {
              customType: 'cc-review-result',
              display: true,
              content,
              details: metadata,
            },
            { triggerTurn: !args.raw, deliverAs: 'followUp' },
          );
        } catch {
          throw new ReviewError(
            'PI_INJECTION_FAILED',
            'The review was valid but could not be added to the Pi session.',
          );
        }
      }
      if (stopHookState.blocks > 0) {
        ctx.ui.notify(`Stop hook corrected delegation (${stopHookState.blocks} block(s)).`, 'info');
      }
      ctx.ui.notify(completionNotice, 'info');
      return completed;
    } catch (error) {
      ctx.ui.notify(errorText(error), 'error');
      if (rethrow) throw error;
      return undefined;
    } finally {
      if (bundle && !args?.keepBundle) {
        await cleanup(bundle.directory).catch(() => {});
      }
      if (ownsLock) running = false;
    }
  };
}

function commandContextFromApproval(ctx: ApprovalToolContext): CommandContext {
  const { sessionManager, ui } = ctx;
  if (!ui || typeof sessionManager.buildContextEntries !== 'function') {
    throw new ReviewError('CC_REVIEW_EXECUTION_FAILED', 'Approved review context is unavailable.');
  }
  const commandUi: UiLike = {
    notify: (message, type) => ui.notify(message, type),
    ...(ui.custom === undefined ? {} : {
      custom: <T>(factory: (tui: TuiLike, theme: ThemeLike, keys: unknown, done: (result: T) => void) => unknown) => ui.custom!(factory),
    }),
  };
  return {
    cwd: ctx.cwd,
    ...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
    ...(ctx.hasUI === undefined ? {} : { hasUI: ctx.hasUI }),
    ui: commandUi,
    sessionManager: { buildContextEntries: () => sessionManager.buildContextEntries!() },
  };
}

export function registerExtension(pi: ExtensionAPI, overrides: Deps = {}): void {
  const approvalStore = createApprovalStore();
  const directHandler = createCommandHandler(pi, overrides);
  const approvedHandler = createCommandHandler(pi, overrides, { delivery: 'return', rethrow: true });
  pi.registerTool(createApprovalTool({
    store: approvalStore,
    executeReview: async (canonicalTail, ctx) => {
      const result = await approvedHandler(canonicalTail, commandContextFromApproval(ctx));
      if (!result) throw new ReviewError('CC_REVIEW_EXECUTION_FAILED', 'The approved review did not complete.');
      return result;
    },
  }));
  const completions = [
    'auto',
    'plan',
    'spec',
    'code',
    'repo',
    '--file',
    '--base',
    '--focus',
    '--deep',
    '--raw',
    '--keep-bundle',
    '--help',
  ];
  pi.registerCommand('cc-review', {
    description: 'Explicit, read-only Claude Code second-opinion review',
    getArgumentCompletions: (prefix: string) => completions
      .filter(value => value.startsWith(prefix))
      .map(value => ({ value, label: value })),
    handler: async (input, ctx) => { await directHandler(input, ctx); },
  });
}

export default function extension(pi: ExtensionAPI) {
  registerExtension(pi);
}

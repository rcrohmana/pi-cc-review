# Pi `/cc-review`

Global Pi extension that brings Claude Code into Pi as a **read-only second opinion**:

- **Reviews** — `/cc-review` runs one Claude Code coordinator that delegates to 2–3 native reviewer subagents and returns a validated review.
- **Advisor** — modeled on Claude Code's `/advisor`: `/cc-review advise` asks a stronger model for short guidance once; `/cc-advisor on` lets the Pi model consult it on its own within a small per-session budget.

It registers exactly the commands `/cc-review` and `/cc-advisor`, the tools `cc_review_approval` and `cc_advise` (the latter inactive until the user grants it), one message renderer for `cc-advise-result`, and only `session_start`/`session_shutdown` handlers that revoke the advisor grant. No event handler, timer, watcher, or normal prompt can start Claude.

## Quick start

Located at `~/.pi/agent/extensions/cc-review/`; Pi auto-discovers `index.ts`. Run `/reload` (or restart Pi) after installing or editing the extension or its skill.

| Command | What it does |
|---|---|
| `/cc-review` | Review Git changes (falls back to `plan` when there are none) |
| `/cc-review plan` · `spec [--file <path>]` | Review the latest substantial assistant artifact, or a contained file |
| `/cc-review code [--base <ref>]` | Review working-tree, staged, and optional base-range changes |
| `/cc-review repo` | Review a bounded read-only snapshot of the current folder (no Git needed) |
| `/cc-review … --deep` | Add a third reviewer (security or risk) and a higher turn cap |
| `/cc-review advise [--focus "<question>"]` | One advisor consultation on the current task |
| `/cc-advisor on [--max N]` · `off` · `status` | Let the model consult the advisor itself, up to N times this session |
| `/cc-review --help` · `/cc-advisor --help` | Usage, without starting Claude |

Shared options: `--focus <text>` (reviewer focus or advisor question, max 2,000 characters), `--raw` (show the result without a Pi follow-up turn), `--keep-bundle` (keep the temporary evidence directory and raw stream and report its path).

Prerequisites: Claude Code 2.1.205 or later, installed and authenticated (`claude auth login`); Node.js 22.6 or later. The extension has no runtime package dependency.

## Reviews (`/cc-review`)

A review starts one `claude -p` coordinator (Fable) with dynamically defined native reviewers (Sonnet):

| Mode | Required reviewers | `--deep` adds |
|---|---|---|
| `code`, `repo` | `correctness-reviewer`, `test-reviewer` | `security-reviewer` |
| `plan` | `requirements-critic`, `architecture-critic` | `risk-critic` |
| `spec` | `requirements-critic`, `implementation-feasibility-reviewer` | `risk-critic` |

The evidence bundle is a private temporary directory (`pi-cc-review-*`) with the objective, the artifact, bounded active-branch context, and bounded Git diffs or a bounded folder snapshot, all labelled as untrusted. `repo` needs no Git repository: it snapshots the current folder, excluding symlinks, generated and binary files, lockfiles, and the shared secret file list; oversized text is included as a bounded prefix, and large folders are truncated, so a snapshot is never exhaustive. In repo mode Claude runs from the snapshot bundle, not the source folder.

In the interactive TUI, a dependency-free progress panel shows the stage, elapsed time, and invoked-reviewer count; press Escape twice within 3 seconds to cancel, which terminates the Claude process tree before cleanup and lock release. RPC and print modes show notifications only (one per invoked reviewer and one when synthesis starts); terminal errors are the only `[CODE]`-prefixed messages. The complete Claude stream is written to `stream.ndjson` in the bundle, so multi-agent streams beyond 1 MB do not abort a valid review; only the final validated review reaches Pi, wrapped as external untrusted data.

## Advisor

Claude Code's advisor lets a main model consult a stronger model at decision points and continue with its guidance. This extension provides the same pattern for Pi, with Claude Code as the advisor:

| | Claude Code `/advisor` | This extension |
|---|---|---|
| Advisor | Server-side tool on the Anthropic API | One local `claude -p` process (`fable`, `high` effort) |
| Who calls it | The main model, at decision points | The Pi model via `cc_advise` after `/cc-advisor on`, or the user via `/cc-review advise` |
| What it sees | The full conversation | A bounded, redacted digest of the active Pi branch plus read-only repository access |
| Output | Guidance, or a decline | `Verdict: proceed \| revise \| stop \| decline` with Recommendation, Key risks, Next steps, Evidence checked |
| Limits | No per-session cap | Per-session budget (default 3, max 10), one consultation per assistant message |

### One-off consultation: `/cc-review advise`

`/cc-review advise [--focus "<question>"] [--raw] [--keep-bundle]` runs a single read-only advisor process: no reviewers or subagents, at most 8 turns, a 3-minute timeout, tools `Read,Grep,Glob` only, and `Agent`/`Task` disallowed. Guidance is delivered as a `cc-advise-result` message wrapped as external, untrusted advice (`--raw` suppresses the follow-up turn). A missing verdict line is reported as `unknown`. Delegation attempts, an unverified model, a missing final answer, a timeout, or a runtime error fail closed and inject nothing.

### Model-initiated consultations: `/cc-advisor`

`/cc-advisor on [--max N]` grants the Pi model up to N consultations in the current session through the `cc_advise` tool; `status` shows the remaining budget and `off` revokes the grant.

- **Opt-in only.** `cc_advise` is registered with `defaultActive: false`, so the model does not see it until the user types `/cc-advisor on`. Only a user-typed slash command creates the grant, and execution re-checks it even if the tool is somehow active.
- **Session-scoped.** The grant is in memory and bound to the session ID. Every `session_start` (startup, reload, new, resume, fork), `session_shutdown`, `/cc-advisor off`, and budget exhaustion revoke it and deactivate the tool.
- **Bounded.** At most one consultation per assistant message, sequential execution, and the single Claude lock shared with reviews. A busy lock is rejected before any budget is used; a consultation that started is charged even if it fails, so retries cannot loop.
- **Strict input.** Only `question` (required) and `focus`, each 1–2,000 characters. Errors return `[CODE] message`.
- **When the model consults.** While active, `cc_advise` adds prompt guidelines: consult before choosing between alternative designs (before writing the implementation), after the same error recurs twice, and before declaring a multi-step task complete, especially after changing a test or expected value; not for trivial steps; treat guidance as evidence to verify, and pause for the user on `stop`. The `cc-review-routing` skill states the same triggers, never routes advice through `cc_review_approval`, and suggests `/cc-advisor on` or `/cc-review advise` instead of enabling anything itself. Unlike Claude Code, whose models are trained to use their advisor, the Pi model relies on these instructions, so consultation remains model-driven and is not guaranteed.

### Transcript display

The `cc_advise` row shows `◆ Advisor (fable · high)` and the question. While the consultation runs, a transient partial result shows `◌ Advising (fable · high)…`. The finished row collapses to one status line with a recommendation preview:

```text
✓ Advisor reviewed · verdict: revise · 37s · 1 of 2 left
○ Advisor declined to advise · 9s
✗ Advisor unavailable (PROCESS_TIMEOUT)
✗ Advisor not run (CC_ADVISOR_BUDGET_EXHAUSTED)
```

Expanding the row (Ctrl+O) shows the full guidance without the untrusted-data wrapper. `/cc-review advise` results get the same compact view in the interactive TUI.

### What the advisor sees

The advisor bundle (`pi-cc-advise-*`) contains:

- `question.md`: the question and optional focus.
- `transcript.md`: a digest of the active branch from `buildContextEntries()` (compaction-aware, context edits applied). It includes user and assistant text (8 KB each), tool calls (2 KB of arguments), tool results (4 KB), user shell runs, extension messages, and compaction or branch summaries, newest first within 60 KB. Thinking, system prompts, and images are excluded; earlier advisor results collapse to a verdict line so the advisor does not anchor on its own advice.
- `git-summary.txt`: branch, `git status --short`, and `git diff --stat` when the folder is a Git repository. Full diffs are not included; the advisor can read files itself.

Before anything is written, `redactSecrets()` replaces private key blocks, credentials in URLs, Bearer tokens, common token formats (`sk-`, `ghp_`, `github_pat_`, `xox…`, `AKIA…`, `AIza…`, `npm_`, JWTs), and secret-named assignments (`PASSWORD=…`, `"client_secret": "…"`). Guards keep ordinary code readable (type annotations, dotted references, calls, short or numeric values). Redaction is pattern-based: unusually formatted secrets that appear in the session can still reach the advisor, so avoid advisor consultations in sessions that handled secrets you cannot share with Anthropic.

## Costs and limits

Every review or consultation invokes Claude Code and consumes account usage. Fable may bill to usage credits on some plans.

| Run | Claude processes and models | Turns | Timeout |
|---|---|---|---|
| Review | 1× `fable` coordinator + 2–3× `sonnet` reviewers, `high` effort | 16 (24 with `--deep`) | 15 min |
| Advisor | 1× `fable`, `high` effort, no subagents | 8 | 3 min |

Only one Claude process runs at a time across reviews, approved reviews, and advisor consultations (`[ALREADY_RUNNING]` otherwise). Observed live advisor consultations took 22–37 seconds.

## Natural-language confirmation routing

The global skill at `~/.pi/agent/skills/cc-review-routing/SKILL.md` handles clear natural-language requests for a `cc-review` second opinion. It calls the single `cc_review_approval` tool with a structured proposal; it does not use `pi-intercom`, delegate to another session, or call an API. The request phase does not run Claude: it returns a proposed canonical `/cc-review ...` command and an opaque request ID for consent.

Reply in a later user message with exactly `ya`, `yes`, `lanjut`, or `approve`. Assistant/tool entries do not approve; same-turn execute is rejected, and more than one newer user-role message makes the request stale. After exact approval, execute invokes the existing review workflow through the shared gated runner and returns the actual external report in tool content; it does not synthesize a slash-command user message. TUI approved execution shows the same progress panel as direct `/cc-review`, and every mode honors Pi's tool abort signal (an already-aborted call never starts Claude or consumes its approval). Non-raw results remain available to Pi for reconciliation; raw results set tool termination to avoid an automatic Pi follow-up. Direct `/cc-review ...` commands bypass this gate. Approval is in-memory, session-bound, single-use, and invalidated by `/reload`, session switch, fork, clone, process restart, or extension reload.

The public proposal uses only `mode`, `file`, `base`, `focus`, `deep`, and `raw` (advise is not available through approval). A Pi file mention may have exactly one leading `@`; pass the `file` value without that marker (for example, `@PVT_Calculator_Kunci_Jawaban.ipynb` becomes `PVT_Calculator_Kunci_Jawaban.ipynb`). Only `file` gets this normalization. Empty, control-character, both-quote, and out-of-workspace paths are rejected, and file/base/focus values must round-trip through the parser. Pi extension-origin user messages skip command expansion, so synthetic `/cc-review` messages cannot dispatch this command. All routing tests use fake Pi/session/process objects; no paid/live Claude run is claimed for routing.

## Model configuration

All models live in `src/config.ts`:

```ts
export const COORDINATOR_MODEL = 'fable';
export const REVIEWER_MODEL = 'sonnet';
export const REVIEW_EFFORT = 'high';

export const ADVISOR_MODEL = 'fable';
export const ADVISOR_EFFORT = 'high';
export const ADVISOR_TIMEOUT_MS = 180_000;
export const ADVISOR_MAX_TURNS = 8;
export const ADVISOR_DEFAULT_BUDGET = 3;
export const ADVISOR_MAX_BUDGET = 10;
```

Use Claude Code aliases available to your account (`fable`, `opus`, `sonnet`, `haiku`) and an effort level the model supports, then run `/reload`.

Configured aliases are not runtime proof. Each run must expose its coordinator or advisor model in the `system/init` stream event and match the configured family, or it fails closed (`observedCoordinatorModel`/`observedModel`, `coordinatorModelVerified`/`modelVerified`). Reviewer model verification is observational: `reviewerModels` lists models from subagent events whose `parent_tool_use_id` maps to that reviewer's own `Agent` call, and `reviewerModelVerified: false` means "not proven by this stream", not "wrong model".

## Security boundary

**Process.** Only the command handlers and the two tools reach process creation, always `claude` with an argument array (no shell). Every run uses `--setting-sources ""` (no user, project, or local settings, so no CLAUDE.md, user agents, user hooks, or plugins beyond Claude Code's built-ins, while OAuth keeps working), `--strict-mcp-config`, `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`, `--permission-mode dontAsk`, and explicit disallow lists for `Edit`, `Write`, `Bash`, `NotebookEdit`, `WebFetch`, `WebSearch`, and MCP tools. There is no bypass-permission mode, shell interpolation, direct Anthropic API, or Pi review subagent. `--safe-mode` is not used: on Claude Code 2.1.296 it also disables `--agents` reviewers and injected hooks. `--bare` is not used because it accepts only API-key authentication.

**Read boundary** (`src/permissions.ts`). The only allow rules are `Agent` (reviews) and `Read(./**)`; the evidence bundle is reachable through `--add-dir`. Under `dontAsk`, reads and searches outside the working directory and bundle are denied. Deny rules injected through inline `--settings` block every secret file glob shared with the folder snapshot (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `credentials.json`, and others) as `Read(//**/<glob>)` on every drive, plus home credential stores (`~/.ssh/**`, `~/.aws/**`, `~/.claude/.credentials.json`, `~/.pi/agent/auth.json`, and others). Claude Code applies Read rules to Grep and Glob on a best-effort basis, and the list is pattern-based, so an unusually named secret file inside the working directory remains readable.

**Delegation integrity** (reviews). A review is accepted only when every required reviewer has a real `Agent` tool call **and** a non-error `tool_result` that is not a background-launch acknowledgement; otherwise `[REQUIRED_AGENTS_MISSING]` or `[REQUIRED_AGENTS_FAILED]`. Text claiming delegation is rejected. Claude runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, which forces Agent calls into the foreground. Injected `PostToolUse`/`PostToolUseFailure` hooks record each reviewer outcome to `agent-outcomes.jsonl`, and a `Stop` hook blocks the coordinator (at most twice) while a required reviewer has not completed, including when it never delegated; malformed hook input fails open, and the post-run validator remains the fail-closed backstop. The advisor must not delegate at all (`[ADVISOR_DELEGATION_FORBIDDEN]`).

**Bundles.** Private temporary directories with mode 0600 files where Node enforces it (on Windows, the per-user temp-directory ACL), deleted in `finally` unless `--keep-bundle` is set. Retained review bundles also keep `stop-hook-state.json`, `agent-outcomes.jsonl`, and `stream.ndjson`. Organization-managed Claude Code policy settings and hooks still apply; use the extension only in environments whose policy you understand.

## Error codes

| Code | Meaning |
|---|---|
| `CLAUDE_NOT_FOUND`, `CLAUDE_VERSION_UNSUPPORTED`, `CLAUDE_NOT_AUTHENTICATED` | Preflight failed |
| `ALREADY_RUNNING` | Another review or consultation holds the Claude lock |
| `USAGE_ERROR` | Invalid command arguments |
| `PROCESS_TIMEOUT`, `PROCESS_FAILED`, `PROCESS_CANCELLED` | Claude timed out, exited non-zero (redacted runtime detail included), or was cancelled |
| `REQUIRED_AGENTS_MISSING`, `REQUIRED_AGENTS_FAILED` | A required reviewer was never invoked, or did not complete successfully |
| `COORDINATOR_MODEL_UNVERIFIED`, `COORDINATOR_MODEL_MISMATCH` | The observed coordinator/advisor model is missing or of the wrong family |
| `FINAL_RESULT_MISSING`, `STREAM_PARSE_FAILED` | No final answer, or malformed stream output |
| `ADVISOR_DELEGATION_FORBIDDEN` | The advisor tried to use `Agent`/`Task` |
| `CC_ADVISOR_NOT_ENABLED`, `CC_ADVISOR_BUDGET_EXHAUSTED`, `CC_ADVISOR_RATE_LIMITED`, `CC_ADVISOR_INVALID_OPTIONS` | `cc_advise` rejected before starting Claude (no budget charged) |
| `CC_REVIEW_*` | Approval-gate rejections (see the routing section) |

## Validation

```bash
cd ~/.pi/agent/extensions/cc-review
npm test
npm run check
```

The suite (205 tests; on Windows, two symlink tests and one process-tree PID test are skipped) uses only Node, temporary Git fixtures, fake Pi/session objects, and fake executables; it consumes no Claude usage. It covers argument parsing and help; approval schema, canonicalization, state, replay, expiry, and concurrency; exact review and advisor argv (variadic flags never followed by the prompt, deny rules, scoped reads, no `--safe-mode`); delegation validation including failed, unanswered, and background-launched reviewers; Stop-hook outcome recording and blocking; stream parsing, disk-backed streams beyond 1 MB, and runtime diagnostics; Git evidence and the advisor Git summary; folder snapshots and the shared secret list; bundle bounds and cleanup; cancellation in TUI, RPC, and print modes; the transcript digest and secret redaction; advisor runs, verdict parsing, fail-closed cases, lock sharing, and `--keep-bundle`; the advisor grant, budget, per-message limit, session resets, and strict parameters; prompt-guideline and skill consistency; and transcript rendering. `npm run check` is the strict TypeScript check for production and test code, with `erasableSyntaxOnly` so code stays compatible with Node's type stripping.

### Live evidence

Credit-consuming checks run by hand on Claude Code 2.1.296 (2026-10-12); `haiku` replaced the configured models where noted, to save usage:

- **Reviews:** with the production argv (`haiku`), both required plan reviewers completed with parent-attributed subagent events and passed validation; a coordinator instructed to skip delegation was blocked twice by the Stop hook and then rejected with `[REQUIRED_AGENTS_MISSING]`.
- **Read boundary:** with canary files, reviewers read ordinary files and the bundle, while `.env`, `.pem`, files outside the working directory, Grep outside it, and a `~/` deny rule were all denied; no secret canary leaked.
- **Advisor (`fable`, real handler):** in a scenario where the executor planned to change a test expectation, the advisor returned `revise`, identified the real bug at `src/math.js:2`, used only `Read`, did not read the `.env` canary, and finished in 36 s.
- **Pi integration (RPC, only this extension, Pi model `haiku`):** `cc_advise` was hidden before `/cc-advisor on`, called once by the model, removed after the budget was used, and rendered as expected in HTML export. With the advisor never mentioned in the prompt, an architecture decision triggered one consultation before the implementation was written, and a trivial bug fix did not.

Earlier history: on Claude Code 2.1.212–2.1.215, live reviews validated native delegation in code, plan, and spec modes. On 2.1.296 the then-used `--safe-mode` stopped loading `--agents` reviewers, and the validator of that time accepted runs from Agent tool-use events alone, so reviews produced on that combination may not have involved the native reviewers. The current invocation and validator close that gap.

### Manual acceptance (interactive TUI)

These steps consume Claude usage. Use a disposable Git repository with an uncommitted change.

1. Record `git status --short`. Run `/cc-review --help` and `/cc-advisor --help`; confirm no Claude process starts.
2. `/cc-review code --raw`: the progress panel lists both reviewers with checkmarks, the review is delivered without a follow-up turn, and `git status --short` is unchanged.
3. Start `/cc-review plan --raw` and press Escape twice: the panel shows cancelling, `[PROCESS_CANCELLED]` appears, and a new command can start immediately.
4. `/cc-review advise --raw --focus "Is my next step right?"`: the advisor panel shows `Claude Code Advisor · fable · high`, then a compact `◆ Claude Code advisor … /cc-review advise` row with `✓ Advisor reviewed · verdict: …`; Ctrl+O expands the full guidance.
5. `/cc-advisor status` reports off. `/cc-advisor on --max 1`, then ask for a design decision (for example, choosing a caching strategy) or say "consult the advisor": a `◆ Advisor (fable · high)` row shows `◌ Advising…` while running, then a collapsed status line ending in `0 of 1 left`; Ctrl+O expands it.
6. Ask again for advice: `cc_advise` is no longer offered, and `/cc-advisor status` reports off. Run `/reload` after `/cc-advisor on` and confirm `status` reports off.
7. Confirm `git status --short` is unchanged and no `pi-cc-review-*` or `pi-cc-advise-*` directories remain in the temp folder.

## Known limitations

- Advisor consultations are model-driven; the Pi model may skip a consultation the guidelines call for, or consult when not needed. The budget bounds the cost.
- Secret redaction and the secret file list are pattern-based.
- Read rules apply to Grep and Glob on a best-effort basis (Claude Code behavior).
- Reviewer model verification is observational and can be `false` even when the configured reviewers ran.
- Organization-managed Claude Code policies and hooks still apply to every run.

## Rollback

- **Advisor only:** run `/cc-advisor off`, or simply do not grant it; the grant never persists across sessions, and `/cc-review advise` runs only when typed.
- **Skill:** the pre-advisor version of the routing skill is saved at `~/.pi/agent/backups/cc-review-routing-SKILL.before-advisor-20261012.md`; copy it back to `~/.pi/agent/skills/cc-review-routing/SKILL.md`.
- **Extension:** check out an earlier commit, or remove or rename `~/.pi/agent/extensions/cc-review/`; then run `/reload` and delete any retained `pi-cc-review-*` or `pi-cc-advise-*` temporary directories. The extension changes no provider, Pi, Claude authentication, or repository configuration.

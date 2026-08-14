# Pi `/cc-review`

Global Pi extension providing one explicit, read-only Claude Code second-opinion command plus one confirmation-gated model-callable tool. It registers exactly `/cc-review` and `cc_review_approval`; no event handler, timer, watcher, or normal prompt can start Claude.

## Install / use

Located at `~/.pi/agent/extensions/cc-review/`; Pi auto-discovers `index.ts`. Run `/reload` (or restart Pi), then:

```text
cd C:\any\folder
pi
/cc-review repo
/cc-review repo --deep --focus "Honest review of correctness, security, and tests"

/cc-review --help
/cc-review plan
/cc-review spec --file docs/spec.md
/cc-review code --base main --focus "rollback and races"
/cc-review code --deep
/cc-review repo --deep --focus "Honest review of correctness, security, and tests"
```

In interactive Pi TUI mode, `/cc-review` shows a dependency-free custom progress panel with factual stage, elapsed time, and invoked-reviewer count (not a completion percentage). A first Escape arms cancellation and a second Escape within 3 seconds cancels; the process runner then terminates the Claude tree before cleanup and lock release. The panel never streams Claude or repository content. RPC and print modes retain notifications only; these non-TUI runs also emit a small number of non-terminal plain-text progress notifications — one per invoked reviewer and one when synthesis begins — while terminal errors remain the only bracket-prefixed (`[CODE]`) messages. `--raw` changes only Pi follow-up delivery, not review/progress behavior. Automated progress/cancellation tests use fake processes only; no paid live progress run is claimed.

The complete Claude stream is written incrementally to the private temporary evidence bundle, so multi-agent NDJSON exceeding 1 MB does not terminate an otherwise valid review. Only the final validated review is delivered to Pi; coordinator, tool, and subagent stream events remain evidence for validation. Normal cleanup deletes the stream with the bundle, while `--keep-bundle` retains `stream.ndjson` for inspection.

`repo` needs no Git repository, path, file, or assistant artifact. It audits only Pi's current working folder through a bounded snapshot, excluding symlinks, generated, binary, and common sensitive files; eligible oversized UTF-8 text is included only as a bounded prefix with a truncation marker; large folders can be truncated and are not exhaustive. Claude runs from the snapshot bundle in repo mode, not the source folder. Repo mode has fake-process automated coverage only; no paid live repo review is claimed. `--raw` displays the external review without triggering Pi reconciliation. `--keep-bundle` retains the bounded temporary evidence directory and prints it in metadata.

## Natural-language confirmation routing

The global skill at `~/.pi/agent/skills/cc-review-routing/SKILL.md` handles clear natural-language requests for a `cc-review` second opinion. It calls the single `cc_review_approval` tool with a structured proposal; it does not use `pi-intercom`, delegate to another session, or call an API. The request phase does not run Claude: it returns a proposed canonical `/cc-review ...` command and an opaque request ID for consent.

Reply in a later user message with exactly `ya`, `yes`, `lanjut`, or `approve`. Assistant/tool entries do not approve; same-turn execute is rejected, and more than one newer user-role message makes the request stale. After exact approval, execute invokes the existing review workflow through the shared gated runner and returns the actual external report in tool content; it does not synthesize a slash-command user message. TUI approved execution shows the same progress panel as direct `/cc-review`. Non-raw results remain available to Pi for reconciliation; raw results set tool termination to avoid an automatic Pi follow-up. Direct `/cc-review ...` commands bypass this gate and remain unchanged. Approval is in-memory, session-bound, single-use, and invalidated by `/reload`, session switch, fork, clone, process restart, or extension reload; request a new review after any of those operations.

The public proposal uses only `mode`, `file`, `base`, `focus`, `deep`, and `raw`; target metadata is derived internally. A Pi file mention may have exactly one leading `@`; pass the `file` value without that marker (for example, `@PVT_Calculator_Kunci_Jawaban.ipynb` becomes `PVT_Calculator_Kunci_Jawaban.ipynb`). Only `file` gets this normalization; `focus`, `base`, interior `@`, and a second leading `@` are not stripped. Empty/control/both-quote paths and paths outside the workspace remain rejected. File/base/focus values are deterministically quote-safe and reject control characters or values containing both quote kinds. Approval proposals, metadata, and diagnostics are bounded and do not expose raw session/repository content; the final successful review is not truncated by the extension. Pi extension-origin user messages skip command expansion in the installed runtime, so synthetic `/cc-review` messages cannot dispatch this command. `--raw` changes only the existing result's Pi follow-up behavior, not the approval gate or Claude behavior.

All routing tests use fake Pi/session/process objects and no paid/live Claude run is claimed. After installing or editing the extension or skill, run `/reload` (or restart Pi).

Runtime failures emitted by Claude Code as stream-json `result` events are parsed before diagnostics are rendered. Pi shows the bounded, secret-redacted runtime explanation and API status when present instead of reducing JSON-only failures to a bare exit code. Invalid pre-run CLI failures continue to use stderr.

## Model configuration

Current defaults are Fable for the Claude Code coordinator and Sonnet for every native reviewer, both with high effort. The single configuration source is:

```text
~/.pi/agent/extensions/cc-review/src/config.ts
```

```ts
export const COORDINATOR_MODEL = 'fable';
export const REVIEWER_MODEL = 'sonnet';
export const REVIEW_EFFORT = 'high';
```

To change models, replace the aliases with Claude Code models available to your account, for example `fable`, `opus`, `sonnet`, or `haiku`. The coordinator and reviewers may use different aliases. Change `REVIEW_EFFORT` only to an effort level supported by the selected model. Run `/reload` or restart Pi after saving the file.

The `coordinatorModel` and `reviewerModel` result fields describe the configured/requested aliases; they are not runtime proof. Runtime evidence is reported separately through `observedCoordinatorModel`, `observedModels`, `reviewerModels`, `coordinatorModelVerified`, and `reviewerModelVerified`. Every accepted command must expose a coordinator model in the Claude `system/init` stream event and it must match the configured family; missing or mismatched evidence fails closed. Reviewer verification is observational and non-fatal because Claude Code may not expose a reliably attributable model ID for every native subagent. Each required reviewer's model is attributed only through subagent stream events whose `parent_tool_use_id` maps back to that reviewer's own `Agent` tool-use id, and the resulting per-reviewer models are surfaced in `reviewerModels`. A true `reviewerModelVerified` now requires every required reviewer to carry its own parent-attributed matching model; it is no longer satisfiable by coordinator-only or pooled global events, which matters when the reviewer and coordinator share a model family. A false `reviewerModelVerified` value means “not proven by this stream,” not that the reviewer used the wrong model.

## Security boundary

Only the slash-command handler reaches process creation. The real `claude -p` process is a coordinator; reviewer definitions are passed dynamically in `--agents`, and output is accepted only after real `Agent` tool-use events identify every required reviewer. Reviewer model verification is advisory and requires each required reviewer’s Agent-call ID to be parent-attributed to an observed matching subagent model; coordinator-only and extra-agent models do not count. Text claiming delegation is rejected.

The invocation uses `--safe-mode` because it preserves the user’s Claude.ai OAuth authentication while disabling discovered CLAUDE.md content, skills, plugins, hooks, MCP servers, custom commands/agents, workflows, and memory. It additionally uses `--strict-mcp-config`, `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`, max-turn caps (16/24), `dontAsk`, and exactly `Agent,Read,Grep,Glob`. Edit, Write, Bash, NotebookEdit, WebFetch, WebSearch, and MCP names are explicitly disallowed. No bypass-permission mode, shell interpolation, direct Anthropic API, or Pi review subagent exists.

Safe mode can still honor organization-managed policy settings/hooks. This is surfaced as a documented environment caveat; use only in trusted environments and inspect organizational policy before live use.

## Stop-hook delegation enforcement

Because the Fable coordinator's delegation is non-deterministic, each spawned coordinator is also given a Claude Code `Stop` hook through inline `--settings`. When the coordinator tries to stop before every required reviewer has a native `Agent` call, the hook returns `{"decision":"block"}` and instructs it to invoke the missing reviewers, wait for their results, then produce the review. This is in-run correction: it blocks at most twice per run and then gives up, and it fails open on any hook-side error (unparseable payload, unreadable transcript, corrupt state). The post-run validator remains the fail-closed backstop, so a run that still lacks a required reviewer is rejected with `[REQUIRED_AGENTS_MISSING]` and injects nothing.

The hook is an explicitly injected `--settings` hook, not a discovered one, so `--safe-mode` — which disables *discovered* CLAUDE.md/user/project hooks — leaves it active. If a future CLI change ever runs the coordinator with injected hooks disabled, enforcement degrades to the previous fail-closed-only flow with no other behavior change.

Under `--keep-bundle` the bundle additionally retains `stop-hook-state.json` (the hook's `fired`/`blocks` counters) and `stream.ndjson` (the raw coordinator stream), and the completed review's metadata reports `stopHookFired` and `stopHookBlocks`.

Bundles contain bounded active-branch user/assistant context plus bounded Git diffs or bounded folder snapshots, label folder/repository text untrusted, use private temporary files, and are deleted in `finally` unless retained. Snapshot limits can truncate large folders/files and therefore never imply exhaustive coverage. Files request mode 0600 where Node enforces it; on Windows confidentiality relies primarily on the per-user temporary-directory ACL. Repo-mode Claude runs with the snapshot bundle as its process cwd, so its read tools cannot reach the original folder or excluded files. Returned reviews are explicitly wrapped as external untrusted data for Pi to evaluate critically.

## Validation

```bash
cd ~/.pi/agent/extensions/cc-review
npm test
npm run check
```

Tests use only Node, temporary Git fixtures, fake Pi/session objects, and fake executables; they consume no Claude credits. The current automated suite covers gated skill routing and anti-intercom rules, strict schema/manual validation, canonical quote/parser round trips, session-bound exact approval state, replay/expiry/concurrency/execution-failure handling, one-tool registration, shared-runner approved execution with fake TUI progress and returned external review, direct-command behavior, help short-circuiting, injected fake success/raw/follow-up injection, lock release, missing native Agent rejection, cleanup/retention, full result metadata, parser/path containment, exact safe argv, incremental NDJSON equivalence, disk-backed stdout beyond 1 MB, byte-identical retained streams, stream-write failure cleanup, JSON-only runtime diagnostics, complete final-review delivery from a bounded in-memory tail, temporary Git evidence (including staged/unstaged/untracked/base/invalid-base/truncation), process timeout/spawn/output-cap behavior, and hard byte-bounded bundles. The Windows symlink integration test is skipped when Windows symlink privilege is unavailable; a deterministic mocked-realpath containment test always runs.

`npm run check` runs the strict production TypeScript check (`tsc --noEmit`). The extension requires Node.js >=22.6.0. TypeScript and Node declarations are development-only tooling; no runtime package dependency is added.

Non-credit Pi RPC validation was also performed: Pi discovered `cc-review` as a user extension, and `/cc-review --help` returned this command's usage without a Claude invocation.

## Live evidence and manual acceptance

Bounded raw live reviews completed successfully through the installed Pi command in all three effective modes:

- **code:** native `correctness-reviewer` and `test-reviewer` Agent events validated;
- **plan:** native `requirements-critic` and `architecture-critic` Agent events validated after system-level coordinator delegation hardening;
- **spec:** native `requirements-critic` and `implementation-feasibility-reviewer` Agent events validated.

These recorded live runs used Claude Code 2.1.212 with the previous defaults: Opus coordinating Sonnet reviewers. On 2026-07-19 the current Fable-coordinator/Sonnet-reviewer defaults were additionally proven by a paid live `code --raw` run on Claude Code 2.1.215, driven through the real command handler with only the Pi API surface mocked (`exec` shelled out to the real `claude`; `sendMessage` captured the payload; real process, bundle, Git, and cleanup). The Fable coordinator was verified from the `system/init` event (`observedCoordinatorModel: claude-fable-5`, `coordinatorModelVerified: true`) and delegated to both required native reviewers (`invokedAgents: correctness-reviewer, test-reviewer`, `validDelegation: true`), whose reconciled review flagged the seeded off-by-one defect. `reviewerModelVerified` came back **false** as an observational limitation: the stream exposed only `claude-fable-5` and attributed that model to the parent-linked subagent events, so the Sonnet reviewer model was not proven by this stream (consistent with the non-fatal reviewer-verification design above, and not evidence the reviewers ran on the wrong model). Coordinator delegation proved non-deterministic: an earlier live attempt in which the coordinator emitted no native Agent calls was correctly rejected with `[REQUIRED_AGENTS_MISSING]` and injected no result, confirming the fail-closed path. Both live attempts left `git status --short` byte-identical and removed the `pi-cc-review-*` bundle. Raw mode emitted no Pi assistant/model turn. Disposable repository/artifact hashes and Git status remained byte-identical despite adversarial evidence text, and the completed plan/spec handlers removed their bundles before the RPC responses returned. Claude also invoked an additional native `general-purpose` agent during plan/spec coordination; the CLI tool boundary remained read-only and no mutation or escalation was observed. No mode was accepted from textual delegation alone.

Manual acceptance procedure:

1. Record `git status --short` before and after.
2. Start Pi and issue ordinary prompts plus `/cc-review --help`; confirm no Claude process.
3. Run `/cc-review code --raw` in a disposable dirty repository; confirm one coordinator process, Agent events for `correctness-reviewer` and `test-reviewer`, unchanged Git status, and deleted bundle.
4. Confirm timeout releases the command lock; test adversarial repository text produces no tool escalation.
5. Confirm any organization-managed policy behavior is understood before use: safe mode disables discovered customizations but managed policies/hooks can still apply.
6. For an RPC harness, treat a post-prompt `extension_ui_request` notification whose message begins with an error category such as `[PROCESS_FAILED]` as terminal. Terminate the harness promptly after recording that bounded notification; raw mode does not necessarily emit an `agent_settled` event.

Example manual rerun (invokes Claude Code and may consume account usage):

```text
/cc-review code --raw --focus "Verify native-agent delegation and read-only behavior"
```

## Rollback

Remove or rename `~/.pi/agent/extensions/cc-review/`, run `/reload` or restart Pi, and remove any retained `pi-cc-review-*` temporary directories. The extension changes no provider, Pi, Claude authentication, or repository configuration.

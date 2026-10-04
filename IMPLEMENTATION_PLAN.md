# Shurik implementation plan

Build a Ralph loop that initially works on Shurik itself. Keep the agent runner separate from GitHub orchestration and repository configuration so it can later serve other repositories. The central acceptance criterion is that a broken runner leaves enough evidence and a functioning execution path for a subsequent agent iteration to repair it.

This document records the agreed design. Implementation now lives in `src/`, `scripts/`, and `.github/workflows/`; actual verification and remaining limits are recorded in [VERIFICATION.md](VERIFICATION.md). Read the [public repository caveats](README.md#caveats) before running it. Small Node modules separate policy, GitHub/control state, native runtime processes, and the stable supervisor; checkpoint/provider logic lives in the worker. The prototype runs directly on the Actions runner; future extraction into reusable actions can revisit isolation if operational failures justify it.

## Agreed behavior

| Area | Decision |
| --- | --- |
| Agent foundation | Pi Durable |
| Model access | OpenCode Go with an API key |
| Context | Fresh context for every iteration |
| Past sessions | Every iteration can search and read previous session history |
| Persistence | JSONL history, progress, and metadata committed on the working branch |
| Publication | One working branch and draft PR per loop; merging remains manual |
| Execution | One agent iteration per Actions run |
| Agent failure | Preserve partial work and state, mark the failure, and start another iteration |
| Task policy | The user controls the prompt; the outer loop supplies no backlog or task completion detector |
| Stopping | Optional user deadline; otherwise manual cancellation |
| Iteration duration | Default maximum of 30 minutes for the agent, configurable within the job budget |
| Runner updates | Adopt changes after validation, retaining a working fallback |
| Workflow edits | Disallowed during autonomous execution |
| GitHub authentication | Built-in GITHUB_TOKEN; no personal token or GitHub App for v1 |

The selected model is a launch parameter rather than a hardcoded choice. The user also supplies the actual task in PROMPT.md.

## Proposed repository layout

```text
PROMPT.md                         User-owned task prompt
README.md                         Setup and operating instructions
IMPLEMENTATION_PLAN.md            This plan
mise.toml                         Pinned development runtime
package.json                      Build, check, test, and local iteration commands
package-lock.json                 Exact dependency resolution
tsconfig.json                     TypeScript configuration
scripts/supervisor.mjs             Small supervisor using Node built-ins
src/worker.ts                     Pi Durable agent runner
src/history.ts                    Session listing, search, and transcript tools
src/config.ts                     Validated launch and repository configuration
src/checkpoint.ts                 Worker checkpoint and shutdown protocol
src/validation.ts                 Runner candidate validation
src/provider.ts                   OpenCode Go configuration
tests/                            Integration and failure recovery tests
.github/workflows/ralph.yml        Launch and execute one iteration
.github/workflows/recover.yml      Reconcile failed or interrupted runs
.github/workflows/control.yml      Durable stop and explicit resume commands
.github/workflows/ci.yml           Bootstrap and runner validation
.shurik/config.json               Repository settings and defaults
.shurik/state/<loop-id>/           Tracked history, diagnostics, and loop metadata
```

Use TypeScript for the agent code and an independently executable supervisor. Target Node 24, which meets Pi Durable's documented minimum of Node 22.19.0. Resolve and pin a compatible released set of pi-durable, pi-ai, and chord during the first implementation spike; commit the lockfile and use npm ci. [Package requirements](https://github.com/earendil-works/pi/blob/main/packages/durable/package.json)

## Supervisor and worker boundary

The supervisor owns Git commits, draft PR updates, cancellation checks, runner selection, and successor dispatch. It must not import the candidate runner or depend on its package installation to perform cleanup. Execute its known-working version from a separate checkout, outside the agent's editable workspace.

The worker owns model requests, coding tools, and Pi Durable history. Run it as a Node child process with the job environment, including the OpenCode key and repository-scoped GitHub token. Use process signals for checkpoint pauses and timeout/cancellation cleanup; no Docker mounts, resource caps, credential broker or extra jobs. The supervisor drops local workflow edits before publication so GitHub's workflow-editing restriction does not reject progress pushes. Record attempted edits as diagnostics while still saving code and session state. Internal state remains ordinary writable files; avoid speculative protection in this prototype.

Keep the workflow and active supervisor stable during a loop. Worker, tool, history, and configuration implementation changes can be promoted automatically. Supervisor source improvements may be proposed in the PR but become active through a reviewed bootstrap update. This small recovery boundary keeps a failed worker update from removing its own recovery path.

Separate outside-contributor CI from credentialed loop execution. Fork pull request checks get no OpenCode secret and no write token. Authorize loop starts through maintainer-controlled dispatch, and validate source provenance before adopting code or dependencies supplied by contributors; passing tests is not an authorization to run unreviewed changes with credentials. Privileged recovery must accept only the expected first-party loop workflow, repository, branch, run identifier, and generation, and must ignore fork PR artifacts and outputs. This policy does not by itself keep the key hidden from a self-modified worker that receives it; stronger isolation would require a trusted credential broker outside that worker.

Preserve a tested fallback worker bundle independently of candidate dependencies. The implementation spike must prove that the bundle starts in a clean environment without the candidate's node_modules. Track its immutable source revision, bundle digest, dependency versions, and state compatibility. If self-contained bundling proves unsuitable, resolve the packaging strategy before implementing promotion.

## Iteration lifecycle

1. Read the latest loop metadata and verify that this workflow run owns the expected iteration. Reject duplicate or stale invocations.
2. Check cancellation and the absolute deadline. Carry the same deadline through all successor runs.
3. Check out the working branch and the selected runner separately. Commit an iteration-start record before invoking the agent.
4. Open the persisted history. Mark unfinished work from a previous iteration as interrupted; do not blindly resume its pending tool calls. Reset the model context and submit the current user prompt with a stable iteration request identifier.
5. Make coding tools and history tools available. Include the most recent failure report and a small history index as feedback; retrieve older transcripts on demand.
6. Run until the agent yields, fails, or reaches its time budget. A normal yield ends this iteration and does not mean the outer loop is finished.
7. Stop the worker, flush its journal, and record the outcome. Capture exit status, error details, tool diagnostics, elapsed time, and available usage totals. Preserve partial changes after failure.
8. Commit permitted source changes, progress, history, and metadata. Validate a changed runner candidate against that immutable revision.
9. Promote a passing candidate for the next iteration or retain the working fallback. Commit the validation result and update the existing draft PR.
10. Recheck the authoritative stop state and deadline, then dispatch exactly one successor. This step runs after agent failure as well as success.

Use a separate cleanup budget after the 30-minute agent limit. Proposed defaults are a 60-minute job budget, bounded candidate validation, and a final cleanup reserve. Clip the agent budget to the remaining deadline. Long quota cooldowns should be persisted as a next eligible start time and handed to recovery rather than consuming a sleeping runner indefinitely.

Use workflow_dispatch for successors. GitHub documents that these dispatches can create new runs even when authenticated with GITHUB_TOKEN. Configure contents, pull request, and Actions permissions for the supervisor and verify the repository setting that permits Actions to create PRs. [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token)

## State and past session access

Keep state directly in the working branch:

```text
.shurik/state/<loop-id>/
  loop.json                       Deadline, branch, PR, generation, stop status
  runtime.json                    Selected runner, fallback, and validation records
  history-index.json              Iteration summaries and transcript boundaries
  pi-jsonl/                       Native Pi Durable journal directory
  iterations/<iteration-id>.json  Outcome, source revision, runner revision, diagnostics
  diagnostics/                    Error output and candidate check reports
  diagnostics/recovery/           Imported immutable Actions failure reports
  runtimes/                       Tested fallback bundles and their manifests
```

Pi Durable provides directory-based JSONL storage, retained history after reset, and a persisted provider session identity. Use its native journal format rather than inventing a substitute transcript format. Its storage has one process owner, so recovery and validation must operate on copies while a worker is active. [Persistence and storage](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)

Implement list_sessions, search_sessions, and read_session tools. Search all relevant retained iterations, with pagination, bounded excerpts, and stable identifiers. Read transcript ranges on demand. Do not copy the entire history into every fresh prompt. The upstream history example demonstrates the basic retrieval approach; Shurik adds indexing and bounded access. [History example](https://earendil.com/posts/pi-durable/#compaction)

Treat supervisor metadata as authoritative and verify it independently of worker output. Preserve old committed history and validate journal integrity before accepting an updated snapshot. Retain malformed files for diagnosis and use the last readable checkpoint if needed. Provide explicit state format versions and preserve rollback-compatible snapshots when adopting a migration.

The repository is intended to be public. Committed sessions and diagnostics must contain only material suitable for public disclosure. Keep credentials out of prompts and journals, implement publication checks and redaction, and test that secrets cannot enter committed snapshots. These checks reduce accidental exposure; they do not make private task content suitable for publication or guarantee detection of every secret.

Publish the native session reset boundary before the first provider request. Periodic checkpoints should be serialized at worker tool-round boundaries, with the worker paused while source, journal, transcript boundaries, history index, and available output are snapshotted together. Use the configurable checkpoint interval. Abrupt host loss can still lose work since the latest published checkpoint; local durability cannot preserve an unpublished disk after the runner disappears.

## Runner updates and correction

Validate candidates in a separate workspace using a copy of real persisted state. A candidate must install, compile, pass fixed integration checks, open existing history, start fresh context, invoke coding and history tools, and shut down with a readable journal.

Run a short canary before promotion. Use a disposable target and copied history, keeping it out of the live task. Candidate checks run on the runner with the job environment. The candidate check specification comes from the stable supervisor revision, so a candidate cannot weaken its promotion criteria merely by changing package scripts or tests. This is a correctness check, not credential isolation.

A successful canary makes a candidate eligible. Retain the previous working bundle through a probation iteration on the real task. Classify runner faults separately from model, task, or provider failures: a compile/import error or broken tool protocol triggers fallback; a model request failure alone does not prove the runner architecture is broken.

If an eligible candidate fails structurally in the real iteration, quarantine it and select the retained worker. The fallback still operates on the latest working source, including the broken candidate, and sees the failure report. A later agent can therefore repair the defect rather than repeatedly booting the same unusable code. Candidate validation failure does not discard its source changes or end the Ralph loop.

The acceptance promise is a functioning opportunity to repair, not a guarantee that the model can fix every defect.

## Recovery and stopping

Implement recover.yml as a stable reconciler awakened by a completed iteration and a periodic watchdog. It reads both Git state and Actions run status, detects a missing successor or interrupted owner, records the interruption, and dispatches the expected next iteration. Use workflow_run only to wake recovery; use workflow_dispatch for continued iterations rather than an unbounded workflow_run chain. GitHub limits workflow_run chaining depth. [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)

Before advancing, append a per-run/attempt failure report to the control branch and atomically index it in control.json. Include run conclusion and link, job/step results, bounded redacted job-log excerpts, and explicit capture/truncation status. Retain reports after stop and across later failures. A successor copies the trail into diagnostics, receives recent summaries in its prompt, and preserves interrupted-session bounds from the checkpoint so history tools can retrieve the saved transcript. Repeated events are idempotent; racing stop/resume commands retain authority. A failed reconciliation for one loop must not prevent recovery attempts for other loops.

Prevent duplicates with concurrency controls, iteration identifiers, and branch revision checks. Concurrency alone is not a durable queue or an exactly-once guarantee. Never force-push to resolve a conflict. A retry must re-read the current state and preserve stop requests.

The stop command first records a durable stopped status, then cancels active and queued runs belonging to the loop. Recovery must never restart a stopped loop. Cancellation from the Actions UI must also be recognized as a stop, including races where a successor was already dispatched. Explicit resume clears the stop condition through a new generation and validates any new deadline.

Ordinary worker failures should reach cleanup. Hard cancellation or host loss may prevent cleanup entirely, so recovery starts from the last published checkpoint and available Actions diagnostics. If a Git push fails, retain an emergency snapshot artifact when possible; Git remains the canonical persistence medium. Reconcile that snapshot before advancing, and expose infrastructure failures that cannot be repaired by an agent as operational status.

Do not place unconditional redispatch in an always() step: GitHub documents that always() also evaluates true on cancellation. Separate state-saving cleanup from the stop-aware continuation decision. [Status expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#always)

## Required validation

Use real temporary Git repositories, the actual Pi Durable JSONL backend, and a scripted model provider for repeatable integration tests. Tests must exercise observable recovery behavior, including:

| Injected condition | Required result |
| --- | --- |
| Normal agent yield | Commit state and launch one fresh iteration |
| Agent error or timeout after editing a file | Preserve partial work and diagnostics; next iteration can inspect both |
| Missing dependencies or invalid runner imports | Stable supervisor still saves failure; fallback starts |
| Candidate passes checks but fails in the real task | Quarantine candidate; fallback receives the failure and broken source |
| Interrupted or malformed journal | Recover a readable checkpoint; retain damaged data for inspection |
| Fresh context | Prior context is absent; older sessions remain discoverable through tools |
| Runner update against existing sessions | History remains readable and rollback remains possible |
| Duplicate dispatch or push conflict | One owner advances; no overwritten state or duplicate agents |
| Deadline or manual stop during finalization | Save what is available; no successor survives the stop |
| Attempted workflow modification | Block publication of the workflow change while retaining permitted state |
| Fork PR or unreviewed contributor artifacts reach recovery | Ignore the untrusted inputs; no privileged execution or secret access |
| Push or dispatch failure and abrupt runner loss | Reconciler resumes from durable evidence without resurrecting a stopped loop |

The main recovery demonstration deliberately breaks a runner, observes its failure, launches the retained runner against the broken source, performs a repair through actual coding tools, validates it, and adopts it. Run this offline with a scripted provider, then demonstrate it with a real OpenCode Go model on a disposable branch.

For the live provider check, verify the requested model, tool calling, client identification, and the stable x-opencode-session header. Use Pi's native opencode-go provider with OPENCODE_API_KEY. Do not silently substitute a different model on a quota failure. [Provider implementation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/opencode-go.ts), [OpenCode Go client requirements](https://opencode.ai/docs/go/#where-can-i-use-it)

## Implementation sequence

1. Bootstrap the Node and TypeScript project. Prove the pinned Pi packages, OpenCode provider, JSONL reset/history behavior, and standalone fallback packaging in a small local spike.
2. Implement one local iteration, history tools, supervisor protocol, checkpointing, and failure records. Make it runnable without GitHub so integration tests can exercise the real code.
3. Implement candidate validation, copied-state canaries, promotion, probation, and fallback. Complete the deliberate broken-runner repair test before adding long-running automation.
4. Add the fixed Actions workflows, working branch and draft PR setup, successor dispatch, recovery reconciliation, stop, resume, and workflow edit enforcement.
5. Configure OPENCODE_API_KEY, the requested model, Actions permissions, and a publication-safe PROMPT.md on the GitHub repository. Verify state publication checks, then prove a short live loop, cancellation, and recovery before a longer deadline-driven run.
6. Document launch and repair procedures. Preserve the orchestration/configuration boundary so a later release can expose the runner through workflow_call or a reusable action without rewriting the agent engine.

Completion of v1 requires demonstrated failure recovery and live continuation behavior. Adding the YAML files alone does not satisfy this plan.

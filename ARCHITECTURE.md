# Shurik architecture

Shurik is a CLI distributed with a reusable GitHub Action. A consumer repository supplies a prompt, optional configuration, and one workflow referencing `igor-makarov/shurik@v1`. The action invokes the CLI; the CLI supervises a Pi Durable worker and publishes task changes and sessions back to the consumer repository.

## Components

```mermaid
flowchart LR
  Y[Consumer workflow] --> A[Shurik action at v1]
  A --> C[Shurik CLI]
  C --> S[GitHub supervisor]
  S --> W[CLI worker subcommand]
  W --> P[Pi Durable harness]
  P --> M[Pi AI provider and model]
  M --> V[Model provider API]
  P --> T[Consumer task checkout]
  P --> J[Native journal]
  S --> G[Atomic task and control branch checkpoint]
  J --> G
  T --> G
  G --> R[Next workflow dispatch or recovery]
  R --> Y
```

| Component | Implementation | Role |
| --- | --- | --- |
| Public action | `action.yml`, `action/run.ts` | Set up Node, resolve the current action release, invoke CLI with consumer inputs |
| CLI | `bin/shurik.ts` | Parse commands/flags, route lifecycle operations, run or inspect native workers, print session paths |
| Supervisor | `scripts/supervisor.ts` | Authorize starts/control, fence owners, enforce budgets/stops, publish PRs and dispatch successors |
| Git/control store | `scripts/github.ts`, `scripts/state.ts` | GitHub API, compare-and-swap control updates, atomic two-branch checkpoints, state hydration |
| Runtime | `scripts/runtime.ts` | Build engine separately, launch worker process group, handle cooperative checkpoints and shutdown |
| Pi Durable worker | `src/worker.ts`, `src/cli.ts` | Native JSONL storage, fresh context, model requests, coding/history tools; `src/cli.ts` is the private bundle entry |
| Model access | Pi AI `Models` collection and provider adapters | Model catalogs, provider protocols, authentication, thinking-level capabilities |
| History and checkpoints | `src/history.ts`, `src/checkpoint.ts` | Bounded prior-session retrieval, serialized journal snapshots, continuation instructions |
| Failure recovery | `scripts/failures.ts`, `scripts/policy.ts` | Immutable diagnostics, trusted run identity, cancellation and generation fencing |
| Consumer contract | `scripts/config.ts`, `scripts/paths.ts` | Action configuration and canonical persisted layout version 1 |

All authored code is TypeScript: the CLI, action entry point, supervisor, worker, tests, test helpers, and native runner proof. Node 24 executes the CLI and orchestration through built-in type stripping; `tsc --noEmit` checks production modules and every test/helper. The CLI supervisor uses Node built-ins. It does not import Pi Durable or consumer code into the supervisor process. Pi Durable and its pinned dependencies are bundled into `dist/worker.cjs`, run as a child through `shurik worker --request FILE`. A broken worker import therefore leaves the supervisor able to preserve diagnostics.

## Model providers

[Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#quick-start) receives a Pi AI `Models` collection when its harness opens. The host registers provider adapters and configures a conversation with `{ provider, modelId }` plus a thinking level. Pi AI routes requests through the selected adapter, which supplies its catalog, wire protocol, and authentication. Provider choice is independent of durable storage, history tools, Git checkpoints, and GitHub dispatch/recovery.

[Pi AI's provider layer](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#providers-and-models) supports individual provider factories or a collection of all built-in providers. Its [authentication layer](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#auth) resolves provider credentials from supported environment variables, credential stores, OAuth, or ambient cloud configuration. Custom compatible endpoints require a registered custom provider with its own model metadata and authentication.

The worker uses Pi AI's `builtinModels()` collection. `provider` and `model` pass from action/CLI inputs into authoritative `control.json`, task-facing loop metadata, iteration diagnostics, and worker requests. Conversations receive that pair and an explicit supported reasoning level. Resume retains the saved pair or atomically changes it with the new generation; a provider change requires an explicit model. Missing provider fields in older version-1 controls and worker requests mean `opencode-go`, preserving same-major compatibility. Journal inspection does not resolve a provider or require authentication.

The iteration action inherits native provider environment variables and cloud configuration. Pi AI resolves authentication; Shurik supplies no per-request API-key override, interactive login flow, or persistent credential store. The existing `opencode-api-key` input remains an optional environment alias. Credentials never become action configuration, worker-request JSON, or saved control fields. Publication redaction includes provider key/token variables and cloud credentials present in the environment. Model catalogs are those shipped with the pinned Pi AI package; additional custom endpoints need an adapter integration.

## Release and repository boundaries

Each invocation uses the current release under the workflow's major action reference (`@v1`, later `@v2`). A loop has no frozen engine revision: compatible updates can arrive between iterations. Record the actual engine commit in iteration diagnostics so failures can be traced. The release contract requires same-major compatibility for action inputs, dispatch fields, configuration, and native journal/session state.

The action fetches engine source into a temporary checkout outside the task checkout. Builds use the engine's package lock. Consumer code is cloned separately from the consumer's source/work branch. At initialization, workflow definitions come from the default branch even when `source_ref` selects older task source, because the Actions token cannot introduce other workflow versions on new branches. Consumer repositories do not need Shurik source, a package.json, or any Shurik dependencies. Model, prompt, checkpoint interval, and ignored task snapshot selections come from the consumer, not the engine checkout.

Start receives configuration through named action inputs and saves the effective settings in `control.json`. Iteration and recovery invocations read that record; continuation dispatches only need the loop identity and fence. No project config file is written. Optional `.shurik/config.json` support remains as a legacy start fallback.

Both work and control branches are created in the consumer repository. The action repository receives no task code or journals. `GITHUB_WORKSPACE` is the initial consumer checkout; coding tools start in the separate task clone. Temporary engine/build directories have no persistence role.

Legacy self-hosted loops used immutable supervisor source references and validated candidate/fallback runner revisions. The existing helpers and runner proof retain that behavior. New reusable loops use the current release and do not promote consumer source into the engine. Legacy state is not silently migrated.

## CLI and workflow contract

The public commands are `start`, `iterate`, `stop`, `resume`, `recover`, `worker`, `inspect`, and `paths`. The action exposes the first five. Its optional JSON `inputs` adapter passes dispatch fields without shell interpolation; individual action inputs and CLI flags can override them.

[`shurik.yml`](examples/consumer/.github/workflows/shurik.yml) is the only consumer workflow:

- `control` handles `start`, `stop`, and `resume`, with its own concurrency group so stops do not wait for a worker.
- `iteration` handles the internal `iterate` dispatch and runs the Pi Durable worker with the model secret.
- `recovery` depends on both jobs and uses `always()`. On iteration completion it verifies the first-party default-branch workflow identity and GitHub's completed `iteration` job, using that job's result while the overall run is still in progress. It preserves failure evidence and reconciles a stranded owner or a failure before claim. A 15-minute schedule in the same workflow recovers when the entire workflow was interrupted.

Recovery identifies the workflow name `Shurik`, job name `iteration`, and iteration run title `Shurik <loop-id> / <n>`. Control run titles are `Shurik <loop-id> / start|stop|resume`, and scheduled runs are `Shurik recovery`. Dispatches request GitHub's `return_run_details` response and append `{ runId, generation, iteration }` to `control.json.dispatchedRuns`. Recovery resolves the internal generation through that exact run ID, or current claimed ownership if the run starts before its dispatch receipt is saved. It never infers a generation from a continuous iteration number alone. Earlier `Shurik <loop-id> / iterate <n>` titles also resolve through their saved run IDs. Already queued runs with legacy `Shurik`/`Ralph` generation-number titles remain readable, as do legacy `Shurik Ralph` workflow names. The dispatch filename is recorded in control; the default is `shurik.yml`.

The built-in GitHub token has contents/PR/Actions write permissions for the consumer worker job. Start and control check the dispatch actor's repository write permission. Secrets stay in Actions inputs/environment and do not enter command-line arguments. Fork contributor CI remains read-only and receives no model key.

`create-pr` is an optional action/CLI setting; the workflow adapter calls it `create_pr`. The default `auto` attempts a draft PR when task changes exist. Successful creation records `createPr: true`; GitHub's specific repository-setting denial records `createPr: false` and continues. Explicit `false` skips PR API calls, while `true` enables an attempt. Other API errors retain the normal failure/recovery behavior. The durable control field is carried across iterations and can be changed on resume; `auto` retries permission discovery after repository settings change. Permission discovery uses the normal PR request and does not require an administration token.

## Iteration lifecycle

1. `start` checks authorization, reasoning, provider/model configuration, budget, deadline, consumer source, and prompt. It initializes `codex/shurik/<id>` and `codex/shurik-control/<id>` with a paired checkpoint, then dispatches iteration 1.
2. `iterate` reads authoritative control and claims the expected generation/iteration. Stale, duplicate, stopped, or expired invocations do not start an agent.
3. Clone the consumer work branch and hydrate canonical session state from its control branch. Import failure evidence and mark unfinished sessions as interrupted. Save an iteration-start record.
4. Build the current engine separately. Run the worker with the saved provider/model pair, consumer working directory, journal path, bounded budget, explicit reasoning, prompt, and history index.
5. Pi Durable aborts pending historical work and resets to a fresh model context. Publish the native session boundary before the first model request. History tools retrieve older transcript ranges on demand.
6. At completed tool-round boundaries, the Pi hook serializes a journal copy and waits for the supervisor to publish source, journal, session boundaries, index, and available output together. No process freeze is used for checkpoints.
7. At yield, failure, or timeout, abort the worker and preserve partial code and diagnostics. Inspect journals on disposable copies; retain malformed data and restore the last readable snapshot if necessary.
8. Publish the final paired checkpoint, create/update a draft PR when repository settings allow it (otherwise retain the task branch), release ownership, and re-read stop/deadline/generation state before dispatching a successor.

Iteration numbers are continuous across generations: after iteration 5, a stop/resume starts iteration 6. Resume advances past any claimed interrupted owner; an unclaimed queued successor keeps its number. Reconciliation of a stopped/cancelled owner also advances the counter before clearing ownership, so recovery and resume cannot reuse an iteration that started. The internal generation changes on resume and remains in dispatch inputs, ownership fences, and persisted session IDs (`<generation>-<n>`), but is absent from run titles. Saved run IDs distinguish old and current queued runs that share a title.

A model final response ends an iteration, not the outer loop. A stop or deadline is authoritative. Ordinary progress feedback encourages continuing useful work; clock/countdown/handoff instructions appear only within the last checkpoint interval before preemption.

## Canonical persistence contract

`PATHS` and `runtimeState()` in [scripts/paths.ts](scripts/paths.ts) are the shared declaration of layout version 1. `shurik paths --repository OWNER/REPO --loop-id ID --workspace DIR` exposes the resolved mapping.

```text
Runtime under $HOME/.shurik/                Consumer control branch
                                           codex/shurik-control/<id>
state/<owner>/<repo>/<id>/                  state/
  pi-jsonl/                                  pi-jsonl/
  history-index.json                         history-index.json
  loop.json                                  loop.json
  runtime.json                               runtime.json
  iterations/<generation>-<n>.json            iterations/<generation>-<n>.json
  task-files/                                task-files/
  task-files.json                            task-files.json
logs/<owner>/<repo>/<id>/                   state/diagnostics/
  recovery/<run>-<attempt>.json               recovery/<run>-<attempt>.json
emergency/<owner>/<repo>/<id>/<run>-<attempt>/  (Actions artifact only)
  workspace/, state/, logs/
                                           control.json (control and configuration)
                                           failures/<run>-<attempt>.json
```

Native `pi-jsonl/` is the complete Pi Durable directory, including its native sidecars; Shurik does not replace it with a custom transcript format. `history-index.json` indexes stable iteration IDs and published transcript bounds. `loop.json` is task-facing identity/progress metadata; scheduling and deadlines belong to authoritative `control.json`. `runtime.json` retains engine diagnostic fields and legacy candidate/fallback metadata.

Checkpoint publication copies the runtime session root to control-branch `state/` and runtime `logs/` to `state/diagnostics/`, optionally replacing the live journal with the independent serialized snapshot. `control.json.checkpoint.workCommit` identifies the paired work commit. Git `push --atomic` publishes both refs; a conflict publishes neither. Control compare-and-swap retries re-read the latest generation/owner and preserve racing stop/resume decisions. The next run restores `state/` to `$HOME/.shurik/state/<owner>/<repo>/<id>/` and moves its `diagnostics/` into `$HOME/.shurik/logs/<owner>/<repo>/<id>/` before launching the worker. The persisted layout remains version 1, so existing journals and diagnostics need no control-branch migration. The runtime root is outside the task checkout and needs no Git exclusion. `SHURIK_HOME` optionally overrides `$HOME/.shurik`. Redaction scans the task checkout, external session root, and logs before publication.

`checkpointPaths` explicitly selects ignored consumer data. Its snapshot is saved under `task-files/`, with the paired commit recorded in `task-files.json`. Restore fills missing files; newer tracked data stays authoritative. Detached background writers need their own coordination because the cooperative hook only stabilizes foreground tool rounds.

Recovery commits immutable reports to `failures/<run-id>-<attempt>.json` and indexes them in `control.json.failureTrail` before advancing an interrupted owner or retrying dispatch. Later workers import them under runtime `logs/<owner>/<repo>/<id>/recovery/`; checkpoints retain that evidence at `state/diagnostics/recovery/`. Reports retain bounded redacted log excerpts and mark missing or truncated diagnostics.

## Operational limits and verification

The worker shares the Actions runner and job credentials. Separate checkouts isolate engine selection from task files operationally; they are not a security sandbox. Sessions follow the consumer repository's visibility. Redaction reduces accidental credential publication, with the limits documented in [README.md](README.md#caveats).

Forced cancellation or host loss can discard unpublished work. `$HOME/.shurik/emergency/<owner>/<repo>/<id>/<run>-<attempt>/` preserves task files, session state, and logs in separate `workspace/`, `state/`, and `logs/` directories. Both control and iteration jobs can upload it through the action's `emergency-path` output after failure. It is an optional failure artifact, never a trusted automatic recovery input. All runtime directories are outside checkouts and require no Git exclusions. Git state is canonical. Recovery can retain available Actions logs but cannot reconstruct an unpublished journal.

`npm run verify` checks types, bundles, native journals, provider configuration, checkpoint races, recovery, and an unrelated consumer with no engine source. `node tests/runner-proof.ts` exercises the retained legacy self-repair path. Release checks must keep earlier same-major journals readable; incompatible migrations belong in a new major version.

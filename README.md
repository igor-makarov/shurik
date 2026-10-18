# Shurik

Shurik runs durable coding-agent loops for your project through a reusable GitHub Action. Its core is a CLI whose subcommands orchestrate [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), Git checkpoints, draft PRs, and recovery.

Pi Durable handles conversations, tools, and persistence; [Pi AI](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#providers-and-models) supplies model providers and authentication. See [Providers and authentication](#providers-and-authentication) for supported providers and setup examples.

```yaml
- uses: igor-makarov/shurik@v2
  with:
    command: start
    loop-id: my-task
    model: '{"provider":"openai","name":"gpt-6-sol","reasoning":"high"}'
```

Use `@v2` for this breaking structured-model and swarm API. The `@v1` release remains available for existing workflows. See [migration from v1](MIGRATION.md). Every invocation uses the current release under that tag; an existing loop can receive engine updates within the same major version. Engine commit IDs in iteration records are diagnostic evidence, not a per-loop version lock.

**Status:** reusable TypeScript CLI and action. The v2 input and swarm paths have native scripted-worker integration coverage; the earlier v1 consumer demo supplies the retained live DeepSeek evidence. The agent runs directly on the Actions runner with its job credentials. See [architecture](ARCHITECTURE.md), [verification evidence](VERIFICATION.md), and the [consumer demo](https://github.com/igor-makarov/shurik-demo).

This repository runs contributor CI only. Shurik loops run in [shurik-demo](https://github.com/igor-makarov/shurik-demo) and production consumer repositories, using the workflow template below.

## Add Shurik to a project

1. Add a public-safe task in `PROMPT.md`. Configure Shurik through action inputs in the workflow; no project configuration directory is required.
2. Copy [shurik.yml](examples/consumer/.github/workflows/shurik.yml) to your repository’s `.github/workflows/` directory. It invokes `igor-makarov/shurik@v2`; you do not copy Shurik’s source or install its dependencies in your project.
3. Add the selected provider's credential as a repository Actions secret and expose it in the iteration action's `env`. Pi AI resolves authentication automatically; see [Providers and authentication](#providers-and-authentication).
4. In **Actions → Shurik → Run workflow**, select the default branch, command `start`, a unique lowercase loop ID, and a JSON model specification. Optionally supply a swarm, source branch, iteration budget, and absolute deadline.
5. Review the task branch, or the draft PR if enabled. Stop with **Shurik → stop**, or resume with saved settings and optional model JSON overrides.

One workflow handles start/stop/resume, iterations, and recovery in separate jobs. No separate recovery file or model secret for control/recovery is needed. Keep the workflow name `Shurik`, job name `iteration`, and its `Shurik <id> / <n>` iteration run-name format: recovery verifies them against GitHub. The default filename is `shurik.yml`; if you rename it, pass the new filename in the control job's `workflow` action input.

The loop ID is the task branch name: `greeting-demo` writes to `greeting-demo`, and `main` writes directly to `main`. Control and sessions live on `shurik-control/<loop-id>`. A new task branch starts from the workflow checkout or `source-ref`; an existing branch starts from its current remote tip. An explicit `source-ref` must match that tip when the task branch already exists. On the repository's default branch, PR creation is always disabled, including when `create-pr: true` is supplied. Repository branch protection rules still apply. The loop ID `shurik-control` is reserved for the control namespace. Use `resume` for a loop that already has control state.

The `create_pr` workflow input defaults to `auto`: create a draft PR when GitHub permits it, or save changes on the task branch and continue when the repository setting denies it. Shurik remembers a denial and does not retry it every iteration. Choose `false` to skip PR creation or `true` to enable it explicitly. The corresponding action input is `create-pr`, and the CLI option is `--create-pr auto|true|false`. Start records the choice; resume can change it. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** for automatic PRs. After enabling it for an existing loop, resume with `auto` or `true` to try again.

The workflow uses repository-scoped `github.token`. Iteration jobs need `contents: write`, `pull-requests: write`, and `actions: write`; the control job also needs PR access, while recovery needs contents and actions write access. Contributor CI should use read-only permissions and no model key.

## Model and swarm inputs

Workflow inputs `model` and `swarm` are JSON strings. Action inputs also accept JSON strings, while `inputs` JSON may contain their native objects. The CLI accepts the same values through `--model` and `--swarm`.

```yaml
# One loop: exact task/control identity research.
model: '{"provider":"openai","name":"gpt-6-sol","reasoning":"high"}'

# Optional: replicate it into research-0 through research-3.
swarm: '{"agents":4}'
```

For per-member settings, use `swarm.models`. An entry overrides fields from the shared model; without a shared model, every entry must be complete:

```json
{
  "agents": 4,
  "models": [{}, {"reasoning":"medium"}, {"reasoning":"low"}, {"reasoning":"high"}]
}
```

`agents` must be a positive safe integer. With `models`, an explicit count must equal the list length; otherwise the count is inferred. Empty lists, unknown fields, missing resolved provider/name/reasoning, unsupported reasoning names, and malformed JSON fail before startup. Changing a provider in an override also requires a name. Listed-model capability checks and actual provider availability remain enforced by the worker's native adapter.

One control job validates all members and common settings, checks for existing control IDs, then initializes and dispatches independent loops sequentially. No workflow matrix or parent worker is needed. Each member's iterations continue independently with their saved settings. Startup reports per-member failures and attempts remaining members; a GitHub failure can leave some loops running. Inspect the reported IDs rather than restarting the same swarm prefix blindly. Scheduled recovery can retry missing dispatches. To restart an initialized stranded member manually, stop and then resume its individual ID; initialize any missing member with its resolved model.

Every member retains `swarm: {"id":"research","index":0,"agents":4}` in its control record and task-facing `loop.json`. Its initial iteration context includes its loop ID, swarm ID, zero-based index, and size. This identity survives stop/resume. There is no inter-agent messaging, shared workspace, automatic integration, or swarm-wide stop/resume command. Use the generated member IDs for stop and resume.

Examples with workflow start parameters:

```sh
gh workflow run shurik.yml -f command=start -f loop_id=research \
  -f model='{"provider":"openai","name":"gpt-6-sol","reasoning":"high"}' \
  -f swarm='{"agents":4}'

gh workflow run shurik.yml -f command=resume -f loop_id=research-1 \
  -f model='{"reasoning":"medium"}'
```

## Loop behavior

Every iteration starts a fresh model context while retaining native journals. The agent can retrieve past work through `list_sessions`, `search_sessions`, and `read_session`. A normal model response ends one iteration; the outer loop continues after success and failure until stopped or its deadline expires. Shurik never merges its draft PR.

The default agent budget is 1,800 seconds. Every new loop requires an explicit model object with `provider`, `name`, and `reasoning` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). There is no model or reasoning default or silent adjustment. Resume with a blank model retains the saved selection; a partial object overrides its fields. Changing provider requires an explicit name. A blank resume deadline clears the previous deadline. Iteration numbers continue across stops and resumes: `1, 2, 3, 4, 5 → stop → resume → 6, 7, 8`. Run titles show only the number, for example `Shurik demo / 6`. An interrupted iteration that claimed ownership consumes its number; an unclaimed queued run does not. Resume changes an internal generation so older queued invocations cannot claim the resumed loop. GitHub run IDs saved in control also keep their cancellation and recovery events separate, even when two queued runs have the same title.

“Budget” refers to execution time: `work-seconds` limits each iteration, and `deadline` bounds the whole loop. These are not monetary spending limits. Model availability depends on the provider; choose an available model in configuration or dispatch inputs.

Set `work-seconds: 1800` and `wait-seconds: 10800` to work for up to 30 minutes, save progress, and wait at least three hours after each iteration finishes. The wait applies after successful and failed iterations, including an interrupted run recovered from GitHub. The job exits during the wait; no runner stays allocated. The existing recovery schedule checks every 15 minutes and starts the next iteration on its first check after the saved due time, subject to GitHub scheduling delays. Workflow summaries show **Waiting until** the saved timestamp. `wait-seconds: 0` keeps immediate continuation.

Manual resume runs immediately and keeps the saved work/wait settings when inputs are blank. It can change either setting, including explicitly setting `wait-seconds: 0`. Resume while waiting changes the generation and preserves iteration numbering; an active iteration still requires stop before resume. Stop disables future work, and an overall deadline also applies during the wait. A failure before an iteration claims ownership retries without imposing another wait. Canonical action, workflow-dispatch, and CLI names are `work-seconds` / `wait-seconds` and `--work-seconds` / `--wait-seconds`. The former `seconds` input/flag remains a deprecated compatibility alias for older `@v1` consumers.

Stop first records durable stopped state, then requests cancellation of the active run. GitHub cancellation is asynchronous; the worker also polls stopped state. Already queued iterations skip work while stopped and remain fenced out after resume.

The recovery job uses `needs` and `always()` to run after iteration success or failure in the same workflow. It verifies the completed iteration job even while the overall workflow is still running. The same file includes a 15-minute scheduled check for interruption of the entire workflow. It saves available Actions failure diagnostics before redispatching. Cancelling the active loop in the Actions UI also becomes a durable stop. GitHub can delay scheduled jobs, and cancellation of an expected queued successor is conservatively treated as a stop.

The action keeps engine code in a separate temporary checkout. The task agent edits a clone of the consumer’s working branch. `GITHUB_WORKSPACE` names the initial consumer checkout; task changes belong in the coding tools’ initial working directory. New reusable loops execute the released engine and never adopt files from the consumer as Shurik implementation. Existing legacy self-hosted loops keep their previous candidate-validation and fallback behavior.

## CLI

Use Node 24. TypeScript runs with Node's built-in type stripping; `npm run check` type-checks all authored code: the CLI, action, orchestration, worker, unit/property tests, and runner proof. All source and test files are `.ts`; `dist/worker.cjs` is generated build output. The repository exposes `bin/shurik.ts` as the `shurik` executable; the action invokes this same CLI. The package is not published to npm.

```sh
npm ci --ignore-scripts
npm run build
node bin/shurik.ts --help
node bin/shurik.ts paths --repository owner/project --loop-id my-task --workspace /path/to/project
```

| Subcommand | Responsibility |
| --- | --- |
| `start` | Initialize one loop or a swarm, save separate control state, and dispatch each first iteration |
| `iterate` | Run one fenced Pi Durable iteration, publish checkpoints, dispatch the successor |
| `stop` | Save a durable stop and cancel the active run |
| `resume` | Resume one saved loop in a new generation with optional model JSON and timing overrides |
| `recover` | Reconcile interrupted runs, retain diagnostics, and restore missing dispatches |
| `worker --request FILE` | Execute a versioned JSON request through the Pi Durable worker |
| `inspect --request FILE` | Open a disposable copy of a native journal without model calls |
| `paths --loop-id ID` | Print canonical runtime and control-branch paths as JSON |

Lifecycle commands expect the GitHub Actions repository, actor, ref, and token context. `--workspace` selects the consumer checkout. Explicit CLI flags override `SHURIK_INPUTS`, the dispatch JSON supplied by the action. `worker` and `inspect` need a built bundle and a version-1 request with `cwd`, `journal`, `output`, model, budget, and session fields; `worker` also requires explicit reasoning and a prompt. `journal` selects the journal root and `journalId` selects `sessions/<journalId>/` within it; omitting `journalId` retains the legacy shared-journal interface. These are internal interfaces for local verification; ordinary consumers use the action.

## Action inputs

| Input | Purpose |
| --- | --- |
| `command` | `start`, `iterate`, `stop`, `resume`, or `recover`; defaults to `start` |
| `loop-id` | Exact loop/task-branch ID, or swarm prefix on start; stop/resume use member IDs; `main` writes directly to `main` for a single loop |
| `inputs` | Optional JSON from `${{ toJSON(inputs) }}`; explicit action inputs override it |
| `model` | JSON object with `provider`, `name`, and `reasoning`; shared base for swarm entries; optional partial overrides on resume |
| `swarm` | Start-only JSON object with `agents` and/or `models`; generates `<loop-id>-0`, `<loop-id>-1`, etc. |
| `create-pr` | `auto` (default), `true`, or `false`; disabled on the default branch; denied repository PR settings become `false` without stopping the loop |
| `work-seconds` | Work budget per iteration, 10–1,800 seconds; defaults to 1,800 at start, retained on resume |
| `wait-seconds` | Idle time after an iteration; nonnegative integer, defaults to 0 at start, retained on resume |
| `deadline` | Optional absolute loop deadline |
| `prompt` | Relative task prompt file; defaults to `PROMPT.md` at start |
| `checkpoint-seconds` | Checkpoint interval, 1–1,800 seconds; 0 disables automatic task commits/pushes and periodic checkpoints; defaults to 300 at start, retained on resume |
| `checkpoint-paths` | JSON array of ignored task paths to retain with sessions; defaults to `[]` |
| `source-ref` | Source for a new task branch; must match an existing branch's current tip; workflow definitions come from the default branch |
| `generation`, `iteration` | Internal continuation fence supplied by Shurik |
| `workflow` | Iteration workflow filename; default `shurik.yml` |
| `token` | Defaults to `${{ github.token }}` |
| `opencode-api-key` | Optional compatibility alias for the `OPENCODE_API_KEY` environment variable |

Outputs are `engine-revision` (the commit used by this invocation), `loop-ids` (a JSON array), `state-path`, `logs-path`, `emergency-path`, and `control-branch`. For a swarm, path and control-branch outputs are newline-separated values, one per member; `emergency-path` can be passed directly to `actions/upload-artifact`. Path outputs are written before the CLI runs, so failure artifact steps can use `emergency-path`. The action sets up Node and builds the engine in its own checkout; it does not run your project’s package scripts to install Shurik.

## Providers and authentication

Pi Durable accepts a Pi AI `Models` collection and identifies a model by its provider ID and model ID. Its [quick start](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#quick-start) registers OpenAI; its [per-conversation agent configuration](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#per-conversation-agent) selects the provider, model, and thinking level. Durable journals and Shurik's GitHub scheduling do not depend on one model vendor.

Shurik uses Pi Durable, Pi AI, and Chord `1.2.0`, with Pi AI's built-in provider adapters. Listed models use their bundled metadata and reasoning restrictions. An unlisted model ID is attempted unchanged using provisional chat metadata from that provider, following Pi agent's custom-ID behavior. OpenCode custom IDs use its OpenAI-compatible endpoint. Native Pi AI authentication and request handling stay in charge; a missing model or unsupported option reported by the provider becomes an ordinary agent failure, retained in the journal and handled by the normal loop/recovery path. Shurik never substitutes another model and makes no catalog network requests.

Unlisted models forward text and image input and use the provider template's context/output limits. Their capabilities and prices are unknown: the worker marks `provisionalModel: true`, and zero cost estimates mean pricing is unavailable. Explicit reasoning is sent through the native adapter; Shurik checks known models' supported levels and lets the provider validate unlisted ones. `opencode-go/step-5-preview-free` is included in Pi AI `1.2.0`, with image input and reasoning levels `low`, `medium`, and `high`; `xhigh` and `max` are rejected for this listed model. See Pi AI's [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#providers-and-models) and [authentication documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#auth).

The native `read` tool reads images from the task checkout or an absolute path and sends them as attachments. PNG, JPEG, GIF, and WebP files pass through unchanged within the model's image limits, normally 2000×2000 pixels and 4.5 MiB of base64 data. Images persist in the native journal and checkpoints. Larger images and BMP files return tool diagnostics; resize or convert them before reading. Shurik uses the released Pi Durable coding tools directly, without a custom reader or image processor. A listed model without image input receives Pi AI's placeholder and a diagnostic; an unlisted model receives the attachment so its provider can validate support. No additional action input or credential is needed.

Set the JSON `model` input in the control action or workflow dispatch, for example `{"provider":"openai","name":"gpt-6-sol","reasoning":"high"}`. Start resolves it to the existing flat `provider`, `model`, and `reasoning` fields in `control.json`. Iterations read that saved selection. Resume without a model retains it; a partial model object changes selected fields. A provider change must include the corresponding `name`. Older controls without a provider retain their recorded v1 interpretation (`opencode-go`) when resumed; new starts never infer a provider or model.

Pi AI reads its native environment variables and ambient cloud credentials automatically. GitHub secrets must be exposed as environment variables in the iteration action; Shurik needs no new credential input. For OpenAI:

```yaml
- uses: igor-makarov/shurik@v2
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  with:
    command: iterate
    inputs: ${{ toJSON(inputs) }}
```

For Anthropic, supply `model: '{"provider":"anthropic","name":"claude-haiku-4-5","reasoning":"high"}'` and expose `ANTHROPIC_API_KEY` instead. Common choices are:

| Provider ID | Native authentication |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| `google` | `GEMINI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `amazon-bedrock` | AWS credentials/profile/role configured on the runner |
| `opencode`, `opencode-go` | `OPENCODE_API_KEY` |

Start, stop, resume, and recovery need the repository token but make no model requests. Keep credentials outside dispatch inputs and saved control/session data. Shurik does not run interactive OAuth login or configure a persistent credential store. Custom providers/endpoints need a worker integration; see Pi AI's [custom-provider documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#custom-providers). The public demo uses `opencode-go` / `deepseek-v4.1-flash` with native environment authentication.

## Loop configuration

Set configuration in the control job's action inputs:

```yaml
- uses: igor-makarov/shurik@v2
  with:
    inputs: ${{ toJSON(inputs) }}
    work-seconds: 1800
    wait-seconds: 0
    checkpoint-seconds: 300
    checkpoint-paths: '["data/posts", "data/cdx"]'
    prompt: PROMPT.md
```

Choose the model specification, optional swarm, and iteration timing with the `model`, `swarm`, `work-seconds`, and `wait-seconds` action or dispatch inputs. Explicit action values override dispatch JSON. Start validates these settings and saves the effective provider/model pair, work/wait settings, prompt path, checkpoint interval, and checkpoint paths in `control.json` on the control branch. Later iterations read that control record; continuation dispatches carry the loop ID and generation/iteration fence. The controller does not write a configuration file into the task checkout. No settings file needs to be passed between Actions runners.

The iteration time limit is 10–1,800 seconds; a positive checkpoint interval is 1–1,800 seconds (0 disables task checkpoints). `prompt` names a relative project file. `checkpoint-paths` selects ignored task data to retain with sessions, for example `["data/posts", "data/cdx"]`. Hidden paths, dependency/build directories, traversal, and symlinks are rejected. The snapshot is paired with its work commit; restoration fills missing files without overwriting newer task records. Select only data suitable for your repository's visibility; use artifact storage for large files.

Version 2 ignores `.shurik/config.json`, including checkpoint selections. Configure loops through workflow/action inputs; resolved settings are retained on the control branch. Built-in operational defaults are 1,800 work seconds, zero wait seconds, 300 checkpoint seconds, `PROMPT.md`, an empty checkpoint-path list, and automatic draft PR creation. There is no built-in model selection.

## Canonical session paths

Set `checkpoint-seconds: 0` for agent-managed task commits. Shurik creates the
initial task branch, then never commits or pushes task changes automatically.
The agent must commit and push its own work. Periodic journal checkpoints and
ignored-task-file snapshots are disabled; session history, diagnostics, and control
state still persist at iteration boundaries. An abrupt interruption can lose the
current iteration's unpushed code and session history. Stop and resume an existing
member with `checkpoint-seconds: 0` to enable this mode. A blank resume setting
retains the saved value; a positive interval re-enables automatic checkpoints.

[scripts/paths.ts](scripts/paths.ts) declares layout version 1. `shurik paths --repository OWNER/REPO --loop-id ID --workspace DIR` prints the resolved mapping. All persisted data belongs to the **consumer repository**, including when Shurik is loaded from another repository.

| Data | Runtime, outside the repository | Control branch `shurik-control/<loop-id>` |
| --- | --- | --- |
| Session root | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/` | `state/` |
| Native Pi Durable session journals | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/pi-jsonl/sessions/<generation>-<iteration>/` | `state/pi-jsonl/sessions/<generation>-<iteration>/` |
| History index | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/history-index.json` | `state/history-index.json` |
| Identity/progress snapshot | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/loop.json` | `state/loop.json` |
| Engine diagnostics | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/runtime.json` | `state/runtime.json` |
| Iteration records | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/iterations/<generation>-<iteration>.json` | `state/iterations/<generation>-<iteration>.json` |
| Worker/recovery diagnostics | `$HOME/.shurik/logs/<owner>/<repo>/<loop-id>/` | `state/diagnostics/` |
| Selected ignored task data | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/task-files/` | `state/task-files/` |
| Task snapshot manifest | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/task-files.json` | `state/task-files.json` |
| Emergency fallback | `$HOME/.shurik/emergency/<owner>/<repo>/<loop-id>/<run-id>-<attempt>/` | Actions artifact only |
| Authoritative loop control and configuration | Supervisor’s private control checkout | `control.json` |
| Immutable Actions failure evidence | Imported under `$HOME/.shurik/logs/<owner>/<repo>/<loop-id>/recovery/` | `failures/<run-id>-<attempt>.json` |

Shurik uses three directories under `$HOME/.shurik`: `state/` for sessions, `logs/` for worker and recovery diagnostics, and `emergency/` for fallback snapshots. They are outside every checkout and need no ignore rules, including no blanket `*.log` rule. Worker output is retained as bounded logs in diagnostic JSON files under `logs/`. Set `SHURIK_HOME` to override `$HOME/.shurik` without changing persisted paths. Repository and loop names isolate sessions. Shurik copies the session directory to control-branch `state/` and the runtime logs to `state/diagnostics/` on every checkpoint. The next run restores them into the separate runtime `state/` and `logs/` directories. The persisted version-1 paths stay compatible with older sessions. The task branch is `<loop-id>`; every checkpoint atomically pushes both branch refs and records the task commit in `control.json.checkpoint.workCommit`. A rejected push publishes neither half, and retries preserve stop/resume decisions. Earlier loops retain their recorded task/control refs and remain readable, resumable, and discoverable by recovery; new loops use the names above.

Each new iteration writes its own native journal directory, including `main.jsonl` and Pi Durable's sidecars. A journal stops growing when its session ends; later iterations create new directories. History-index entries carry a `journalId` and entry bounds, so history tools can retrieve sessions even though entry IDs restart in each journal. Older entries without a `journalId` still read the shared journal directly under `pi-jsonl/`; new iterations leave it in place without appending to it. Retained history still consumes disk space across sessions.

A Pi hook publishes the session boundary before the first model request and publishes later checkpoints at completed tool-round boundaries. It takes a serialized snapshot of the active session's native journal and waits for Git publication before continuing. Publication replaces only that session's journal, preserving older sessions. Malformed active journals are retained for diagnosis and replaced with the last readable checkpoint. Unpublished work can be lost on abrupt runner failure.

Temporary engine/build/worker-I/O directories live under `RUNNER_TEMP` (locally, the OS temporary directory). They are not session storage. After a supervisor failure, `emergency/<owner>/<repo>/<loop-id>/<run-id>-<attempt>/` under `$HOME/.shurik` contains `workspace/`, `state/`, and `logs/` copies. The workflow uploads that path as evidence when possible; it is not an automatic recovery source. Repository metadata, dependencies, and build output are excluded, and known credentials are redacted before copying.

## Development and release

```sh
npm ci --ignore-scripts
npm run verify
node tests/runner-proof.ts
```

Checks cover native journal persistence, fresh contexts, coding/history tools, checkpoint races, failure recovery, model reasoning, and an unrelated consumer repository. The scripted runner proof covers the legacy self-repair path. No real model credentials are needed for these checks.

`npm run test:pbt` runs 60 property-based tests using `fast-check`, also included in `npm test` and CI. Each ordinary property checks 1,000 generated cases; filesystem properties use 50–75 cases, real Git checkpoint properties use eight cases, and native history retrieval uses 20 cases with multiple isolated journals and optional legacy history. Failures shrink to small counterexamples and print a reproducible seed. See the [property inventory and replay instructions](VERIFICATION.md#property-based-tests).

Publish tested releases with immutable version tags such as `v2.0.0`, then advance the corresponding major tag `v2`. Leave existing v1 refs on their v1 code. Changes within a major version must preserve the action inputs, continuation protocol, and session layout, including reading journals written by earlier releases in that major. Breaking changes use a new major tag and documented migration. Consumers choose when to move their workflow from `@v1` to `@v2`; no engine-update control branch or per-loop version lock is required.

## Caveats

**Public history is public data.** Sessions are committed directly into the repository on control branches. In a public repository, prompts, model responses, tool output, source excerpts, and failure reports in those commits will be publicly readable. Actions history and logs also become publicly accessible. Use only material suitable for publication; excluding a file from the current tree does not remove it from earlier commits or copies. [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

**Secrets require separate handling.** Keep credentials in Actions secrets, never in prompts, committed state, or diagnostics. Publication redacts known credentials, common encoded forms, and recognizable token patterns. This is a limited accidental-exposure check, not universal secret detection. GitHub log masking does not sanitize commits. If a credential is exposed, rotate it rather than relying on deleting the visible file. The runner sends task context to the selected model provider.

**Contributor access and execution are different boundaries.** GitHub normally withholds repository secrets from fork pull request workflows. Keep contributor CI secret-free, and reserve credentialed loop execution for trusted, maintainer-authorized code. Do not execute unreviewed fork code or consume its artifacts in privileged recovery workflows. A repository writer or code executed with a secret can expose it, even though the stored value is not displayed in repository settings. Passing tests does not establish trust in a contributor's changes or prevent an automatically updated runner from leaking a key it receives. [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)

**The agent shares the runner and its credentials.** Coding tools and candidate code run directly on the Actions runner, can modify local files and make network requests, and receive the job's repository-scoped GitHub token and model-provider credentials. The worker has no separate filesystem sandbox or resource caps. It can interfere with loop state or use the token outside its working branch. This is an intentional prototype tradeoff; timeouts, publication redaction, fixed candidate checks and fallback copies remain, but they do not provide credential isolation or a security boundary.

**The dependency is experimental.** Pi Durable explicitly warns that its API can change without notice between releases. Compatible package versions must be pinned and state migrations tested before runner updates are adopted. [Pi Durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)

**Persistence and repair have limits.** Local checkpoints can disappear with an ephemeral runner before they are pushed. After the initial session-boundary checkpoint, checkpoints publish at tool-round boundaries after the configured interval, with the Pi hook awaiting publication. The journal copy is serialized against Pi writes; task files are stable between foreground tool rounds. Detached background writers need their own coordinated durable checkpoints and are not frozen by this hook. A model request with no tool boundary cannot publish an intermediate checkpoint. Abrupt host loss or forced Actions cancellation may lose work since the latest push; recovery preserves available Actions diagnostics independently but cannot reconstruct unpublished work. Malformed journals are retained for diagnosis and replaced with the last readable snapshot. Emergency artifacts after a push conflict are evidence for manual recovery, never trusted automatic inputs. Rebuilding a runner also depends on dependency downloads or the npm cache being available; a build failure is recorded and retried by the loop. Tests and fallback preserve an opportunity for repair, not a guarantee of repair or reversal of external side effects. GitHub outages, branch conflicts, or failures in the fixed supervisor itself can still require maintainer intervention. Reusable loops receive the current release from their workflow’s major action tag on each run. Legacy self-hosted loops retain their original supervisor behavior.

**Continued execution consumes resources.** Repeated runs use provider allowances, Actions resources, and storage. An omitted deadline means execution continues until stopped, not that usage is free or unlimited. Provider quotas, GitHub limits, service outages, and applicable usage terms still apply; chaining jobs does not remove those constraints. [Actions limits](https://docs.github.com/en/actions/reference/limits), [GitHub Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions)

**Release scope.** `v2` introduces structured model inputs and swarm startup. Updates within `v2` must preserve that interface and the session layout. Operational guarantees and stronger runner isolation remain future work. License selection is pending; the CLI is packaged in this repository, not published to npm.

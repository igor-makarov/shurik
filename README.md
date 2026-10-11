# Shurik

Shurik runs durable coding-agent loops for your project through a reusable GitHub Action. Its core is a CLI whose subcommands orchestrate [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), Git checkpoints, draft PRs, and recovery.

```yaml
- uses: igor-makarov/shurik@v1
  with:
    command: start
    loop-id: my-task
    reasoning: high
    opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
```

Use a major version such as `@v1` or, for a future breaking release, `@v2`. Every invocation uses the current release under that tag; an existing loop can receive engine updates within the same major version. Engine commit IDs in iteration records are diagnostic evidence, not a per-loop version lock.

**Status:** reusable TypeScript CLI and action, verified in the independent demo with live DeepSeek requests, native Pi Durable journals, and recovery in the same workflow. The agent runs directly on the Actions runner with its job credentials. See [architecture](ARCHITECTURE.md), [verification evidence](VERIFICATION.md), and the [consumer demo](https://github.com/igor-makarov/shurik-demo).

## Add Shurik to a project

1. Add a public-safe task in `PROMPT.md`. Configure Shurik through action inputs in the workflow; no project configuration directory is required.
2. Copy [shurik.yml](examples/consumer/.github/workflows/shurik.yml) to your repository’s `.github/workflows/` directory. It invokes `igor-makarov/shurik@v1`; you do not copy Shurik’s source or install its dependencies in your project.
3. Add the repository Actions secret `OPENCODE_API_KEY`.
4. In **Actions → Shurik → Run workflow**, select the default branch, command `start`, a unique lowercase loop ID, and an explicit model reasoning level. Optionally choose a model, source branch, iteration budget, and absolute deadline.
5. Review the task branch, or the draft PR if enabled. Stop with **Shurik → stop**, or resume with a new explicit reasoning level.

One workflow handles start/stop/resume, iterations, and recovery in separate jobs. No separate recovery file or model secret for control/recovery is needed. Keep the workflow name `Shurik`, job name `iteration`, and its `Shurik <id> / <command> <generation>-<iteration>` run-name format: recovery verifies them against GitHub. The default filename is `shurik.yml`; if you rename it, pass the new filename in the control job's `workflow` action input.

The `create_pr` workflow input defaults to `auto`: create a draft PR when GitHub permits it, or save changes on the task branch and continue when the repository setting denies it. Shurik remembers a denial and does not retry it every iteration. Choose `false` to skip PR creation or `true` to enable it explicitly. The corresponding action input is `create-pr`, and the CLI option is `--create-pr auto|true|false`. Start records the choice; resume can change it. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** for automatic PRs. After enabling it for an existing loop, resume with `auto` or `true` to try again.

The workflow uses repository-scoped `github.token`. Iteration jobs need `contents: write`, `pull-requests: write`, and `actions: write`; the control job also needs PR access, while recovery needs contents and actions write access. Contributor CI should use read-only permissions and no model key.

## Loop behavior

Every iteration starts a fresh model context while retaining native journals. The agent can retrieve past work through `list_sessions`, `search_sessions`, and `read_session`. A normal model response ends one iteration; the outer loop continues after success and failure until stopped or its deadline expires. Shurik never merges its draft PR.

The default agent budget is 1,800 seconds. Start and resume require explicit reasoning (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), supported by the chosen model. There is no reasoning default or silent adjustment. A blank model on resume keeps the previous model; a blank resume deadline clears the previous deadline. Each resume creates a new generation, fencing older queued invocations.

“Budget” refers to execution time: `seconds` limits each iteration, and `deadline` bounds the whole loop. These are not monetary spending limits. Model availability depends on the provider; choose an available model in configuration or dispatch inputs. The demo uses `deepseek-v4.1-flash` because `space-bunny-free` was unavailable during verification.

The recovery job uses `needs` and `always()` to run after iteration success or failure in the same workflow. It verifies the completed iteration job even while the overall workflow is still running. The same file includes a 15-minute scheduled check for interruption of the entire workflow. It saves available Actions failure diagnostics before redispatching. Cancelling the active loop in the Actions UI also becomes a durable stop. GitHub can delay scheduled jobs, and cancellation of an expected queued successor is conservatively treated as a stop.

The action keeps engine code in a separate temporary checkout. The task agent edits a clone of the consumer’s working branch. `GITHUB_WORKSPACE` names the initial consumer checkout; task changes belong in the coding tools’ initial working directory. New reusable loops execute the released engine and never adopt files from the consumer as Shurik implementation. Existing legacy self-hosted loops keep their previous candidate-validation and fallback behavior.

## CLI

Use Node 24. TypeScript runs with Node's built-in type stripping; `npm run check` type-checks the CLI, action, orchestration, and worker. The repository exposes `bin/shurik.ts` as the `shurik` executable; the action invokes this same CLI. The package is not published to npm.

```sh
npm ci --ignore-scripts
npm run build
node bin/shurik.ts --help
node bin/shurik.ts paths --repository owner/project --loop-id my-task --workspace /path/to/project
```

| Subcommand | Responsibility |
| --- | --- |
| `start` | Create task/control branches, save initial state, dispatch the first iteration |
| `iterate` | Run one fenced Pi Durable iteration, publish checkpoints, dispatch the successor |
| `stop` | Save a durable stop and cancel the active run |
| `resume` | Start a new generation with explicit reasoning and optional model/deadline changes |
| `recover` | Reconcile interrupted runs, retain diagnostics, and restore missing dispatches |
| `worker --request FILE` | Execute a versioned JSON request through the Pi Durable worker |
| `inspect --request FILE` | Open a disposable copy of a native journal without model calls |
| `paths --loop-id ID` | Print canonical runtime and control-branch paths as JSON |

Lifecycle commands expect the GitHub Actions repository, actor, ref, and token context. `--workspace` selects the consumer checkout. Explicit CLI flags override `SHURIK_INPUTS`, the dispatch JSON supplied by the action. `worker` and `inspect` need a built bundle and a version-1 request with `cwd`, `journal`, `output`, model, budget, and session fields; `worker` also requires explicit reasoning and a prompt. These are internal interfaces for local verification; ordinary consumers use the action.

## Action inputs

| Input | Purpose |
| --- | --- |
| `command` | `start`, `iterate`, `stop`, `resume`, or `recover`; defaults to `start` |
| `loop-id` | Unique lowercase loop ID; required except for recovery |
| `inputs` | Optional JSON from `${{ toJSON(inputs) }}`; explicit action inputs override it |
| `model`, `reasoning` | Provider model and explicit reasoning level |
| `create-pr` | `auto` (default), `true`, or `false`; denied repository PR settings become `false` without stopping the loop |
| `seconds`, `deadline` | Iteration budget and optional absolute loop deadline |
| `prompt` | Relative task prompt file; defaults to `PROMPT.md` at start |
| `checkpoint-seconds` | Checkpoint interval, 1–1,800 seconds; defaults to 300 at start |
| `checkpoint-paths` | JSON array of ignored task paths to retain with sessions; defaults to `[]` |
| `source-ref` | Consumer task branch or commit; workflow definitions come from the default branch |
| `generation`, `iteration` | Internal continuation fence supplied by Shurik |
| `workflow` | Iteration workflow filename; default `shurik.yml` |
| `token` | Defaults to `${{ github.token }}` |
| `opencode-api-key` | Model credential supplied from Actions secrets |

Outputs are `engine-revision` (the commit used by this invocation), `state-path`, `logs-path`, `emergency-path` (absolute directories outside the repository), and `control-branch`. Path outputs are written before the CLI runs, so failure artifact steps can use `emergency-path`. The action sets up Node and builds the engine in its own checkout; it does not run your project’s package scripts to install Shurik.

## Loop configuration

Set configuration in the control job's action inputs:

```yaml
- uses: igor-makarov/shurik@v1
  with:
    inputs: ${{ toJSON(inputs) }}
    checkpoint-seconds: 300
    checkpoint-paths: '["data/posts", "data/cdx"]'
    prompt: PROMPT.md
```

Choose the model and iteration time limit with the `model` and `seconds` action or dispatch inputs. Explicit action values override dispatch JSON. Start validates these settings and saves the effective model, time limit, prompt path, checkpoint interval, and checkpoint paths in `control.json` on the control branch. Later iterations read that control record; continuation dispatches carry the loop ID and generation/iteration fence. The controller does not write a configuration file into the task checkout. No settings file needs to be passed between Actions runners.

The iteration time limit is 10–1,800 seconds; the checkpoint interval is 1–1,800 seconds. `prompt` names a relative project file. `checkpoint-paths` selects ignored task data to retain with sessions, for example `["data/posts", "data/cdx"]`. Hidden paths, dependency/build directories, traversal, and symlinks are rejected. The snapshot is paired with its work commit; restoration fills missing files without overwriting newer task records. Select only data suitable for your repository's visibility; use artifact storage for large files.

Existing consumers may still provide `.shurik/config.json`; it is an optional legacy fallback at start, overridden by action inputs. New loops retain their effective configuration on the control branch, including checkpoint selections, so later task-side configuration edits do not change their settings.

## Canonical session paths

[scripts/paths.ts](scripts/paths.ts) declares layout version 1. `shurik paths --repository OWNER/REPO --loop-id ID --workspace DIR` prints the resolved mapping. All persisted data belongs to the **consumer repository**, including when Shurik is loaded from another repository.

| Data | Runtime, outside the repository | Control branch `codex/shurik-control/<loop-id>` |
| --- | --- | --- |
| Session root | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/` | `state/` |
| Native Pi Durable journal | `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/pi-jsonl/` | `state/pi-jsonl/` |
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

Shurik uses three directories under `$HOME/.shurik`: `state/` for sessions, `logs/` for worker and recovery diagnostics, and `emergency/` for fallback snapshots. They are outside every checkout and need no ignore rules, including no blanket `*.log` rule. Worker output is retained as bounded logs in diagnostic JSON files under `logs/`. Set `SHURIK_HOME` to override `$HOME/.shurik` without changing persisted paths. Repository and loop names isolate sessions. Shurik copies the session directory to control-branch `state/` and the runtime logs to `state/diagnostics/` on every checkpoint. The next run restores them into the separate runtime `state/` and `logs/` directories. The persisted version-1 paths stay compatible with older sessions. The task branch is `codex/shurik/<loop-id>`; every checkpoint atomically pushes both branch refs and records the task commit in `control.json.checkpoint.workCommit`. A rejected push publishes neither half, and retries preserve stop/resume decisions.

A Pi hook publishes the session boundary before the first model request and publishes later checkpoints at completed tool-round boundaries. It takes a serialized native journal snapshot and waits for Git publication before continuing. Malformed journals are retained for diagnosis and replaced with the last readable checkpoint. Unpublished work can be lost on abrupt runner failure.

Temporary engine/build/worker-I/O directories live under `RUNNER_TEMP` (locally, the OS temporary directory). They are not session storage. After a supervisor failure, `emergency/<owner>/<repo>/<loop-id>/<run-id>-<attempt>/` under `$HOME/.shurik` contains `workspace/`, `state/`, and `logs/` copies. The workflow uploads that path as evidence when possible; it is not an automatic recovery source. Repository metadata, dependencies, and build output are excluded, and known credentials are redacted before copying.

## Development and release

```sh
npm ci --ignore-scripts
npm run verify
node tests/runner-proof.mjs
```

Checks cover native journal persistence, fresh contexts, coding/history tools, checkpoint races, failure recovery, model reasoning, and an unrelated consumer repository. The scripted runner proof covers the legacy self-repair path. No real model credentials are needed for these checks.

`npm run test:pbt` runs 36 property-based tests using `fast-check`, also included in `npm test` and CI. Each ordinary property checks 1,000 generated cases; filesystem properties use 50–75 cases, and real Git checkpoint properties use eight cases with generated payloads and races. Failures shrink to small counterexamples and print a reproducible seed. See the [property inventory and replay instructions](VERIFICATION.md#property-based-tests).

Publish tested releases with immutable version tags such as `v1.0.0`, then advance the corresponding major tag `v1`. Changes within a major version must preserve the action inputs, continuation protocol, and session layout, including reading journals written by earlier releases in that major. Breaking changes use a new major tag and documented migration. Consumers choose when to move their workflow from `@v1` to `@v2`; no engine-update control branch or per-loop version lock is required.

## Caveats

**Public history is public data.** Sessions are committed directly into the repository on control branches. In a public repository, prompts, model responses, tool output, source excerpts, and failure reports in those commits will be publicly readable. Actions history and logs also become publicly accessible. Use only material suitable for publication; excluding a file from the current tree does not remove it from earlier commits or copies. [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

**Secrets require separate handling.** Keep credentials in Actions secrets, never in prompts, committed state, or diagnostics. Publication redacts known credentials, common encoded forms, and recognizable token patterns. This is a limited accidental-exposure check, not universal secret detection. GitHub log masking does not sanitize commits. If a credential is exposed, rotate it rather than relying on deleting the visible file. The runner sends task context to the selected model provider.

**Contributor access and execution are different boundaries.** GitHub normally withholds repository secrets from fork pull request workflows. Keep contributor CI secret-free, and reserve credentialed loop execution for trusted, maintainer-authorized code. Do not execute unreviewed fork code or consume its artifacts in privileged recovery workflows. A repository writer or code executed with a secret can expose it, even though the stored value is not displayed in repository settings. Passing tests does not establish trust in a contributor's changes or prevent an automatically updated runner from leaking a key it receives. [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)

**The agent shares the runner and its credentials.** Coding tools and candidate code run directly on the Actions runner, can modify local files and make network requests, and receive the job's repository-scoped GitHub token and OpenCode key. The worker has no separate filesystem sandbox or resource caps. It can interfere with loop state or use the token outside its working branch. This is an intentional prototype tradeoff; timeouts, publication redaction, fixed candidate checks and fallback copies remain, but they do not provide credential isolation or a security boundary.

**The dependency is experimental.** Pi Durable explicitly warns that its API can change without notice between releases. Compatible package versions must be pinned and state migrations tested before runner updates are adopted. [Pi Durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)

**Persistence and repair have limits.** Local checkpoints can disappear with an ephemeral runner before they are pushed. After the initial session-boundary checkpoint, checkpoints publish at tool-round boundaries after the configured interval, with the Pi hook awaiting publication. The journal copy is serialized against Pi writes; task files are stable between foreground tool rounds. Detached background writers need their own coordinated durable checkpoints and are not frozen by this hook. A model request with no tool boundary cannot publish an intermediate checkpoint. Abrupt host loss or forced Actions cancellation may lose work since the latest push; recovery preserves available Actions diagnostics independently but cannot reconstruct unpublished work. Malformed journals are retained for diagnosis and replaced with the last readable snapshot. Emergency artifacts after a push conflict are evidence for manual recovery, never trusted automatic inputs. Rebuilding a runner also depends on dependency downloads or the npm cache being available; a build failure is recorded and retried by the loop. Tests and fallback preserve an opportunity for repair, not a guarantee of repair or reversal of external side effects. GitHub outages, branch conflicts, or failures in the fixed supervisor itself can still require maintainer intervention. Reusable loops receive the current release from their workflow’s major action tag on each run. Legacy self-hosted loops retain their original supervisor behavior.

**Continued execution consumes resources.** Repeated runs use provider allowances, Actions resources, and storage. An omitted deadline means execution continues until stopped, not that usage is free or unlimited. Provider quotas, GitHub limits, service outages, and applicable usage terms still apply; chaining jobs does not remove those constraints. [Actions limits](https://docs.github.com/en/actions/reference/limits), [GitHub Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions), [OpenCode Go usage](https://opencode.ai/docs/go/#usage-limits)

**Release scope.** `v1` is the first reusable action interface. Updates within `v1` must preserve that interface and the session layout. Operational guarantees and stronger runner isolation remain future work. License selection is pending; the CLI is packaged in this repository, not published to npm.

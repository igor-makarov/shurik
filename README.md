# Shurik

Shurik is a Ralph loop built on Pi Durable and GitHub Actions. It works on its own repository, with the agent runner separated from repository configuration so it can later become reusable.

**Status: experimentally verified.** Native-journal integration tests, Linux Docker fault-injection checks, and a bounded live Space Bunny loop pass. The live run demonstrated failure publication, fallback source repair, candidate validation, retained-history retrieval, continuation, and durable manual stopping. See [verification evidence](VERIFICATION.md) and the [design](IMPLEMENTATION_PLAN.md).

## Behavior

- One fresh agent context per Actions iteration, with tools to search and read past sessions.
- OpenCode Go model access through an API key supplied as an Actions secret.
- Session history, partial progress, and failure diagnostics committed on a working branch and published through a draft PR.
- A default 30-minute agent budget, followed by time for saving state and validation.
- Continued iterations after both success and failure, until an optional user deadline or manual cancellation.
- Validated runner updates with a retained working fallback; autonomous workflow edits disallowed and merging controlled by the user.

The user supplies the task prompt. A normal agent response does not automatically end the outer loop.

## Run a loop

Add the repository Actions secret `OPENCODE_API_KEY`. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Workflow permissions are scoped explicitly; contributor CI uses a read-only token and no model secret.

Edit `PROMPT.md` on the default branch with a public-safe task. In **Actions → Shurik Ralph → Run workflow**, select the default branch, `start`, a unique loop ID, and a model ID. The default is `space-bunny-free`, selected by the maintainer. Optional `deadline` is an absolute UTC timestamp; `seconds` sets the agent budget (default 1800). Leave internal continuation fields at their defaults. The workflow creates `codex/shurik/<id>` and one draft PR, then dispatches fresh iterations. It never merges the PR.

Use **Shurik Control → stop** with the same ID to record a durable stop before cancelling the active run. **resume** creates a new generation; optionally supply a new deadline. Cancelling an iteration in the Actions UI is also reconciled as a stop, including cancellation during handoff. Recovery is awakened on completed loop runs and by a 15-minute watchdog; GitHub may delay scheduled runs. Queued duplicates are fenced before agent execution.

GitHub does not distinguish every cause of queued-run cancellation in its completion payload. Cancellation of the expected queued successor while no agent owns the iteration is conservatively treated as a stop. An automatically cancelled pending duplicate in that situation can therefore require explicit resume. Old test loops with retired commit attribution require a maintainer bootstrap update before resume.

The authoritative control record lives on `codex/shurik-control/<id>` in `control.json`. Source, history, runtime bundles, iteration outcomes and validation diagnostics live on the working branch under `.shurik/state/<id>/`. The agent can edit source and `PROMPT.md` for subsequent iterations, while `.github`, Git metadata, and supervisor state are mounted read-only. The worker receives the OpenCode key; GitHub credentials stay with the supervisor and are never stored in its checkout.

The supervisor revision is fixed when a loop starts. Changes to `scripts/` can be proposed on the working branch; activation requires a maintainer bootstrap update. Worker changes are checked inside a credential-free container using fixed build/type checks and integration tests from the supervisor revision, plus a canary on copied real history. Failed candidates remain visible for repair. A promoted runner that fails structurally is quarantined and the retained runtime works on the latest source. Provider errors preserve the runner and continue the loop.

## Verify locally

Use Node 24.14.0 (`mise install` if needed), then `npm ci --ignore-scripts && npm run verify`. For the full Docker recovery proof, run `node tests/container-proof.mjs`. This proof checks isolation, a rejected import failure, a probation fault, fallback coding-tool repair and re-adoption. It uses a scripted provider and no credentials. The worker image and Actions are pinned by digest or commit SHA.

For a **bounded live verification**, launch `Shurik Ralph` with a fresh ID, `verification=true`, a short iteration budget, and a deadline. This intentionally breaks source and injects one initial runtime fault on a disposable working branch. A real provider iteration must use the fallback to repair it; later iterations retrieve history and continue until stopped. This mode does not change the task on the default branch.

## Caveats

**Public history is public data.** The proposed design commits sessions directly into the repository. In a public repository, prompts, model responses, tool output, source excerpts, and failure reports in those commits will be publicly readable, including on working branches. Actions history and logs also become publicly accessible. Use only material suitable for publication; excluding a file from the current tree does not remove it from earlier commits or copies. [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

**Secrets require separate handling.** Keep credentials in Actions secrets, never in prompts, committed state, or diagnostics. Publication redacts known credentials, common encoded forms, and recognizable token patterns. This is a limited accidental-exposure check, not universal secret detection. GitHub log masking does not sanitize commits. If a credential is exposed, rotate it rather than relying on deleting the visible file. The runner sends task context to the selected model provider.

**Contributor access and execution are different boundaries.** GitHub normally withholds repository secrets from fork pull request workflows. Keep contributor CI secret-free, and reserve credentialed loop execution for trusted, maintainer-authorized code. Do not execute unreviewed fork code or consume its artifacts in privileged recovery workflows. A repository writer or code executed with a secret can expose it, even though the stored value is not displayed in repository settings. Passing tests does not establish trust in a contributor's changes or prevent an automatically updated runner from leaking a key it receives. [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)

**Autonomous code execution needs isolation.** Coding tools can run shell commands, modify files, install dependencies, and make network requests. Repository content and retrieved history can contain misleading or malicious instructions. The container has a read-only root, restricted mounts, no Docker socket, no host GitHub credentials, dropped capabilities and resource limits. Network access remains enabled, and code holding the OpenCode key can exfiltrate it. These checks are not a general security proof; stronger key protection requires a credential broker. Do not grant production access based on this implementation.

**The dependency is experimental.** Pi Durable explicitly warns that its API can change without notice between releases. Compatible package versions must be pinned and state migrations tested before runner updates are adopted. [Pi Durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)

**Persistence and repair have limits.** Local checkpoints can disappear with an ephemeral runner before they are pushed. Checkpoints publish at tool-round boundaries after the configured interval, pausing the worker for a consistent snapshot. A model request with no tool boundary cannot publish an intermediate checkpoint. Abrupt host loss or forced Actions cancellation may lose work since the latest push. Malformed journals are retained for diagnosis and replaced with the last readable snapshot. Emergency artifacts after a push conflict are evidence for manual recovery, never trusted automatic inputs. Tests and fallback preserve an opportunity for repair, not a guarantee of repair or reversal of external side effects. GitHub outages, branch conflicts, or failures in the fixed supervisor itself can still require maintainer intervention.

**Continued execution consumes resources.** Repeated runs use provider allowances, Actions resources, and storage. An omitted deadline means execution continues until stopped, not that usage is free or unlimited. Provider quotas, GitHub limits, service outages, and applicable usage terms still apply; chaining jobs does not remove those constraints. [Actions limits](https://docs.github.com/en/actions/reference/limits), [GitHub Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions), [OpenCode Go usage](https://opencode.ai/docs/go/#usage-limits)

**Publishing is not a release.** This repository is an early design, with no compatibility commitment or production support. License selection is pending.

# Shurik

Shurik is a proposed Ralph loop built on Pi Durable and GitHub Actions. It will initially work on its own repository, with the agent runner separated from repository configuration so it can later become reusable.

**Status: planning only.** This repository currently contains documentation. There is no runnable agent, Actions workflow, tested recovery system, or implemented security boundary. The behaviors below are design requirements, not demonstrated capabilities. See the [implementation plan](IMPLEMENTATION_PLAN.md).

## Planned behavior

- One fresh agent context per Actions iteration, with tools to search and read past sessions.
- OpenCode Go model access through an API key supplied as an Actions secret.
- Session history, partial progress, and failure diagnostics committed on a working branch and published through a draft PR.
- A default 30-minute agent budget, followed by time for saving state and validation.
- Continued iterations after both success and failure, until an optional user deadline or manual cancellation.
- Validated runner updates with a retained working fallback; autonomous workflow edits disallowed and merging controlled by the user.

The user supplies the task prompt. A normal agent response does not automatically end the outer loop.

## Caveats

**Public history is public data.** The proposed design commits sessions directly into the repository. In a public repository, prompts, model responses, tool output, source excerpts, and failure reports in those commits will be publicly readable, including on working branches. Actions history and logs also become publicly accessible. Use only material suitable for publication; excluding a file from the current tree does not remove it from earlier commits or copies. [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

**Secrets require separate handling.** Keep credentials in Actions secrets, never in prompts, committed state, or diagnostics. GitHub log masking does not sanitize committed session files, and this project currently has no implemented redaction or secret-detection system. If a credential is exposed, rotate it rather than relying on deleting the visible file. The eventual runner will also send task context to the selected model provider.

**Contributor access and execution are different boundaries.** GitHub normally withholds repository secrets from fork pull request workflows. Keep contributor CI secret-free, and reserve credentialed loop execution for trusted, maintainer-authorized code. Do not execute unreviewed fork code or consume its artifacts in privileged recovery workflows. A repository writer or code executed with a secret can expose it, even though the stored value is not displayed in repository settings. Passing tests does not establish trust in a contributor's changes or prevent an automatically updated runner from leaking a key it receives. [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)

**Autonomous code execution needs isolation.** Coding tools can run shell commands, modify files, install dependencies, and make network requests. Repository content and retrieved history can contain misleading or malicious instructions. The planned container isolation, credential separation, workflow restrictions, and draft PR review still need implementation and adversarial testing. Do not treat this plan as a secure sandbox or grant a future agent access to production systems based on these documents.

**The dependency is experimental.** Pi Durable explicitly warns that its API can change without notice between releases. Compatible package versions must be pinned and state migrations tested before runner updates are adopted. [Pi Durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)

**Persistence and repair have limits.** Local checkpoints can disappear with an ephemeral runner before they are pushed. Tests, canaries, and fallback versions are intended to preserve an opportunity for repair; they cannot guarantee a correct repair, lossless recovery, or reversal of external side effects. Candidate checks and cancellation behavior have not yet been demonstrated.

**Continued execution consumes resources.** Repeated runs use provider allowances, Actions resources, and storage. An omitted deadline means execution continues until stopped, not that usage is free or unlimited. Provider quotas, GitHub limits, service outages, and applicable usage terms still apply; chaining jobs does not remove those constraints. [Actions limits](https://docs.github.com/en/actions/reference/limits), [GitHub Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions), [OpenCode Go usage](https://opencode.ai/docs/go/#usage-limits)

**Publishing is not a release.** This repository is an early design, with no compatibility commitment or production support. License selection is pending.

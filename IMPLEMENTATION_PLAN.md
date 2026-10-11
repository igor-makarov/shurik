# Shurik implementation plan

The reusable CLI/action design is documented in [ARCHITECTURE.md](ARCHITECTURE.md). Setup, the action interface, and canonical session paths are documented in [README.md](README.md). Historical runtime checks remain in [VERIFICATION.md](VERIFICATION.md).

## Current scope

- Implement Shurik in TypeScript and package it as a CLI with lifecycle, native worker, journal inspection, and session-path subcommands.
- Expose that CLI through a GitHub Action referenced by consumer workflows as `igor-makarov/shurik@v1`.
- Separate engine source and builds from consumer task source, prompts, and configuration.
- Keep work branches, draft PRs, session state, and failure evidence in the consumer repository.
- Declare layout version 1 centrally: runtime `$HOME/.shurik/state/<owner>/<repo>/<id>/`, persisted control-branch `state/`, authoritative `control.json`, and immutable `failures/`.
- Ship one consumer `shurik.yml` with independent control, iteration, and recovery jobs and the independent `shurik-demo` repository.
- Preserve existing native checkpoint, history, stop/resume, and recovery behavior.

## Version policy

Each invocation follows the current release under the workflow's major tag. Loops do not pin an engine commit. Updates within `v1` must keep workflow inputs, continuation fields, and retained session data compatible. Breaking changes use a new major tag such as `v2`, adopted by changing the consumer workflow. Actual engine revisions are retained as diagnostic evidence.

New reusable loops do not automatically adopt Shurik implementation from consumer task files. Legacy self-hosted loops retain their original candidate validation and fallback helpers; this extraction does not migrate their journals or supervisor records.

## Acceptance checks

- CLI help and argument validation expose the declared commands without requiring Pi installation for control operations.
- A consumer repository without Shurik source or dependencies runs coding/history tools through the CLI.
- Native journals and indexed boundaries survive an atomic two-branch checkpoint and a cold restart.
- Journal inspection uses a disposable copy and leaves canonical state unchanged.
- Moving a major release tag affects the next invocation.
- Existing same-workflow failed-job recovery, scheduled recovery, cancellation/generation fences, partial-work retention, and checkpoint races remain covered by integration checks.
- Demo application tests pass independently of Shurik and model credentials.
- Consumer workflows parse correctly and call the public action rather than repository-local engine scripts.

The prototype's runner isolation and publication limits remain explicit in the README; this step does not add a service, credential broker, Docker runtime, npm registry publication, or automatic merge policy.

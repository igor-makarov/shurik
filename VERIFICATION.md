# Verification

Current implementation: a reusable action invoking the TypeScript Shurik CLI, Node 24.14.0, Pi Durable / Pi AI / Chord 1.0.2, and a native worker built separately from consumer task source. Reusable loops follow the current major release; selected/fallback source commits remain part of the legacy self-hosted path. Runtime sessions live outside the repository under `$HOME/.shurik/state/<owner>/<repo>/<loop-id>/`, and journals and framework state persist on the control branch; task files live on the work branch. Docker and committed worker bundles have been removed.

## Reusable component checks

The component adds CLI/action input checks, optional consumer configuration, current-major-tag resolution on each invocation, and a consumer Git repository with no Shurik source or package dependencies. Real Pi Durable coding tools create a task file through the CLI worker; a paired Git checkpoint publishes that file and native history to separate branches. A cold task checkout restores the canonical session directory, and a fresh worker retrieves the earlier transcript through history tools. Configuration can be supplied entirely through named action inputs and is retained in the control record. An injected dispatch failure preserves a snapshot under the external emergency directory while leaving the initial checkout clean without ignore rules. Git-backed unit and generated tests retain logs alongside checkpoints and restore older `state/diagnostics/` data into the separate runtime logs directory. CLI journal inspection leaves the canonical native journal bytes unchanged. The independent TypeScript demo passes `npm run verify` without engine or runtime dependencies or credentials; TypeScript and Node types are development dependencies.

These automated checks use scripted model responses and local Git remotes; the independent live consumer run is documented below. Type checking covers all production modules, unit/property tests, helpers, and the runner proof; all authored code is `.ts`. Git-backed recovery tests verify recovery while the workflow remains in progress, rejection of an unfinished/mismatched iteration job, and immediate retry after a failure before claim. Consumer integration checks deny automatic PR creation and verify start, task checkpoint publication, ownership release, and successor dispatch still succeed. They also verify successful creation after enabling it and that explicit `false` makes no creation request. The consumer fixture runs iterations 1 and 2, stops/resumes, rejects the old queued generation, and runs iteration 3 with medium reasoning. GitHub dispatch receipts identify old/current queued runs with identical titles. A cancelled old queued run retains its failure evidence without stopping the resumed loop; cancelling the current queued run still stops it. Claimed interrupted iterations advance numbering when resumed or reconciled after stop. Workflow lint verifies the single `shurik.yml` with control, iteration, and recovery jobs. The existing native runner proof is also part of extraction validation. See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime and saved-state contract.

## Property-based tests

`npm run test:pbt` runs 40 `fast-check` properties, included in `npm test`, `npm run verify`, and existing push/PR CI. Default runs cover 30,390 generated scenarios: 30 ordinary properties with 1,000 cases each, five filesystem properties with 50–75 cases, and five real Git properties with eight cases each. Some Git cases publish sequences of up to four checkpoints. Git publication properties use generated task/session payloads in local bare remotes; native Pi journal readability and model history are exercised separately by the integration tests and runner proof.

Each property has a deterministic default seed. Fast-check shrinks failures and prints the seed, shrink path, and smallest counterexample. To replay a failing property, set `SHURIK_PBT_SEED` to its printed seed and select its test name:

```sh
SHURIK_PBT_SEED=20261033 node --test --test-name-pattern='redacting serialized evidence' tests/properties.test.ts
```

`SHURIK_PBT_RUNS` changes the ordinary property's case count. For exploration, run `SHURIK_PBT_SEED=104729 SHURIK_PBT_RUNS=5000 node --test tests/properties.test.ts`. Filesystem and Git case counts stay bounded. All generated credentials are synthetic and all filesystem/Git fixtures are temporary; these checks need no provider key or GitHub writes.

The inventory below corresponds to named properties in [properties.test.ts](tests/properties.test.ts) and [persistence-properties.test.ts](tests/persistence-properties.test.ts):

1. Valid loop IDs produce confined runtime paths and separate work/control refs.
2. Unsafe loop IDs are rejected by every path/ref entry point.
3. Session namespaces distinguish repositories and do not depend on the task checkout.
4. Repository traversal and malformed namespaces cannot escape runtime storage.
5. Explicit CLI flags override dispatch JSON without mutating it.
6. Explicit action values override JSON, including `create-pr: false`.
7. Resume advances exactly one generation, clears ownership, and retains checkpoint identity.
8. Resume fences every invocation from an earlier generation.
9. Resume requires fresh valid reasoning and rejects already-running loops.
10. PR settings survive resume unless overridden; boolean and string forms agree.
11. Claims require the current generation, iteration, and owner and an unexpired running loop.
12. Deadline expiry is inclusive and cannot reverse as time advances.
13. Queued cancellation affects only the matching loop generation and iteration.
14. Recovery trusts only first-party dispatches on the default branch.
15. Same-workflow recovery requires a completed iteration with a matching result.
16. Failure report paths distinguish runs/attempts and reject unsafe identities.
17. Run-title fences round-trip and cannot identify another loop.
18. Nonzero exits and malformed worker envelopes classify as runner failures.
19. Runner rollback is idempotent and retains prior quarantine evidence.
20. Provider errors, timeout, and yield never quarantine or switch a working engine.
21. Known credentials and supported encodings are redacted, length is preserved, and a second pass is unchanged.
22. Recognizable GitHub/API tokens are fully masked without a known-secret list.
23. Redacting serialized evidence preserves valid JSON and unrelated metadata.
24. Session upserts retain all identities in first-seen order with the latest record and are idempotent.
25. Transcript availability requires both boundaries and distinguishes interrupted checkpoints.
26. Task-facing snapshots exclude ownership, deadlines, and recovery machinery without mutating control.
27. Time feedback respects the earlier limit, clamps expiry, and omits early countdowns.
28. Task snapshots round-trip bytes, preserve newer files, deduplicate paths, and restore idempotently.
29. Mismatched task manifests fail before modifying the task checkout.
30. Checkpoint paths reject traversal, hidden state, and dependency/build directories.
31. Snapshot and restore reject symlinks at generated path depths without changing outside files.
32. Generated checkpoint sequences pair task code with session state and restore cold without polluting the task tree.
33. Stale generation or ownership publishes neither checkpoint ref.
34. A CAS stop race preserves the stop and keeps checkpoint refs paired.
35. A CAS resume race prevents old code/journals from reaching either ref.
36. Concurrent task edits reject the whole checkpoint and retain maintainer code.

37. Named action configuration works without a project file, preserves explicit settings, and does not mutate inputs.
38. Emergency snapshots preserve redacted task, state, and log evidence outside the checkout, discard stale snapshots, and exclude repository metadata, dependencies, and builds.

39. Iteration numbers remain contiguous across repeated stops/resumes, counting claimed interruptions and preserving unstarted slots.
40. GitHub run IDs distinguish old/current queued cancellations with identical resumed titles; unknown IDs cannot infer a generation from the iteration number.

Generated cases found two defects fixed in release 1.1.4: masking an unescaped credential before its longer JSON encoding could leave a dangling backslash and corrupt evidence JSON, and an API token ending in `-` was partially masked because of a word-boundary match. Redaction now masks longer encoded forms first and consumes the complete API token. The minimized examples also have a focused unit regression.

## Live reusable consumer evidence

The public [shurik-demo](https://github.com/igor-makarov/shurik-demo) repository invokes `igor-makarov/shurik@v1` from one `shurik.yml` and contains no engine source or runtime dependencies. Loop `greeting-20261011-120943-retry` used two-minute iterations and a finite deadline. The initial `space-bunny-free` requests failed because the provider reported the model unavailable. After an explicit stop and maintainer-approved resume with `deepseek-v4.1-flash` and `high` reasoning, the native worker completed the greeting task.

| Observed run | Result |
| --- | --- |
| [DeepSeek iteration 2-5](https://github.com/igor-makarov/shurik-demo/actions/runs/38138912933) | Added backward-compatible English/Spanish greetings, five passing tests, and `greeting-api.md`; published a paired code/session checkpoint |
| [Continuation 2-6](https://github.com/igor-makarov/shurik-demo/actions/runs/38138996521) | Restored native history on a fresh runner, called `read_session` for 2-5, and verified the completed task without further code changes |
| Recovery jobs in both runs above | Continued the loop in the same workflow after GitHub denied optional PR creation; retained the Actions failure reports before dispatch |
| [Durable stop](https://github.com/igor-makarov/shurik-demo/actions/runs/38139089855) | Control and recovery succeeded; committed `status: stopped` and `owner: null` |
| [Linux engine CI](https://github.com/igor-makarov/shurik/actions/runs/38138846445) | Passed production type/build checks, native integration tests, and the complete scripted runner proof |

Both paid iteration records name engine commit `810eb28cdf35a07f94f9d43f5997e8696872fa42`, received through the current major tag although the loop originally started with `ff7488806b221b3c8af26e6384d514cbdd03ebe6`. The task commit is `e1df2c834f4e4e39c940921df29d3c1cc1acfa1e`. The control branch retains native journals, iteration records, checkpoint pairing, and failure evidence under the declared paths. CLI inspection of a disposable copy of the final remote journal returned `readable`. The final usage snapshot reports a cumulative model cost of $0.010511934 for these two paid iterations; this is provider-reported usage, not a spending cap.

The paid iteration jobs failed only at automatic PR creation after successful task publication; their recovery jobs succeeded. Release 1.1.3 adds optional PR creation with an automatic default, so consumers can install only the workflow and secret. The verified task changes are published directly to demo `main`; no demo PR was created. The loop remains stopped.

## Local evidence

`npm run verify` covers the checks described below, with one real-state canary skipped locally and exercised inside the native runner proof. Checks cover native JSONL reopening across processes, fresh context with retained history retrieval through all three tools, more than 200 entries in one session, real coding-tool edits, partial edits after model failure, timeout abort and reopen, abrupt process death without replaying pending input, candidate/fallback classification, secret redaction, immutable runtime source references, fork event rejection, dispatch fencing, queued cancellation and handoff races, canonical API URL construction, durable failure reports, checkpointed interrupted transcripts, and a real Git push conflict where finalization preserves a racing stop request. A mocked HTTP transport exercises the native OpenCode request path and verifies Shurik's user agent and a persistent `x-opencode-session` across context resets without using real credentials. It asserts high and then medium reasoning_effort on actual request bodies across a persisted context reset. Additional checks reject omitted/invalid/unsupported reasoning, require it again at resume without inheriting a prior value, and apply a model change with the new generation.

Checkpoint tests also queue a competing Pi configuration mutation during snapshot creation and confirm that the prepared copy excludes it. A native OpenCode transport test verifies refreshed time feedback in actual system request messages, continuation and handoff guidance, and no next provider request before checkpoint acknowledgment.

Real Git remotes exercise atomic paired checkpoints: journals, indexes, malformed-journal evidence and source references are present only on the control branch; a cold checkout retrieves them without any task diff. A control CAS race publishes neither ref before retry and preserves a manual stop. A racing resume blocks stale source and journals. A concurrent task-branch edit rejects the complete checkpoint, keeping the prior control checkpoint intact. An atomic dry-run push also confirmed support on the repository's GitHub remote without creating branches.

`node tests/runner-proof.ts` exercises the complete scripted repair proof:

1. Run real Pi Durable coding tools as a native process. A test GitHub token and provider key reach the worker; local workflow files are writable. Partial code and native history survive an intentional model failure.
2. Introduce an import-time runner defect. Fixed candidate checks reject it.
3. Commit a candidate, validate that exact source revision with the fixed tests and copied-state canary, then rebuild it and boot it on a different live request that triggers a structural fault. Quarantine it and rebuild the baseline source revision on a fresh runner while the current task source is still broken.
4. Use that worker's actual history and coding tools to repair the latest source.
5. Validate the repaired candidate, including a canary that opens a copy of real persisted history, and permit re-adoption.
6. Await a cooperative Pi checkpoint at a tool-round boundary, use the worker-prepared readable journal copy, corrupt the live journal, retain the damaged files, restore the checkpoint, and start a fresh iteration. CI also runs this complete proof on Linux.
7. Atomically publish task source on the work branch and the native journal, iteration record, and history index on the control branch; interrupt the supervising operation before finalization and kill the worker process. Restore only remote commits into fresh checkouts, mark the session interrupted, and start a fresh worker. Its actual history tools retrieve the interrupted transcript, its initial prompt contains structured recovery diagnostics, and the partial source edit survives. The work branch contains no framework state or generated runtime bundle.
8. End real shell work through both the worker time budget and supervisor control polling; verify timeout outcomes, partial files and readable journals survive.

The failure-trail tests use real temporary Git remotes. They verify that report files and their control index are committed before dispatch; evidence survives a lost work checkout and failed dispatch; another process imports the full report and interrupted-session boundaries; repeated events and later run attempts preserve earlier reports; stopped/cancelled loops retain evidence; and racing stop/resume commands keep their intended state. Jobs/log API failures remain explicit evidence without suppressing continuation. A mocked redirect verifies that the GitHub token is not forwarded to log storage and both retained excerpts and download sizes are bounded.

The collector was also tested against the existing [cancelled live iteration](https://github.com/igor-makarov/shurik/actions/runs/37211182079), using the configured GitHub login. It retrieved one job's step results and a 16 KiB log excerpt, recorded `cancelled`, and passed known-token redaction. This is a real API check; the new interruption/recovery proofs use a scripted provider and do not claim an additional live Space Bunny recovery run.

## Earlier container live evidence

The corrected controlled loop used the maintainer-selected `opencode-go/space-bunny-free` model with a finite deadline and 180-second agent budget in [draft PR #2](https://github.com/igor-makarov/shurik/pull/2).

| Observed run | Result |
| --- | --- |
| [Initialize](https://github.com/igor-makarov/shurik/actions/runs/37210647290) | Created one working branch, durable control branch and draft PR |
| [Iteration 1](https://github.com/igor-makarov/shurik/actions/runs/37210682581) | Recorded the injected structural failure, quarantined the bad bundle, rejected broken source, dispatched fallback |
| [Iteration 2](https://github.com/igor-makarov/shurik/actions/runs/37210745857) | Real Space Bunny requests invoked coding/history tools, removed the source defect, wrote verification-proof.txt, yielded; fixed candidate checks passed and source was accepted |
| [Iteration 3](https://github.com/igor-makarov/shurik/actions/runs/37210951907) | Fresh iteration used list/search/read history tools and successfully retrieved iteration 2's transcript, then yielded and continued |
| [Durable stop](https://github.com/igor-makarov/shurik/actions/runs/37211217664) | Recorded stopped state and cancelled the active iteration; state remained stopped with no owner or successor |
| [Linux CI](https://github.com/igor-makarov/shurik/actions/runs/37211224839) | Passed type/build checks, native integration checks, and the full container repair/checkpoint proof |

Inspection of the committed native journal confirmed it remained readable, sessions 2–4 yielded with all three history tools available, and session 3 read session 2 successfully. The runtime record contains one quarantined digest and a passing candidate fingerprint. The repaired bundle is byte-identical to the retained baseline, so acceptance did not require installing a different digest. Manual stop interrupted session 5; its available history and timeout outcome were saved. All test loops are stopped, and no test PR was merged.

The first attempt in [draft PR #1](https://github.com/igor-makarov/shurik/pull/1) exposed Linux container ownership errors. Its false journal failures retained native data in diagnostic archives; that loop was stopped and the ownership fix was verified in Linux CI before the corrected run. The launch also found and corrected a repository-API trailing-slash bug. Normal PR CI triggered by GITHUB_TOKEN requires GitHub approval; independent fixed candidate checks ran inside each loop without that approval.

Git authors now use the verified official Actions bot ID `41898282`. The original test commits used an incorrect placeholder that matched a real account. With explicit maintainer approval, all 48 affected commits on the four stopped test branches were corrected using one atomic, lease-checked push. Every file tree stayed identical, and main was untouched by the rewrite. GitHub now matches these commits to `github-actions[bot]`. Legacy test loops cannot resume their pinned supervisor until its retired identity is updated.

## Scope and limits

These are integration and fault-injection checks, not an adversarial security proof or exhaustive simulation of every cloud outage. The first live fault is explicitly injected; deterministic validation rejection is separately exercised before fallback repair. No test demonstrates that an arbitrary model can reliably repair arbitrary architecture failures. Forced cancellation can interrupt final publication. Recovery may be delayed by GitHub scheduling or require intervention after a supervisor defect or persistent branch conflict. Known-token redaction cannot detect every private value or every encoding. See the README caveats.

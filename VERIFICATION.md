# Verification

Current implementation: Node 24.14.0, Pi Durable / Pi AI / Chord 1.0.2, and a standalone worker bundle running as a native process. Docker has been removed. The earlier live evidence below describes the previous container implementation.

## Local evidence

`npm run verify` passes 24 checks, with one real-state canary skipped locally and exercised inside the native runner proof. Checks cover native JSONL reopening across processes, fresh context with retained history retrieval through all three tools, more than 200 entries in one session, real coding-tool edits, partial edits after model failure, timeout abort and reopen, abrupt process death without replaying pending input, candidate/fallback classification, secret redaction, digest validation, fork event rejection, dispatch fencing, queued cancellation and handoff races, canonical API URL construction, durable failure reports, checkpointed interrupted transcripts, and a real Git push conflict where finalization preserves a racing stop request. A mocked HTTP transport exercises the native OpenCode request path and verifies Shurik's user agent and a persistent `x-opencode-session` across context resets without using real credentials.

`node tests/runner-proof.mjs` exercises the complete scripted repair proof:

1. Run real Pi Durable coding tools as a native process. A test GitHub token and provider key reach the worker; local workflow files are writable. Partial code and native history survive an intentional model failure.
2. Introduce an import-time runner defect. Fixed candidate checks reject it.
3. Validate a candidate that passes the actual fixed tests and copied-state canary, then boot it on a different live request that triggers a structural fault. Quarantine it and select the digest-verified retained worker.
4. Use that worker's actual history and coding tools to repair the latest source.
5. Validate the repaired candidate, including a canary that opens a copy of real persisted history, and permit re-adoption.
6. Pause the worker process at a tool-round boundary, copy a readable checkpoint, corrupt the live journal, retain the damaged files, restore the checkpoint, and start a fresh iteration. CI also runs this complete proof on Linux.
7. Publish a tool-round snapshot containing source, native journal, iteration record, and history index; interrupt the supervising operation before finalization and kill the worker process. Restore only the published snapshot, mark its session interrupted, and start a fresh worker. Its actual history tools retrieve the interrupted transcript, its initial prompt contains structured recovery diagnostics, and the partial source edit survives.
8. End real shell work through both the worker time budget and supervisor control polling; verify timeout outcomes, partial files and readable journals survive.

The failure-trail tests use real temporary Git remotes. They verify that report files and their control index are committed before dispatch; evidence survives a lost work checkout and failed dispatch; another process imports the full report and interrupted-session boundaries; repeated events and later run attempts preserve earlier reports; stopped/cancelled loops retain evidence; and racing stop/resume commands keep their intended state. Jobs/log API failures remain explicit evidence without suppressing continuation. A mocked redirect verifies that the GitHub token is not forwarded to log storage and both retained excerpts and download sizes are bounded.

The collector was also tested against the existing [cancelled live iteration](https://github.com/igor-makarov/shurik/actions/runs/37211182079), using the configured GitHub login. It retrieved one job's step results and a 16 KiB log excerpt, recorded `cancelled`, and passed known-token redaction. This is a real API check; the new interruption/recovery proofs use a scripted provider and do not claim an additional live Space Bunny recovery run.

## Live evidence

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

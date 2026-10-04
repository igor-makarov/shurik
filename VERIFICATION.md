# Verification

Tested implementation: Node 24.14.0, Pi Durable / Pi AI / Chord 1.0.2, a standalone 2.6 MB worker bundle, and a digest-pinned Debian Node container.

## Local evidence

`npm run verify` passes 11 tests covering native JSONL reopening across processes, fresh context with retained history retrieval through all three tools, real coding-tool edits, partial edits after model failure, timeout abort and reopen, candidate/fallback classification, secret redaction, digest validation, fork event rejection, dispatch fencing, and a real Git push conflict where finalization preserves a racing stop request.

`node tests/container-proof.mjs` passes the complete scripted repair proof:

1. Run real Pi Durable coding tools in the worker container. GitHub credentials and the Docker socket are absent; a workflow write fails on the read-only mount. Partial code and native history survive an intentional model failure.
2. Introduce an import-time runner defect. Fixed candidate checks reject it.
3. Boot a deliberately broken probation bundle. Classify the structural failure and select the digest-verified retained worker.
4. Use that worker's actual history and coding tools to repair the latest source.
5. Validate the repaired candidate, including a canary that opens a copy of real persisted history, and permit re-adoption.

## Live evidence

GitHub Actions / OpenCode Go verification is pending. The controlled task will use the maintainer-selected `space-bunny-free` model and a finite deadline on a disposable draft PR branch. This section will record observed runs, history use, source repair, continuation, and durable stopping.

## Scope and limits

These are integration and fault-injection checks, not an adversarial security proof or exhaustive simulation of every cloud outage. The first live fault is explicitly injected; deterministic validation rejection is separately exercised before fallback repair. No test demonstrates that an arbitrary model can reliably repair arbitrary architecture failures. Forced cancellation can interrupt final publication. Recovery may be delayed by GitHub scheduling or require intervention after a supervisor defect or persistent branch conflict. Known-token redaction cannot detect every private value or every encoding. See the README caveats.

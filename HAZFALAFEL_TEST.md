# Hazfalafel end-to-end test

This branch contains the task prompt for Shurik to implement and run its own crawler and OCI publisher. It deliberately contains no prebuilt crawler or publishing code. Main keeps the general Shurik prompt and the native Actions runner.

## Scope

- Recover hazfalafel.com post images, captions, HTML/text content and tags from Wayback captures through the inclusive cutoff `20191231235959`.
- Publish recovered media to `ghcr.io/igor-makarov/shurik-hazfalafel-com`, using each numeric Tumblr post ID as its tag and keeping full post metadata and capture provenance in the artifact.
- Make the package public. GitHub initially creates GHCR packages as private; the maintainer may need to change its visibility after the first publication.
- Track missing posts/images in Git, document every recovery method tried, and revisit gaps in later iterations. Preserve partial image recovery and distinguish archive gaps from transient errors.
- Account for slow archive requests with bounded timeouts, backoff, modest concurrency, deduplication and resumable progress.

## Launch

Launch the workflow from **main** and pass this branch through `source_ref`. The supervisor stays pinned to main, and the loop creates its own work and control branches from this task source. Subsequent iterations read the working branch's updated prompt and full retained session history.

Set a deadline **15 minutes from launch**, as agreed for the first live test. Use a **600-second iteration budget** to exercise multiple fresh sessions within that deadline. Keep fault-injection `verification` disabled: this task is the real crawl, not the synthetic runner-fault test.

```sh
gh workflow run ralph.yml --repo igor-makarov/shurik --ref main \
  -f command=start \
  -f source_ref=codex/hazfalafel-test \
  -f loop_id=hazfalafel-UNIQUE-LOWERCASE-ID \
  -f model=space-bunny-free \
  -f seconds=600 \
  -f deadline=ABSOLUTE-UTC-TIMESTAMP-15-MINUTES-FROM-NOW
```

Replace both placeholders before running. The default 30-minute per-iteration budget is separate from the overall deadline. There is no new token or secret to create: the native worker receives `GITHUB_TOKEN` with `packages: write`, `GHCR_USERNAME`, and the existing `OPENCODE_API_KEY`. It must use credentials from the environment without printing or saving them. GitHub still rejects workflow edits made with this token.

## Review after 15 minutes

Inspect the loop's draft PR, session history, iteration outcomes, missing-item ledger, method log and GHCR package. Record the actual discovered, recovered, partially recovered, published and missing counts; do not treat unknown captures as completed work.

Verify a sample of published numeric tags by reading their OCI manifest/config and image blobs: the captions, content, tags and Hebrew text must match the archived sources; image bodies must be real images; every replay/capture must be at or before the cutoff. Include posts recovered through alternate pages and missing-image failures if the agent encountered them. Confirm a later iteration retrieved earlier session history and resumed prior progress.

Use **Shurik Control → stop** with the loop ID for a durable manual stop. With the deadline set, the loop stops automatically; saving and validation may finish afterward. Decide whether to extend the crawl after reviewing measured progress and failures.

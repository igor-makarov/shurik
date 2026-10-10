# Hazfalafel end-to-end test

This is the existing Hazfalafel task branch, with its crawler and OCI publisher. Main keeps the general Shurik prompt and native Actions runner. The stopped loop's journals now live on its control branch; full post content and bulk inventories belong in GHCR and are ignored locally. PROMPT.md documents the prior Git corpus used for the first registry checkpoint.

## Storage layout

- Recovered posts: one artifact per numeric post id in
  `ghcr.io/igor-makarov/shurik-hazfalafel-com` (tag == post id).
- Bulk crawl state (`data/posts/`, `data/cdx/`, retry queues): the `crawl-state`
  tag of the same package, pushed and pulled with
  `python3 -m recovery.cli checkpoint` / `checkpoint --pull`. The committed
  pointer `data/checkpoint.json` records its manifest digest and schema version.
  It is internal crawl state, not a recovered post.
- Git: code, tests, `data/image-queue.json`, `data/missing.jsonl`,
  `data/gaps.jsonl`, `data/published.jsonl`, `data/verification/*.json`.

## Scope

- Recover hazfalafel.com post images, captions, HTML/text content and tags from Wayback captures through the inclusive cutoff `20191231235959`.
- Publish recovered media to `ghcr.io/igor-makarov/shurik-hazfalafel-com`, using each numeric Tumblr post ID as its tag and keeping full post metadata and capture provenance in the artifact.
- Make the package public. GitHub initially creates GHCR packages as private; the maintainer may need to change its visibility after the first publication.
- Track missing posts/images and methods tried in compact Git records, and revisit gaps in later iterations. Store full post metadata, images and bulk crawl checkpoints in GHCR. Preserve partial image recovery and distinguish archive gaps from transient errors.
- Account for slow archive requests with bounded timeouts, backoff, modest concurrency, deduplication and resumable progress.

## Launch

The existing loop `hazfalafel-20261004t213311` is stopped. Resume it explicitly through Shurik Control when ready; that continues this work branch and loads retained history from its control branch. Merging main and changing the prompt do not resume it or choose a new deadline. The workflow command below is only for starting a separate new test, with this updated work branch passed through `source_ref`.

Configure run controls in Actions separately from the task prompt. Keep fault-injection `verification` disabled: this task is the real crawl.

```sh
gh workflow run ralph.yml --repo igor-makarov/shurik --ref main \
  -f command=start \
  -f source_ref=codex/shurik/hazfalafel-20261004t213311 \
  -f loop_id=hazfalafel-UNIQUE-LOWERCASE-ID \
  -f model=space-bunny-free \
  -f reasoning=high
```

Replace the loop ID placeholder before running and choose reasoning explicitly; there is no default reasoning value. Resume also requires an explicit reasoning level and accepts an optional new model. The maintainer chose high for this stopped loop; recording it does not resume execution. There is no new token or secret to create: the native worker receives `GITHUB_TOKEN` with `packages: write`, `GHCR_USERNAME`, and the existing `OPENCODE_API_KEY`. It must use credentials from the environment without printing or saving them. GitHub still rejects workflow edits made with this token.

## Review

Inspect the loop's draft PR, session history, iteration outcomes, missing-item ledger, method log and GHCR package. Record the actual discovered, recovered, partially recovered, published and missing counts; do not treat unknown captures as completed work.

Verify a sample of published numeric tags by reading their OCI manifest/config and image blobs: the captions, content, tags and Hebrew text must match the archived sources; image bodies must be real images; every replay/capture must be at or before the cutoff. Include posts recovered through alternate pages and missing-image failures if the agent encountered them. Confirm a later iteration retrieved earlier session history and resumed prior progress.

Use **Shurik Control → stop** with the loop ID for a durable manual stop. Review measured progress and failures before choosing further runs.

# Hazfalafel recovery handoff

Recovered post images live in GHCR (`ghcr.io/igor-makarov/shurik-hazfalafel-com`):
one artifact per numeric Tumblr post id, tag == post id, each recovered image as
its own gzip-tar layer with full post metadata (HTML/text, tags, captions,
Hebrew text, original URLs, capture provenance) in the OCI config
(`shurik.post`) and in the `post.json` layer.

Git keeps **code, tests and compact records only**: `data/image-queue.json`,
`data/missing.jsonl`, `data/gaps.jsonl`, `data/published.jsonl`,
`data/verification/*.json`, `data/checkpoint.json`.

Bulk crawl state (`data/posts/`, `data/cdx/`, the retry queues) is gitignored
and travels in the same package under the `crawl-state` tag.

```sh
python3 -m recovery.cli checkpoint          # push crawl-state, write pointer
python3 -m recovery.cli checkpoint --pull   # anonymous pull into the tree
```

Only if no `crawl-state` tag exists, bootstrap from Git history (ignored files,
not to recommit):

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

## Current counts (derived from `data/published.jsonl`: max `image_count` once per post id)

| Metric | Value |
| --- | ---: |
| Published images (per-tag max; includes same-byte aliases) | **256** across 806 tags |
| Distinct recovered SHA-256 among post image entries | 189 |
| Positive posts (image_count > 0) | 178 |
| Posts parsed / recovered | 1637 / 178 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | 6094 (153 with captures) |
| Pending stem questions | 0 after the 20-324 passes |
| Listing captures done / total | 1576 / 6311 (4735 pending) |

## 20-324 result: closed the 23113407036 lead; +11 published images (245/173 -> 256/178), +6 hashes

* **Post 23113407036 was already fully published.** The anonymous tag carries
  3 image layers (153228 bytes, including the 50202-byte `c6ee514...` JPEG from
  capture 20181018115722) and `verify-artifact` passes 25/25. Only the Git
  ledger was stale (max `image_count` 2); refreshed to 3. Treat this as
  completed work, not a new lead.
* **Listing discovery is still the lever.** Two bounded `fetch-listings` passes
  (40 + 60 pages, kinds archive/tagged/other) added ~415 new URL forms, which
  regenerated 59 unanswered stems. `stem-scan` answered all of them (6 + 1
  hits, ~9% hit rate) and `fetch-images --method stem --only-stem-hits`
  recovered 10 images across 9 tags. All 9 new/updated tags passed anonymous
  `verify-artifact` (17-25 checks each).
* **Code repairs (`recovery/cli.py`, regression tests in `BlobFallbackTests`):**
  * Per-image publication now runs *inside* the work loop
    (`_publish_recovered(pid, fetcher)` under `_PUBLISH_LOCK`) instead of only
    after the whole post's `pool.map` result is consumed, so a slow sibling
    image or an earlier worker can no longer hold recovered bytes only in the
    ephemeral blob cache until preemption.
  * `ensure_blob` backfills `blob_path` on its cached path: a record restored
    from the registry can carry `sha256` without `blob_path`, and the artifact
    builder reads `img["blob_path"]` directly.
  * New `_restore_missing_blobs`: absent old blobs are first pulled anonymously
    from the already-published artifact (verified by sha256) before any Wayback
    refetch, so a changed old-capture digest no longer blocks publishing the
    freshly recovered sibling bytes. A different digest is never accepted.

## Known baseline failure (disclosed, not fixed)

`recovery.tests.test_crawler.HostInventoryEvidenceTests.test_complete_scan_confirms_gap_without_any_cdx_query`
errors with `KeyError: 'host_inventory'` because its fixture no longer sets
`resume_key_walk=True` (reverted per maintainer instruction). `MediaIndex.host_complete`
deliberately requires a resume-key walk, so the fixture's `complete: True`
alone is inconclusive. This is the only failure: 79/80 pass. Run tests with
`python -m unittest recovery.tests.test_crawler` (the embedded `unittest.main()`
only runs the classes defined above it).

## Next work

* Keep the pipeline moving in bounded units: `fetch-listings --limit N` (kinds
  `archive,tagged,other`) -> `stem-scan --dry-run` -> answer pending stems ->
  `fetch-images --method stem --only-stem-hits`. New stems appear only after a
  pass that adds `url_forms`, so re-run `stem-scan --dry-run` every time.
* `tagged` is the largest pending family; later snapshots of one listing URL
  can name posts an earlier one did not (`--all-captures` once one-per-url is
  exhausted).
* `fetch-images --method probe --retry-missing` opens the settled sibling-form
  pool; `probe-availability` sweeps are the cheaper alternative.

## Negative evidence worth keeping

* **CDX host wildcards are silently empty** (`url=*.media.tumblr.com/<stem>`),
  false negatives even for a known capture. Do not use.
* **CDX regex filters over the whole `media.tumblr.com` domain 504.** Per-shard
  local matching (hostdump) is the only variant; cross-shard copies are already
  falsified (0/308 for listing-only photos).
* **No pre-2012 captures of the blog itself.** `hazfalafel.tumblr.com` has zero
  captures; `icanhazfalafel.tumblr.com` has only 32 captures through the cutoff
  and its root's 8 photo URLs are all known stems. Subdomain mining is closed.
* **Multi-`url=` CDX batching is unsupported**: only the first `url=` is
  answered. `stem_scan` sends one request per stem deliberately.
* Host inventory is conclusive only after a complete *resume-key* walk taken
  after the key was known; the legacy `page=N` cursor is not evidence.
* Transport refusals/timeouts are not `archive_gap` and not proof of
  throttling; only a genuine 429/503 is throttled. HTTP status 000 = no answer.
* `data/cdx/hostdump-cursors/68.media.tumblr.com.cursor.json` holds an
  unfinished resume-key host walk; its rows live in `data/work/hostdumps/`
  (now carried by the checkpoint) and can be re-matched offline with
  `reindex-media`.

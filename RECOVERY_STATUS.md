# Hazfalafel recovery handoff

Recovered post images live in GHCR (`ghcr.io/igor-makarov/shurik-hazfalafel-com`):
one artifact per numeric Tumblr post id, tag == post id, each recovered image as
its own gzip-tar layer with full post metadata (HTML/text, tags, captions,
Hebrew text, original URLs, capture provenance) in the OCI config
(`shurik.post`) and in the `post.json` layer.

Git keeps **code, tests and compact records only**: `data/image-queue.json`,
`data/missing.jsonl`, `data/gaps.jsonl`, `data/published.jsonl`,
`data/verification/*.json`, `data/checkpoint.json`.

Bulk crawl state (`data/posts/`, `data/cdx/`, retry queues) is gitignored and
travels in the same package under the `crawl-state` tag.

```sh
python3 -m recovery.cli checkpoint          # push crawl-state, write pointer
python3 -m recovery.cli checkpoint --pull   # anonymous pull into the tree
```

Bootstrap only if no `crawl-state` tag exists:

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

## Current counts (derived from `data/published.jsonl`, max `image_count` per post id)

| Metric | Value |
| --- | ---: |
| Published images (per-tag max; includes same-byte aliases) | **343** |
| Positive posts (image_count > 0) | 194 |
| Distinct recovered SHA-256 among post image entries | **207** |
| Distinct hashes with a passing anonymous byte receipt | **207** |
| Posts parsed | 1701 |

Crawl-state pointer: `data/checkpoint.json`, tag `crawl-state`
(see that file for the current manifest digest). Refresh the pointer with
`python3 -m recovery.cli checkpoint` after new bulk state.

## 23-346 result: verification backlog closed (183 -> 207 hashes)

`verify-artifact` pulled the 24 tags that still lacked a passing anonymous
image-byte receipt; all 24 passed (16/16 .. 21/21 checks, anonymous pulls).
Every one of the 207 distinct recovered hashes now has a saved anonymous
byte check. This is retrievability evidence for already-recovered bytes, not
new bytes.

## Durable negative evidence (do not repeat)

* All unresolved-image stems are answered (0 unanswered questions for missing
  images). Re-asked, with the current CDX server, **54 randomly sampled missing
  stems returned 0 captures**, so the recorded gap answers are trustworthy, not
  stale.
* The 658 stems whose only recorded answer came from the removed *batched*
  CDX path were suspect. 39 re-asked individually -> 0 captures; the batch
  answers were correct.
* Cross-shard copies on the 7 shards whose bulk `filter=original:.*r3it8zo.*`
  scan 504s (`24/25/27/30/64/66/media.media.tumblr.com`): 54 per-key
  swapped-host queries -> 0 captures. The md5dir is shard-independent, so this
  is the right probe; the 504 is a real server-side index-size limit.
* `hazfalafel.com/api/read/json`, `/sitemap` not archived; RSS feed fully mined
  (59/59 captures, 0 new forms/images); `/page/N`, `/mobile`, `/archive/*`
  listing families fully fetched.
* Listing evidence is already merged: only 16 listing images are not in a post
  record (all under an empty `post_id`, no permalink anchor).

## Known correctness item (not yet repaired)

* 15 `post_other` listing rows have a foreign blog post id as `post_id` while
  `listing_url` is the hazfalafel container `/post/<id>`; none carry images, so
  no wrong bytes were published. Repair should attribute to the container id.

## Known baseline test failure (disclosed, not fixed)

`recovery.tests.test_crawler.HostInventoryEvidenceTests.test_complete_scan_confirms_gap_without_any_cdx_query`
errors `KeyError: 'host_inventory'` (fixture missing `resume_key_walk=True`,
reverted per instruction). 79/80 pass.

## Next work (only surfaces with any remaining yield)

* **Tagged second snapshots**: 398 distinct `/tagged/<tag>` URLs are already
  done once; their remaining captures are the only unmined listing surface.
  Run `fetch-listings --kinds tagged --all-captures --limit N`, then
  `stem-scan`, then `fetch-images --only-stem-hits` on any hit. Measured
  ~1 new stem per ~60 fetches; low but the only known new-form source.
* When a stem hit's replay gets a transport failure, retry the exact capture
  directly (curl proved the bytes exist) before re-discovering it.
* `dump-hosts` on a small media shard has never produced a real page + cursor;
  the synthetic round-trip test does not prove the real path. If exercised,
  verify row identity/count and the opaque cursor survive a fresh runner.
* Prefer this pipeline over re-audits; checkpoint `crawl-state` after each batch.

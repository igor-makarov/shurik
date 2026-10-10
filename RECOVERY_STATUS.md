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
| Published images (per-tag max; includes same-byte aliases) | **357** |
| Positive posts (image_count > 0) | 206 |
| Distinct recovered SHA-256 among post image entries | **221** |
| Distinct hashes with a passing anonymous byte receipt | 219 (2 pending) |
| Distinct recovered media base keys | 209 |
| Distinct missing media base keys | 1985 |
| Posts parsed | 1701 |

Crawl-state pointer: `data/checkpoint.json`, tag `crawl-state` (see that file
for the current manifest digest). Refresh the pointer with
`python3 -m recovery.cli checkpoint` after new bulk state.

## 23-350 result: tagged second-snapshot pipeline measured saturated

Ran `fetch-listings --kinds tagged --all-captures --limit 100` (100/100
fetched, 0 failures) on the 731 remaining tagged captures. It added **211 URL
forms** to known images but only **3 genuinely new unasked stems**, all for
media already recorded missing. `stem-scan` asked those 3: **0 captures**.

Conclusion (refresh of stale notes): the tagged second-snapshot surface is
effectively mined out for *new bytes*. The 239 "unassigned listing images not
in any post record" are all aliases of known media (base_key already known), not
new photos. Do not re-run this sweep expecting recovery; the remaining 631
tagged captures are near-certain duplicates.

## Durable negative evidence (do not repeat)

* All unresolved-image stems are answered (0 unanswered questions for missing
  images). Random re-asks return 0 captures. Only a handful of new stems ever
  appear, and the last 3 had 0 captures.
* `xshard` found 32 cross-shard URLs; all are now recovered or aliases of
  recovered media. No pending cross-shard retrieval remains.
* `posts_with_stem_hits` now returns only avatars (`s16x16u_c1`, excluded) and
  same-byte aliases of recovered media: **no genuine "bytes waiting"**.
* `/api/read/json`, `/sitemap` not archived; RSS fully mined; `/page/N`,
  `/mobile`, `/archive/*` fully fetched (0 unfetched "other"/"archive" listing
  captures; only tagged second snapshots remained).
* CDX `filter=original:.*r3it8zo.*` on the 7 big media shards 504s (server-side
  index-size limit). `showNumPages` reports ~97695 pages for 66.media; the
  page-based API returns [] when a `filter` is present, so bulk host sweeps of
  the big shards remain blocked.

## Known correctness item (not yet repaired)

* 15 `post_other` listing rows have a foreign blog post id as `post_id` while
  `listing_url` is the hazfalafel container `/post/<id>`; none carry images, so
  no wrong bytes were published. Repair should attribute to the container id.

## Known baseline test failure (disclosed, not fixed)

`recovery.tests.test_crawler.HostInventoryEvidenceTests.test_complete_scan_confirms_gap_without_any_cdx_query`
errors `KeyError: 'host_inventory'` (fixture missing `resume_key_walk=True`,
reverted per instruction). 79/80 pass.

## Next work

1. **Cross-shard per-key retrieval (untested large surface).** Only ~54 of
   ~13000 (missing media x big-shard) swapped-host queries have ever been asked,
   all 0. For a missing media with a known md5dir, query each big shard host for
   `<shard>/<md5dir>/tumblr_<base>` (md5dir is shard-independent). Run a bounded
   150-query sample first and measure the hit rate before scaling. One query per
   request, respect `MIN_REQUEST_INTERVAL`.
2. **Close the 2-hash verification backlog**: posts 104317036098
   (`5e1a06feaf44`) and 125172044513 (`768aec1643ca`), both `i.imgur.com`
   images already published. `verify-artifact --ids 104317036098,125172044513`.
3. External hosts: 40 missing (36 imgur, 2 memegenerator, 1 cubeupload, 1
   giphy); the imgur URLs sampled so far return empty CDX. Test the
   `<id>` prefix (all extensions) form with retries before declaring gaps.
4. CDX has been intermittently returning status 000 (no HTTP answer) in bursts;
   this is transient transport, not a throttle. Retry with backoff.

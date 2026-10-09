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
| Published images (per-tag max; includes same-byte aliases) | **331** |
| Positive posts (image_count > 0) | 192 |
| Distinct recovered SHA-256 among post image entries | **206** |
| Recovered image entries (incl. size aliases) | 330 |
| Posts parsed / recovered | 1691 / 191 |

Crawl-state pointer: `data/checkpoint.json`, tag `crawl-state`
(see that file for the current manifest digest). Refresh the pointer with
`python3 -m recovery.cli checkpoint` after new bulk state.

## 21-335 result: +2 unique verified hashes via listing -> new-stem pipeline

The pipeline that still yields bytes: **fetch-listings (tagged snapshots) ->
new URL forms -> stem-scan -> stem hits -> fetch-images --only-stem-hits ->
publish -> anonymous verify.**

* Fetched the remaining ~120 never-done `/tagged/*` snapshots (one per URL) plus
  60 extra tagged snapshots (`--all-captures`). 0 new posts, but ~33 new stems.
* `stem-scan` found 2 hits: `31.media.tumblr.com/.../tumblr_mha05fsSdy...`
  (20140111020130) and `24.media.tumblr.com/tumblr_lznlsneKf7...`
  (20140111015910).
* Recovered + published + anonymously verified:
  * post `41595764733` sha256 `ae4d2cc2...` (1 image)
  * post `17894899534` sha256 `b891a3ba...` (1 image; first replay got a
    transient `connection refused`, a direct curl + targeted retry succeeded)
  * posts `60159692969` (2 images, 19/19) and `85809261273` (1 image, 17/17)
    now have passing anonymous receipts (the old receipt was stale).
* Also closed 3 pending publications: `18502938203` (4 imgs), `20110924434`
  (3), `20533834645` (identical, skipped).

## Durable negative evidence (do not repeat)

* All unresolved-image stems are answered; 0 unanswered index questions. The
  previously productive "unasked stem pool" is exhausted.
* Alternate-shard **old-style** forms (no md5dir) and the no-shard
  `media.tumblr.com/<md5dir>/tumblr_<key>` form: 0 hits on ~18 sampled keys.
* `/tagged/*` listing surface is now exhausted (one capture per URL done);
  extra snapshots taper to ~1 new stem per 60 fetches.
* CDX for a gap stem returns 0 rows even without the `statuscode:200` filter,
  so redirect captures are not hiding bytes.
* `hazfalafel.com/api/read/json` and `/sitemap` are not archived.

## Known correctness item (not yet repaired)

* 15 `post_other` listing rows have a foreign blog post id as `post_id` while
  `listing_url` is the hazfalafel container `/post/<id>`; none carry images, so
  no wrong bytes were published. Repair should attribute to the container id.

## Known baseline test failure (disclosed, not fixed)

`recovery.tests.test_crawler.HostInventoryEvidenceTests.test_complete_scan_confirms_gap_without_any_cdx_query`
errors `KeyError: 'host_inventory'` (fixture missing `resume_key_walk=True`,
reverted per instruction). 79/80 pass.

## Next work

* Continue the listing -> stem pipeline on the remaining listing captures
  (`--all-captures` over `archive`/`page`/`mobile` snapshots) in bounded units;
  ~1 new verified image per ~60-120 listing requests.
* When a stem hit's replay gets a transport failure, retry the exact capture
  directly (curl proved the bytes exist) before re-discovering it.
* Prefer this pipeline over re-audits; checkpoint `crawl-state` after each batch.

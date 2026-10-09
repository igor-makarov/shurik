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

Only if no `crawl-state` tag exists, bootstrap from Git history (ignored files,
not to recommit):

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

## Current counts (derived from `data/published.jsonl`: max `image_count` once per post id)

| Metric | Value |
| --- | ---: |
| Published images (per-tag max; includes same-byte aliases) | **272** |
| Positive posts (image_count > 0) | 185 |
| Distinct recovered SHA-256 among post image entries | 196 |
| Posts parsed / recovered | 1690 / 180 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | 6975 (162 with captures) |
| Pending stem questions | 0 |
| Unresolved media base keys (posts/ images) | ~1998 |
| Listing captures done / total | 2480 / 6311 |

Crawl-state checkpoint pointer: `data/checkpoint.json`, tag `crawl-state`,
manifest `sha256:ba7f02f4b097ca710923757431d72f7b00b8ab4684202f144ac49698c68914c1`,
layer bytes 4,979,431 (2026-10-09T11:06Z).

## 20-329 result: +13 published (259/180 -> 272/185), 12 tags anonymously verified

* Answered **all 400 pending stems** (host-priority order by measured hit rate).
  9 new stem hits; `fetch-images --method stem --only-stem-hits` recovered 13
  images across 12 tags; every tag passed anonymous `verify-artifact` (17-25
  checks each). Committed and checkpointed.
* Then `fetch-listings --limit 60` (archive,tagged,other) added 239 url_forms,
  **4 new posts**, but only **30 new stems -> 0 hits**: listing discovery is
  tapering. Do not spend a pass on broad listings without a new angle.

## Falsified / negative evidence from 20-329 (keep)

* **Alternate-shard modern forms are not archived.** For 8 unresolved media
  keys seen on one shard only, querying the other 19 shards' modern forms
  (`<shard>.media.tumblr.com/<md5dir>/tumblr_<key>`) gave **0 hits / 152 CDX
  requests** (`/tmp` probe, not committed). The stem-prefix miss is a real,
  shard-wide gap, not a missing-URL-form artifact. Do not re-run this sweep.
* Host dump / xshard old-style scan already covers the remaining shards; the
  504 hosts (24,25,27,30,64,66,media) are too large to enumerate server-side.
* Availability sweep: 915 `gap`, 17 `hit`; all 17 hits already recovered.

## Known correctness item (not yet repaired)

* `data/cdx/listing-posts.jsonl` has **33 `post_other` records whose `post_id`
  is a foreign blog's post id** (e.g. `unicornpoopish`, `godzy`, `yitzhakofeir`)
  while `listing_url` is a hazfalafel `/post/<id>`; 18 carry images. They
  created phantom `listing_only` records (e.g. 19000835176) but **no wrong
  bytes were published** (none of those ids have published image entries).
  Repair must attribute reblog media to the *container* hazfalafel post
  (`listing_url` id) and keep the source evidence; do not discard genuine
  reblog media.

## Known baseline test failure (disclosed, not fixed)

`recovery.tests.test_crawler.HostInventoryEvidenceTests.test_complete_scan_confirms_gap_without_any_cdx_query`
errors `KeyError: 'host_inventory'` because the fixture is missing
`resume_key_walk=True` (reverted per instruction). 79/80 pass; run with
`python -m unittest recovery.tests.test_crawler`.

## Next work

* Listing discovery is near-saturated; prefer **new** angles: parse every
  capture of a post page (2473 captures for 1186 posts) for shard forms the
  chosen capture lacked, and re-run `merge-images`/`repair` offline to surface
  images the parser missed.
* If a post page capture (pre-cutoff) exists at a **different timestamp** than
  the parsed one, re-parse it: Tumblr serves the then-current shard, so a 2017
  capture of a 2015 post can reveal a shard form whose CDX prefix answers.
* Keep the pipeline moving in bounded foreground units and checkpoint after
  each batch. Publish promptly; verify new tags only.

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

## Crawl-state checkpoint (new in 6-83)

`recovery/state_checkpoint.py` pushes `data/posts`, `data/cdx`,
`data/image-queue.json`, `data/missing.jsonl` and `data/gaps.jsonl` as one gzip
tar layer under the `crawl-state` tag and writes the committed pointer
`data/checkpoint.json` (schema version + manifest digest).

```sh
python3 -m recovery.cli checkpoint          # push, then write the pointer
python3 -m recovery.cli checkpoint --pull   # anonymous pull back into the tree
```

It is internal crawl state: not a recovered post and not progress toward image
recovery. Recovered bytes never go there -- they go into the numeric post tags,
which is why every `fetch-images` pass publishes on recovery.

On a fresh runner restore the checkpoint first; only if no `crawl-state` tag
exists, bootstrap from Git history (restores ignored working files, not files to
recommit):

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

## Current counts

Derived from `data/published.jsonl` (max `image_count` once per post id) and
`python3 -m recovery.cli status`.

| Metric | Value |
| --- | ---: |
| Discovered / parsed posts | 1186 / 1171 |
| Distinct Tumblr photo identities | 1474 (2227 image URLs) |
| Published images (deduplicated, max per tag) | **82** across 53 image-bearing tags |
| Posts recorded published (metadata-only tags included) | 741 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | 1689 stems (25 with captures, all recovered) |

Iteration 7-95: `--method stem --retry-missing` over 300 previously settled
posts recovered **14 images in 7 posts** (each published immediately and
verified anonymously, 20/20 checks per tag): 16809999572, 16881301957,
17269876288, 18244186719, 18502938203, 18859742391, 23113407036.
`--retry-missing` is what opens the settled pool: without it the pass reports
`no_work_left` for 786 posts and only ~300 remain eligible.

## Negative evidence worth keeping (7-95)

* **CDX host wildcards are silently empty.** `url=*.media.tumblr.com/<stem>`
  and `url=*.tumblr.com/<stem>` answer `200` with **zero rows even for a
  control stem known to have a pre-cutoff capture**, so they are false
  negatives, not evidence. Do not use them (`scripts/wildcard-host-probe.py`).
* **Cross-shard copies do not exist for our photos.** The control photo
  `40.media.tumblr.com/acd66e1322aeb10e0ec13ae1659eae09/tumblr_o07sizvpqP1r3it8zo1`
  was asked on 18 `NN.media.tumblr.com` shards: only shard 40 answers. 18
  queries per photo for zero hits is a dead end.
* **No pre-2012 captures of the blog itself.** `hazfalafel.com/post/` holds
  1562 captures, all 2012-2019 (2017: 761, 2012: 226, 2016: 222, 2019: 149,
  2015: 69, 2013: 61, 2018: 47, 2014: 27); `hazfalafel.tumblr.com` has none
  at all. Pre-2013 posts are only visible through the 2016+ theme pages, whose
  image URLs are the modern `<hash>/tumblr_*` form -- which is also the only
  form the archive captured. Alternate permalink forms of old posts therefore
  cannot surface older image URLs.
* Stem answers so far: 18 of ~1040 stems returned captures (~2%), all on
  shards 40/24/41/78/28/25.

## Archive behaviour observed in 6-83

* `https://web.archive.org` answered normally the whole iteration (CDX and
  replay), so the plain-HTTP downgrade in `recovery/http.py` was not needed.
* `--method stem` (one CDX prefix query per image, covering every size and
  extension sibling) is the productive method: 220 posts over four passes
  recovered **20 images**, every one of them published inside the same pass and
  anonymously verified afterwards (12/12 tags, 20/20 images, byte-level).
  Yield is ~9% of images, far above earlier "3 hits per 195 stems" notes --
  those older passes concentrated on hosts/pools that answer `[]`.
* Re-posts that already existed were only re-published when the recovered image
  count grew (`images 2>-1`), so no duplicate versions were created.

## Next work

Keep running bounded `python3 -m recovery.cli fetch-images --method stem
--retry-missing --limit N --concurrency 2` passes over the posts with
unresolved images (the queue orders by fewest attempts, so untouched posts come
first), publishing on recovery, then re-push the `crawl-state` checkpoint and
`verify-artifact` the new tags. Yield is ~4-5 images per 300 posts now, so the
passes are worth batching: 758 posts still had work when the 7-95 batch
started, and ~430 photo identities still have no stem answer.

Known weak spots: posts 13833997906-14996000761 (2010-2011,
`27.media.tumblr.com` style) answered HTTP 404 on every size/extension variant;
that verdict is scoped to those exact URLs only.

Checkpoint digest at the end of 11-241: `crawl-state`
`sha256:799104c2cff12199e66244ac17378751ce2bb4e68b35f1b01d48d7a8d956ead2`
(pointer `data/checkpoint.json`; `python3 -m recovery.cli checkpoint --pull`
restores `data/posts`, `data/cdx` and the queue/ledgers; pull-verified
`restored:true`, digest match). 11-240 digest was
`sha256:f6726ce72fb27e2f4eb0f705b830b3893fb681ef68a15855fe567909ba4c11e8`.

## 11-241 result: listing mining works (15 new posts, 69 new image forms), 0 new bytes yet

Baseline recomputed from `data/published.jsonl` (max image_count per post_id):
**82 images across 53 image-bearing tags**, unchanged; tag 136316699428
re-verified anonymously (20/20). `status`: 1171 parsed, 2214 missing images,
5402 ledger rows, 741 published flags.

* `fetch-listings --limit 5 --kinds archive` (5 replay requests): **5/5 fetched,
  15 new post records (1156 -> 1171), 71 posts touched, 69 images added** as
  `_250` listing variants on hosts 65/66/67.media (`listing:attr:div`). 55 of
  the touched posts still have 0 recovered images -- the prize pool. 4 new
  posts are listing-only (no permalink text: 123461272893, 125449314948,
  68689386519, 68867064030). `_250` entries are separate byte renditions, not
  duplicates, but same-photo/different-size layers share one provenance family.
* `stem-scan --limit-stems 70`: the 67 brand-new listing stems **all answered,
  0 hits** (index 1622 -> 1689 answers, still 25 hit stems). Honest negatives
  scoped to those exact prefixes. Archive CDX healthy (no transport failures).
* `fetch-images --method probe --retry-missing` over 10 listing-touched
  zero-recovery posts: **0 recovered**. First posts answered genuine 404s
  (new `archive_gap` rows with 5 answered probes each -- real verdicts, not
  misclassified throttles); then the replay endpoint gave **real 429s** and the
  circuit breaker deferred the last 4 posts unsent (no attempt spent, queue
  place kept, global cooldown to 12:30:20Z). Throttle honored, not relabeled.
* Concrete next experiments (not yet tried): **cross-scheme probes** --
  `_variants()` keeps the URL scheme, so http 404s say nothing about the https
  form and vice versa (permalink `https://66...` vs listing `http://66...`);
  and continue listing mining -- 3524 archive/tagged captures remain, each
  5-page batch yielded 15 new posts + ~67 new stems last time. Keep batches
  small (<=5 listings, then stems, then <=10 probes) with cooldown gaps: the
  67-CDX + 5-replay + 10-probe burst in one pass is what tripped the 429s.

## 11-240 result: settled pool now yields 0; known-URL stem search is exhausted

Baseline recomputed from `data/published.jsonl` (max image_count per post_id):
**82 images across 53 image-bearing tags** (741 tags total); unchanged this pass.
Post 136316699428 from the prompt feedback is already published AND anonymously
verified (2 layers, both 87458 bytes, SHA-256 `f97320c1...`, manifest
`b6abea7d...`): the lost-probe bytes were re-recovered by a later iteration,
not still missing. Note its two layers hold identical bytes (`_500` and `_1280`
share one capture) -- count once when measuring unique bytes.

Two bounded stem passes `--method stem --retry-missing --limit 150
--concurrency 2` over settled posts: **0 recovered, ~200+202 missing,
0 transient** each. `stems.jsonl` grew by only 1 row across 300 posts: the
stem index now short-circuits nearly every query with a recorded empty answer,
so re-running settled posts replays known negatives instead of sending CDX
requests. Stop spending passes here without a new question.

Offline stem census (crawler `stem_prefix` keys): 1656 distinct post stems vs
1622 recorded answers; the 34 never-asked stems all sit on already-resolved
images. All 25 hit stems are recovered/published. The stem-prefix search over
known URLs is therefore exhausted.

Targeted experiments (bounded, gentle -- an 8-request no-delay ad-hoc script
caused `connection refused`; keep >=2s interval, the crawler already does):
* Non-200 CDX scope test on 8 unresolved stems: 1 genuine any-status negative
  (`68.media.../tumblr_mdulie0AAa1r3it8zo1` -> 0 captures), rest inconclusive
  (self-inflicted refusals). No redirect-only captures found.
* Cross-shard check: 6 unresolved `_1280` URLs (posts 104677118808,
  124926471278, 124827091178, 125258061218, 125172044513, 124243597613) share
  a hash/basename with an already-recovered `_500` capture on a sibling shard.
  Copying those bytes across sizes would fabricate provenance (no pre-cutoff
  `_1280` capture exists) and duplicate-count one capture -- recorded as
  not-recoverable, not attempted.

Next opportunity: new image *identities*, not new queries for old ones --
re-mine listing/tag/month/AMP/photoset captures for image URLs absent from the
permalink parses (only avatars found so far, correctly excluded), or find
posts whose captures were never parsed. Per-pass re-querying of answered stems
is spent.

## 9-206 result: untouched pool yielded 0

Resumed from the 7-95 checkpoint (82 images / 53 tags). One bounded stem pass
`--method stem --retry-missing --limit 300 --concurrency 2` over the
fewest-attempts (untouched) posts: **0 recovered, 658 missing, 0 transient**;
`stems.jsonl` grew 1040 -> 1621 answers, so the CDX requests were really sent --
the untouched pool is simply low-yield. `remaining_with_work: 749`,
`posts_with_work: 1049`. Next: vary the pool (7-95 got 14 from 300 *settled*
posts) or target `data/cdx/stems.jsonl` stems whose answer was an empty `[]`
but whose sibling variants were never asked.

Service note kept from earlier iterations: `web.archive.org` occasionally
answers a CDX request with a `200` "Temporarily Offline" HTML page;
`cdx_query` turns an unparseable body into `http_error` (transient), so a
degraded CDX answering `[]` would be indistinguishable from a real negative --
keep an eye out for it.

Test suite: 112 offline tests, dummy credentials, mocked transport.

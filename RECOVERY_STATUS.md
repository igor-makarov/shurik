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

## Current counts (derived: max `image_count` once per post id in `data/published.jsonl`)

| Metric | Value |
| --- | ---: |
| Published images (per-tag max; includes same-byte aliases) | **217** across 157 image-bearing tags |
| Distinct recovered SHA-256 among post image entries | 166 (of 218 entries) |
| Posts parsed / recovered | 1611 / 157 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | 5316 stems (137 with captures) |
| Pending stem questions | 1 (one 429 in the 19-315 pass; re-ask next pass) |

## 19-315 result: selection-side stem-hit repair -> +16 published images (201/147 -> 217/157)

`stem-scan --dry-run` reported **49 unanswered stems** (the "pending 0" claim was
stale again). Answering all 49 cost 49 requests (48 answered, 1 real 429) and
returned **0 hits** -- the pool had been picked clean by 19-314, so this pass was
not a source of new bytes. The bytes came from the *already recorded* stem hits:
24 unresolved images across 24 posts had a live stem capture that had never been
downloaded.

`fetch-images --method stem --only-stem-hits` recovered 12 of them immediately.
The other 4 (`44471188889, 104860741473, 70476601245, 69400236197`) were reported
`no_work_left`: their exact URL already carried a terminal archive_gap/bad_body,
and `ImageQueue.select` filtered them out **before** the stem-hit override inside
the work loop could run. **Repair:** `fetch_images` now passes a `stale_fn` that
also returns True for `image_stem_hit()` (any URL form with a recorded capture),
so the selection keeps stem-hit images. Re-run recovered all 4; regression test
`StemHitSelectionTests` fails on the pre-fix code and passes now.

One publish was blocked by a stale duplicate: post 44471188889's listing-derived
`_250.jpg` entry pointed at the same capture as its `_500.jpg` entry but held an
old 133949-byte digest whose blob was gone, and the archive now serves 413122
bytes for that capture. `ensure_blob` refused the changed digest and deferred the
whole post, losing the newly recovered bytes. Recovered the old bytes with
`restore --ids 44471188889` (anonymous pull of the published image layer), then
republished: 2 images, 21/21 anonymous checks.

All 12 new/updated tags passed anonymous `verify-artifact` (16-25 checks each).
Totals: 201/147 -> **217/157** published images; distinct SHA-256 155 -> 166.

Lesson: after a stem-scan pass, the *recorded* hits (not new hits) are the pool;
and a stem hit must survive `ImageQueue.select`, not just the work loop. Check
`fetch-images --method stem --only-stem-hits --dry-run` for `no_work_left`.


## 19-314 result: the unasked-stem queue was the lever -> +23 images (201/147), 3 tags anonymously verified

The iteration opened with `stem-scan --dry-run` reporting **235 stems with no
recorded CDX answer** (RECOVERY_STATUS's "all stems answered / pending 0" claim
was stale). Two bounded passes answered all 235 (`--limit-stems 80` then the
remaining 155; every request sent, 0 failures, 0 deferred) for **33 stem hits
(14% hit rate, vs the ~2% figure the old notes quoted)**. `fetch-images --method
stem --only-stem-hits` converted them into **23 new published images across 24
tags** (178/123 -> 201/147); 3 of the new tags (60159692969, 84431586913,
91931326063) passed anonymous `verify-artifact` (16/16, 16/16, 17/17 checks).
Pending stems are now 0 again.

Lesson: before trusting "discovery exhausted", re-run `stem-scan --dry-run` and
count `scanning`. The unanswered pool regenerates whenever post records gain new
`url_forms` (listing/xshard/merge passes), and it is the highest-yield work
available. Do not spend a pass on replay probes of settled gaps while
`scanning > 0`.

## Earlier results (kept as evidence)

* 18-294: refetch plan (135 never-parsed amp/photoset captures) exhausted -> 5
  new published images; plan now empty, do not re-run without new captures.
* 7-95: `--method stem --retry-missing` over 300 *settled* posts recovered 14
  images in 7 posts. `--retry-missing` is what opens the settled pool.
* 12-245: `classify_exception` maps a refused TCP connection to TRANSPORT, not
  THROTTLED; only genuine 429/503 is throttled. Breaker trips on THROTTLED or
  refusal, resets on any answered HTTP status.
* 19-313: `--only-stem-hits` no longer skips a stem-index hit just because the
  exact URL has a terminal archive_gap/bad_body verdict, and a non-200 replay of
  a listed 200 capture is transient (HTTP_ERROR), not a permanent bad body.

## Negative evidence worth keeping

* **CDX host wildcards are silently empty** (`url=*.media.tumblr.com/<stem>`),
  false negatives even for a known capture. Do not use.
* **CDX regex filters over the whole `media.tumblr.com` domain 504.** A
  server-side `filter=original:.*<id>.*` cross-shard search times out; per-shard
  local matching (hostdump) is the only variant, and cross-shard copies are
  already falsified (0/308 for listing-only photos).
* **Cross-shard copies do not exist for our photos** (12-246: 308/308 gaps).
* **No pre-2012 captures of the blog itself.** `hazfalafel.tumblr.com` has zero
  captures; `icanhazfalafel.tumblr.com` has only 32 captures through the cutoff
  (2 real HTML: the 2011-11-30 root and 2012-01-01 `/about`), and the root's 8
  photo URLs are all already-known stems. Subdomain mining is closed.
* **Multi-`url=` CDX batching is unsupported**: the endpoint answers only the
  first `url=` parameter. `stem_scan` deliberately sends one request per stem.
* Stem answers so far: 136 of ~5200 stems returned captures (~2.6%), spread
  across shards 24/25/31/37/38/40/media.

## Next work

* `fetch-images --method stem --only-stem-hits` again once the 8 posts still
  cooling down (transient failures at 23:20-23:31) pass their `next_at`
  (~00:05-00:16 UTC): `59766150804, 59498762354, 85104509313, 85642342423,
  59473876847, 84338684458, 70476601245(?), 69503123440, 69088900531`.
* Re-run `stem-scan --dry-run` after any pass that adds `url_forms`.
* Then the slower levers: `fetch-images --method probe --retry-missing` on
  never-probed sibling forms, and `probe-availability` sweeps.
* Post 52151844735 has a listing-derived second image whose blob was never
  published; re-fetch its recorded capture and publish (its artifact is 1 image).
* Known weak spots: posts 13833997906-14996000761 (2010-2011, `27.media...`
  style) answered 404 on every variant -- scoped to those exact URLs only.
* `data/cdx/hostdump-cursors/68.media.tumblr.com.cursor.json` holds an
  unfinished resume-key host walk; its dump lives in `data/work/hostdumps/`
  (not checkpointed) so a fresh runner can resume the cursor but not re-match
  old rows offline.

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
| Published images (per-tag max; includes same-byte aliases) | **201** across 147 image-bearing tags |
| Distinct recovered SHA-256 among post image entries | 155 (of 202 entries) |
| Posts parsed / recovered | 1611 / 147 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | 5208 stems (136 with captures) |
| Pending stem questions | 0 |

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

* After any pass that adds `url_forms` (listing, xshard, merge-images,
  refetch-captures), immediately `stem-scan --dry-run`; if `scanning > 0`, answer
  those stems and convert hits -- that is where the bytes were this iteration.
* Then the slower levers: `fetch-images --method probe --retry-missing` on
  never-probed sibling forms, and `probe-availability` sweeps (uses the
  `archive.org` host, which stays usable during a `web.archive.org` refusal).
* Known weak spots: posts 13833997906-14996000761 (2010-2011, `27.media...`
  style) answered 404 on every variant -- scoped to those exact URLs only.
* `data/cdx/hostdump-cursors/68.media.tumblr.com.cursor.json` holds an
  unfinished resume-key host walk; its dump lives in `data/work/hostdumps/`
  (not checkpointed) so a fresh runner can resume the cursor but not re-match
  old rows offline.

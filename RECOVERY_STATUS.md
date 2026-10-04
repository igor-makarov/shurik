# Hazfalafel recovery status

Working branch state for loop `hazfalafel-20261004t213311`. Target package:
`ghcr.io/igor-makarov/shurik-hazfalafel-com`, tag = numeric Tumblr post ID, inclusive
capture cutoff `20191231235959`.

## Counts

Regenerate with `python3 -m recovery.cli status` (the numbers below are from the
iteration 2-11 checkpoint; the background daemon keeps moving them).

| Metric | Count |
| --- | --- |
| Posts discovered (CDX inventory) | 1186 |
| Post captures indexed | 2473 |
| Listing/tag/month captures indexed | 6048 |
| Post pages parsed | 615 (was 76) |
| Image URLs known | 976 |
| Images recovered | 0 |
| Images recorded missing | 976 |
| Artifacts published | 42 (was 0/2) |
| Posts discovered but not parsed | 571 |

## Reproducible commands

```sh
python3 -m unittest discover -s recovery/tests -t .       # 23 tests, offline
python3 -m recovery.cli discover --listings              # CDX inventory (resumable)
python3 -m recovery.cli fetch-posts --limit 40            # archived post pages
python3 -m recovery.cli discover-media                    # tumblr media host inventory
python3 -m recovery.cli fetch-images --limit 40           # image bytes + validation
python3 -m recovery.cli publish --limit 40                # per-post OCI artifact -> GHCR
python3 -m recovery.cli status
python3 -m recovery.cli report
```

`recovery/` must be run as a module (`python3 -m recovery.cli`); direct execution of
`recovery/cli.py` fails on relative imports.

`scripts/crawl-daemon.sh` runs those stages in a loop (pages -> media -> images ->
publish) with modest concurrency; `scripts/crawl-stage1.sh` is the one-shot version.
Every stage is resumable from committed state, so killing the daemon never loses work.

## Iteration 2-14

**The vertical slice is complete and public.** Anonymous (unauthenticated) pulls of
`ghcr.io/igor-makarov/shurik-hazfalafel-com` succeed and list **42 tags**, so no
maintainer visibility change is needed. Config labels were read back over the wire and
are correct, including `org.opencontainers.image.source =
https://github.com/igor-makarov/shurik` and intact Hebrew
(`org.opencontainers.image.description = למה אתם לא לסגור דלת בעדינות`). No further
package settings are required.

**Post-page crawl now advances.** The two defects fixed in 2-11 (image variant planning,
`fetch-posts` resume cursor) both hold up under load: one iteration took parsed posts
from 76 to 615 and published 42 artifacts. Nothing re-fetched an already-parsed post.

**Image recovery is the open problem, and the evidence now points at real archive gaps.**
976 distinct image URLs are known. Bounded probes this iteration:

| Query | Result |
| --- | --- |
| `24.media.tumblr.com/tumblr_lvcvvcirYk1r3it8zo1_500.jpg` (exact, pre-cutoff) | `[]` |
| `68.media.tumblr.com/tumblr_m7xx74aT7W1r3it8zo1_1280.jpg` (exact, pre-cutoff) | `[]` |
| `40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*` (prefix, whole hash dir) | `[]` |
| `40.media.tumblr.com` (domain) | thousands of rows, incl. `_1280.jpg` |
| `25.media.tumblr.com` (domain) | thousands of rows, incl. `_1280.jpg` |

The prompt's example post page *is* archived
(`/web/20150119072952id_/.../post/100403945458`, 66717 bytes) and *does* reference
`http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg`,
but neither that URL, nor any size/extension sibling, nor anything else in its hash
directory is archived. So the archive holds *some* Tumblr media for this site, but not
the files these post pages point at. These are **confirmed gaps** (CDX answered `200`
with zero rows), not timeouts or throttling.

Parsing correctly excludes avatars and theme art: 360 post-image URLs in the parsed
subset, 0 of them avatars.

### Operational lesson: serialize archive access

Running ad-hoc probes *while* the background crawl was running got me
`Connection refused` from `web.archive.org` within one iteration, and earlier runs got
HTTP 429 on nearly every media host (see `data/cdx/media.jsonl.manifest.json`, where 24
of the host entries record `"error": "throttled"`). `data/cdx/media.jsonl` is therefore
still empty. Probe and crawl must not overlap; the next iteration rebuilds the media
inventory as the only archive-bound step.

## Iteration 2-11

Two defects made the crawler *look* busy while recovering nothing. Both are fixed,
regression-tested and are the reason nothing had been published yet:

1. **Image variant planning never matched** (`recovery/parsing.py:parse_image_variants`).
   The regex was anchored at the start of `urlparse(url).path`, which always begins
   with `/`, so it returned the linked URL and nothing else. Every image was therefore
   resolved with exactly one CDX query (the exact URL), and a zero-capture answer was
   recorded as a confirmed `archive_gap` -- the archive often stores a different size
   (`_540`, `_1280`, `.gif`) of the same file. A second bug in the same function sliced
   the directory prefix out of `urlparse().path` indices against the full URL, which
   produced mangled candidates (`http://25.media.tumblr/htumblr_..._1280.jpg`) once the
   regex did match. Now matches the path basename, keeps the real prefix, and
   `recovery/images.py:image_capture_candidates` queries the exact URL first and only
   sweeps up to 4 size/extension siblings when the exact URL has nothing.
2. **`fetch-posts` had no resume cursor** (`recovery/cli.py:fetch_posts`). The "already
   fetched?" test read a nested `capture.timestamp` from capture records that store
   `timestamp` flat, so `have` was always `{None}` and every stored post looked pending.
   The daemon re-fetched the same 76 posts in a loop and never advanced to the other
   1110 discovered posts.

Evidence gathered this iteration:

- `data/cdx/listing.jsonl` inventories 6048 pre-cutoff captures of `/archive/`,
  `/tagged/` and `/post/` pages; `/post/` alone gives 1186 distinct post IDs
  (842 permalink-only, 253 permalink+amp, 43 permalink+photoset, 7 with no permalink
  capture at all). The 7 permalink-less posts need amp/photoset/listing evidence.
- Media host dumps (`data/work/media-dumps`, ephemeral) hold 19656 pre-cutoff rows for
  `24..30.media.tumblr.com`, of which 6766 are `tumblr_*` files. None of the 76 parsed
  posts' image keys matched, i.e. those exact CDN URLs are not in the host inventory.
- The prompt's example image
  `http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg`
  returns `[]` from the CDX with `to=20191231235959`: confirmed archive gap for that
  URL (its post page *is* captured). Recorded as evidence, not as a post-level failure.
- A CDX `matchType=domain` + `filter=urlkey:...` sweep over `media.tumblr.com` returned
  HTTP 504 after 60s, and a `matchType=prefix` query on a media host timed out at 100s.
  Whole-domain regex searches are therefore not used as a recovery method; the bounded
  per-URL and per-variant exact queries plus the host inventory are.

## Next iteration plan

1. Finish `fetch-posts` across the remaining ~571 posts (background, archive-bound).
2. Rebuild the media host inventory (`discover-media`) as the **only** archive-bound
   step, serially, hosts we actually reference: 78, 68, 67, 66, 24-31, media.tumblr.com.
   ~1 domain query per host answers "does any variant of this file exist?" locally and
   replaces ~5 exact CDX queries per image at ~22 s each. Persist it to
   `data/cdx/media.jsonl` so later iterations do not pay for it again.
3. `fetch-images --retry-missing` with the inventory loaded, then publish.
4. Use amp/photoset/listing captures for posts with no permalink capture.
5. Re-check the 4 image-less posts' neighbors before accepting a gap: a photoset frame
   or `/archive/YYYY/MM` thumbnail may reference a different host/size variant.

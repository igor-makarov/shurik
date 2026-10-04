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
| Post pages parsed | 76 |
| Posts with images | 76 |
| Images recovered | 0 |
| Images recorded missing | 76 |
| Artifacts published | 0 |
| Posts discovered but not parsed | 1110 |

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

1. Let the daemon advance `fetch-posts` across the remaining 1110 posts; it is the
   long pole (~0.7s/post at concurrency 2 once the resume cursor works).
2. Re-run `fetch-images --retry-missing` so every ledger gap reflects the variant sweep.
3. Publish the first artifacts as soon as one post has a recovered image; verify the
   package is public and linked to `org.opencontainers.image.source`.
4. Use amp/photoset/listing captures for the 7 posts with no permalink capture.

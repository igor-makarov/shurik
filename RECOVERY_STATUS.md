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
| Discovered / parsed posts | 1186 / 1156 |
| Distinct Tumblr photo identities | 1474 (2227 image URLs) |
| Published images (deduplicated, max per tag) | **82** across 53 image-bearing tags |
| Posts recorded published (metadata-only tags included) | 741 |
| Stem CDX answers recorded (`data/cdx/stems.jsonl`) | ~1040 / 1474 photos |

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

Checkpoint digest at the end of 7-95: `crawl-state`
`sha256:ad3cd4709b4185bef68eee02d552c3c2fa66a828f4e10c83ffdccec9c952c5bc`
(pointer `data/checkpoint.json`; `python3 -m recovery.cli checkpoint --pull`
restores `data/posts`, `data/cdx` and the queue/ledgers).

Service note kept from earlier iterations: `web.archive.org` occasionally
answers a CDX request with a `200` "Temporarily Offline" HTML page;
`cdx_query` turns an unparseable body into `http_error` (transient), so a
degraded CDX answering `[]` would be indistinguishable from a real negative --
keep an eye out for it.

Test suite: 112 offline tests, dummy credentials, mocked transport.

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

Derived from `data/published.jsonl` and `python3 -m recovery.cli status`; see
`git log` for the per-iteration deltas.

| Metric | Value |
| --- | ---: |
| Discovered / parsed posts | 1186 / 1156 |
| Known image URLs | 2227 |
| Published images (max `image_count` per tag, deduplicated) | see `data/published.jsonl` |
| Posts recorded published | ~740 |

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

Keep running bounded `fetch-images --method stem --concurrency 2` passes over
the posts with unresolved images (the queue orders by fewest attempts, so
untouched posts come first), publishing on recovery, then re-push the
`crawl-state` checkpoint. ~600 posts still have unresolved images; the largest
pools are `78.media.tumblr.com` (807 URLs), `68`/`66.media.tumblr.com`
(330/316) and `67` (140).

Known weak spots: posts 13833997906-14996000761 (2010-2011,
`27.media.tumblr.com` style) answered HTTP 404 on every size/extension variant;
that verdict is scoped to those exact URLs only.

Service note kept from earlier iterations: `web.archive.org` occasionally
answers a CDX request with a `200` "Temporarily Offline" HTML page;
`cdx_query` turns an unparseable body into `http_error` (transient), so a
degraded CDX answering `[]` would be indistinguishable from a real negative --
keep an eye out for it.

Test suite: 112 offline tests, dummy credentials, mocked transport.

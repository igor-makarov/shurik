# Hazfalafel recovery handoff

Bulk post metadata, inventories and image bytes live in GHCR
(`ghcr.io/igor-makarov/shurik-hazfalafel-com`, numeric post tags plus the
`crawl-state` checkpoint tag). Git keeps code, tests and compact records only:
`data/image-queue.json`, `data/missing.jsonl`, `data/gaps.jsonl`,
`data/published.jsonl`, `data/verification/*.json`.

## Current counts

Derived from local records (`python3 -m recovery.cli status`), 2026-10-05:

| Metric | Count |
| --- | ---: |
| Discovered posts | 1186 |
| Parsed posts | 1156 |
| Known image URLs | 2227 |
| Published images (max `image_count` per tag) | 35 across 25 posts |
| Recovered images in this working tree | 19 |
| Posts recorded published | 734 |
| Unrecovered images | ~2184 |

The local corpus is the bootstrap copy of `0924dd45a67e16a107c97c46b8c6282895cf6835`;
per-post image records recovered after that commit exist in their published
registry tags, not in this working tree.

## Archive connectivity (new evidence, iteration 4-66)

From this runner `https://web.archive.org` refuses the TCP connection on every
attempt (`curl` exit 7, 0 bytes), while `http://web.archive.org` answers the same
captures with 200 and the exact bytes (post 15577014830's image still hashes to
`44bc9b3d…6614e` over port 80). `archive.org/wayback/available` answers normally.

`recovery/http.py` therefore downgrades one request to plain HTTP when HTTPS got
no HTTP answer at all (never on a 429/503, which is real throttling), and does
so before classification so a refusal that plain HTTP answers never trips the
circuit breaker. Without it, every URL looked "throttled" and passes recovered
nothing.

Connection refusals still happen on port 80 as well, in bursts. Those are
transient, never evidence of an archive gap.

## Next work

`--method stem` (one CDX prefix query per image covering every size/extension
sibling) is the cheapest known discovery method: 40 old-host posts / 127 image
candidates cost one pass and yielded 3 images, all published and anonymously
verified (tags `104253295493` x2, `125258061218`). Continue with bounded
`fetch-images --method stem --retry-missing --concurrency 1` passes over posts
whose images are still unrecovered, preferring the old media hosts 24-41.

Probe-era evidence: old-style media hosts (24-41) and 2014-2015 hash-directory
media recover; posts 13833997906-14996000761 (2010-2011, `27.media.tumblr.com`
style) answered HTTP 404 on every size/extension variant and are recorded as
gaps for that exact scope only.

Not yet exploited: nothing cheap. A bulk `collapse=urlkey` CDX dump of a media
host (`scripts/hostdump.py`) is *not* a shortcut: these Tumblr hosts are shared
by every blog on the CDN, so `78.media.tumblr.com` alone indexes >80k URLs from
all blogs, unscoped. The stem prefix stays the scoped unit of work.

Scoped negatives worth keeping (they are evidence about those exact prefixes
only): stem queries over 195 image stems answered `200` with zero pre-cutoff
captures, 3 of which hit. `78.media.tumblr.com` (the largest pool, 807 of the
unrecovered URLs) yielded 0/54 on its first six posts; old hosts 24-41 yielded
3/127. `data/cdx/media.jsonl` is still empty.

Service note: `web.archive.org` answered one CDX request this iteration with a
`200` "Internet Archive: Temporarily Offline" HTML page. `cdx_query` turns an
unparseable body into `http_error`, which is in `TRANSIENT_CLASSES`, so such a
body is recorded as inconclusive rather than an archive gap. Keep watching for
it: a degraded CDX answering `[]` would look exactly like a real negative.

Bootstrap on a fresh runner, only when no `crawl-state` checkpoint is restored:

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

Test suite: 103 offline tests, dummy credentials, mocked transport.
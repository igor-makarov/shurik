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
| Recovered images (local records) | 16 |
| Posts with recovered images | 9 (11 recorded recovered in the queue) |
| Posts recorded published | 734 |
| Unrecovered images | 2211 |

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

Run bounded `python3 -m recovery.cli fetch-images --limit N --concurrency 1
--retry-missing` passes; recovered images are published to their numeric tag
immediately. Probe-era evidence: old-style media hosts (24-41) and 2014-2015
hash-directory media recover; posts 13833997906-14996000761 (2010-2011,
`27.media.tumblr.com` style) answered HTTP 404 on every size/extension variant
and are recorded as gaps for that exact scope only.

Bootstrap on a fresh runner, only when no `crawl-state` checkpoint is restored:

```sh
git archive 0924dd45a67e16a107c97c46b8c6282895cf6835 data/posts data/cdx | tar -x
```

Test suite: 103 offline tests, dummy credentials, mocked transport.
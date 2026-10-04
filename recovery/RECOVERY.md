# Hazfalafel recovery status

Generated 2026-10-04T21:10:39.073Z by `node recovery/cli.mjs report`. Archive cutoff: `20191231235959` (inclusive).

## Counts

| metric | value |
| --- | --- |
| discoveredCaptureRows | 1561 |
| discoveredPosts | 1185 |
| parsedPosts | 1 |
| postsWithContent | 1 |
| postsWithImages | 1 |
| resolvedImages | 0 |
| missingImages | 1 |
| missingPosts | 0 |
| publishedPosts | 0 |
| publishedComplete | 0 |
| publishedPartial | 0 |
| publishedImages | 0 |

## Reproducible commands

```sh
npm run recover:discover     # CDX inventory -> data/post-captures.jsonl
npm run recover:posts        # fetch + parse captured post pages
npm run recover:images       # resolve post images to archived bytes
npm run recover:publish      # build + push OCI artifacts (tag = post id)
npm run recover:report       # regenerate this file
npm run recover:run -- --limit 25
npm run verify               # typecheck + unit tests (failure cases)
```

## Published artifacts (latest 20)

| tag | images | expected | partial | caption chars | tags | capture | outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Outstanding gaps

| kind | post | url | outcome | attempts | next methods to try |
| --- | --- | --- | --- | --- | --- |
| image | 100403945458 | http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500 | archive-gap | cdx-exact-capture:archive-gap; cdx-host-prefix-sizes:archive-gap; cdx-variant-url:archive-gap | see data/missing.jsonl |

## State files

- `data/post-captures.jsonl` — CDX inventory rows (urlkey, timestamp, original, digest).
- `data/posts.jsonl` — parsed post records (content, tags, image list, capture provenance).
- `data/images.jsonl` — per-image capture provenance: resolved bytes hash, capture timestamp, method used, or gap outcome.
- `data/missing.jsonl` — append-only ledger of every post/image miss with attempts and errors.
- `data/methods.jsonl` — append-only method log (queries, replays, outcomes).
- `data/published.jsonl` — published artifact ledger (tag, digests, completeness).


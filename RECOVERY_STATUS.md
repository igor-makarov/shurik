# Hazfalafel recovery status

Working branch state for loop `hazfalafel-20261004t213311`. Target package:
`ghcr.io/igor-makarov/shurik-hazfalafel-com`, tag = numeric Tumblr post ID, inclusive
capture cutoff `20191231235959`.

## Counts so far

| Metric | Count |
| --- | --- |
| Posts discovered (CDX inventory) | 0 |
| Post pages fetched | 0 |
| Images recovered | 0 |
| Artifacts published | 0 |
| Posts/images recorded missing | 0 |

No `data/` inventory exists yet: iteration 1-2 wrote the crawler code but timed out
before the first successful discovery run. Nothing has been published to GHCR yet.

## Reproducible commands

```sh
python3 -m recovery.cli discover        # CDX inventory -> data/*.jsonl
python3 -m recovery.cli fetch-posts     # archived post pages -> posts + captions
python3 -m recovery.cli fetch-images    # per-image capture resolution + validation
python3 -m recovery.cli publish         # per-post OCI artifact -> GHCR
python3 -m recovery.cli status
python3 -m recovery.cli report
python3 -m unittest discover -s recovery/tests -t .
```

`recovery/` must be run as a module (`python3 -m recovery.cli`); direct execution of
`recovery/cli.py` fails on relative imports.

## Iteration 1-3 (this session)

- Added `.gitignore` rules so committed state stays small: `__pycache__/`, `*.pyc`,
  `data/captures/`, `data/blobs/`, `data/work/`. Inventories under `data/*.jsonl` stay
  committed so unpublished capture information survives the next ephemeral runner.
- Removed already-committed `recovery/**/__pycache__` from tracking.
- Fixed `recovery/images.py:image_capture_candidates`, which raised
  `TypeError: expected string or bytes-like object, got 'list'` on a leftover
  `urls = [image_url] + re.sub(r"^(.*)$", r"\1", [])` line. This unblocked all five
  `ImageRecoveryTests` errors.

## Remaining known failures (5 of 19 tests)

`python3 -m unittest discover -s recovery/tests -t .`

1. `ParsingTests.test_balanced_inner_html` — `inner_html(doc, "div", "copy")` returns `''`
   for `<div class="copy">a<div>b</div>c</div>`. The class matcher does not find the
   element, or the balanced-slice scan aborts on the first nested tag.
2. `ParsingTests.test_caption_comes_from_alt_without_invention` and
   `test_photoset_page_yields_every_photo` — Hebrew alt text arrives in *visual* (bidi
   display) order, e.g. captured `מלכט צזפכ צבדםול?` where the logical text is
   `מה זה שאני רואה?`. A bidi visual→logical normalization step is missing in
   `recovery/parsing.py`. This must be evidence-preserving: only reorder already-captured
   characters, never translate or normalize letterforms, and never "correct" text.
3. `ImageRecoveryTests.test_confirmed_gap_when_no_capture_exists` — an image whose CDX
   query returns zero pre-cutoff captures is recorded with `error == 'ok'` instead of
   the confirmed-gap marker. The gap classifier must only fire on an actual successful
   CDX response with no qualifying captures, never on timeout/throttling.
4. `ImageRecoveryTests.test_html_error_page_is_not_an_image` — an archived HTML error page
   served for an image URL is still being accepted; body validation must check magic
   bytes and reject non-image payloads.

## Next iteration plan

1. Fix the four defects above; require `python3 -m unittest discover -s recovery/tests -t .`
   to be fully green before touching the network.
2. Run `discover` (CDX `url=hazfalafel.com/post/*`, `to=20191231235959`,
   `filter=statuscode:200`) with modest concurrency, paginating via `page`/`limit` and
   resumable offset state; also inventory `/archive/YYYY/MM`, `/post/ID/amp` and
   `/post/ID/photoset_iframe/*` captures.
3. Publish a first vertical slice (one post end to end) to GHCR, then broaden.
4. Record every gap with method, URL, capture timestamp, outcome and error class
   (`archive_gap` vs `timeout` vs `throttled`).
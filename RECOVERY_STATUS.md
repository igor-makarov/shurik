# Hazfalafel recovery handoff

The loop was stopped by the maintainer after iteration 3-59. It remains stopped.
Main was merged into this branch, journals were moved to the control branch, and
compiled runner bundles were replaced with source commit references. The next
continuation will use the supervisor at `1675a657e95800f2379dc0c107e695ed716b2d87`.

## Last saved crawl counts

Computed from the corpus at `0924dd45a67e16a107c97c46b8c6282895cf6835`, before
removing bulk content from the current tree:

| Metric | Count |
| --- | ---: |
| Discovered posts | 1186 |
| Parsed posts | 1156 |
| Known image URLs | 2227 |
| Recovered images | 16 |
| Posts with recovered images | 9 |
| Complete / partial image-bearing posts | 6 / 3 |
| Posts recorded published | 734 |
| Unrecovered images | 2211 |

Most numeric tags contain metadata without images. These counters describe saved
records, not a new independent registry verification.

## Next work

Follow PROMPT.md: restore the prior corpus into ignored local files, implement the
minimal registry checkpoint/restore path for bulk state, and focus on additional
image recovery and anonymous byte-level verification. Full post content,
inventories and images belong in GHCR, with only compact queue, missing-method,
publication-digest and verification records in Git. The earlier Git corpus is
still recoverable from the commit above; repository history was not rewritten.

The prior archive-gap claims in this report were unreliable. Treat transport
failures as inconclusive and successful empty CDX queries as evidence only for
their exact scope. Reuse successful CDN URL forms and try other eligible images,
alternate post captures and listing/photoset evidence fairly. The nine existing
verification records are examples to preserve, not a reason to repeat the same
posts indefinitely.

## Existing crawler checks to repair

The 103-test crawler suite, with its declared dependencies installed, reported
three failing assertions and eight errors. Three errors were missing dummy
registry credentials: those registry plumbing tests pass when supplied fake
credentials and mocked transport. Remaining cases concern
AvailabilityIndex.AFTER_CUTOFF, prior_note retention, archive health/circuit
recovery, deferral counts, and an invalid requests exception in a test fixture.
These predate the storage cleanup. PROMPT.md directs Shurik to diagnose and fix
the relevant code or test defects while continuing actual image recovery.

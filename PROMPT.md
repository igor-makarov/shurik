# Nauka i Zhizn: all years and a GHCR master issue index

## Current assignment — explicitly expanded by the user

The user now requests ALL YEARS of the magazine, a master index of all issues on GHCR, and continued retrieval until 2026-10-08T07:00:00.000Z (10:00 Asia/Jerusalem on October 8). This replaces the former 1934-1939-only objective and its expired deadlines. The model remains opencode-go/deepseek-v4.1-flash, reasoning high, 1800-second iterations and 120-second cooperative checkpoints. Obey the supervisor's new absolute deadline; do not extend it yourself.

All task discovery, implementation, tests, origin retrieval and artifact publication must be performed by you inside this Shurik loop. Never read or reuse falafel code, artifacts or history. Leave supervisor/workflows, .shurik settings, ownership, dispatch, native journal bookkeeping and atomic work/control commits unchanged.

Start from the magazine archive navigation associated with:
https://publ.lib.ru/ARCHIVES/N/''Nauka_i_jizn'''_(jurnal)/_NiJ_1934-39_.html
and its magazine archive directory. Locate and traverse every available magazine year/era index and related issue page, including earlier and later years wherever the archive lists them. Do not retain a hard-coded 60-file stopping condition or the old year restriction. Stay within this magazine's archive and linked original magazine scan/archive resources; do not expand to unrelated publications, crawl unrelated sites, or OCR/convert the files.

The old NAUKA_STATUS.md saying "60/60" means only the completed 1934-1939 subset. It does NOT mean this new all-years assignment is complete.

## Preserve verified results and resume data

The existing 60 original files are fully published in ghcr.io/igor-makarov/shurik-nauka, totaling 2,311,630,290 bytes. Their immutable manifests and scan layer hashes/sizes have been independently checked, and saved worker full-pull SHA-256 receipts match all 60. Preserve all existing file IDs, publication references, original filenames and valid resume state. Do not redownload or repeatedly pull all 60 files.

Baseline work commit: af65e939ed127760c1df8c7b4bdca754a3a2a78c.
Existing 1934-1939 collection: sha256:e0a10a710784b433339b63e53ed068f1057aacba9144949821c20284a709a84d.
Existing completed-subset resume index: sha256:ea7e4bc0ff8b43b11ff06fa3ff1d68ff4522fc23c3a84910d4fe2ae1f361039d.

Merge new discoveries into durable state, deduplicating repeated source links and preserving published records. Distinguish issue identities from scan/file variants and combined issues; preserve original ZIP/DJV/PDF/etc. bytes. Do not silently replace validators, chunk layouts or publication receipts. A discovered issue with no retrievable scan is catalog metadata, not a completed download.

## Master index: publish early and keep it accurate

Canonical user-facing master index:
ghcr.io/igor-makarov/shurik-nauka:nij-master-index
Suggested all-years resume index:
ghcr.io/igor-makarov/shurik-nauka:nij-master-checkpoint

Implement and publish the master index early in this first expanded iteration, before bulk retrieval dominates the session. Do not wait until every scan is downloaded. It may begin as an explicitly provisional index while year-page discovery continues; never label it complete while magazine catalog pages remain unvisited. Continue expanding it until all archive-listed years/issues are inventoried.

The master index must let a reader find all discovered issues by year and issue number, including combined/special issues, with available file variants, source page/URL and original filename, truthful retrieval status, known sizes and SHA-256 hashes, and immutable per-file GHCR references for published originals. Include magazine/year coverage, source pages visited/pending/failed, discovery completeness, available issue and file totals, published/remaining totals, and generation/update metadata. Distinguish issues from files and known archive gaps from discovery failures. Do not invent absent months or downloadable scans.

Use JSON as the machine-readable entry point; include a readable catalog if useful. If the complete payload needs per-year shards, publish those on GHCR and reference their immutable digests from the master. Keep the master usable as a single entry point and include the existing 60 files. Preserve the old nij-1934-39-index as a correctly scoped subset; never relabel that old index as the all-years master.

After publication, fetch the master JSON artifact back by immutable digest and verify its bytes/hash and representative entries, including old published files and newly discovered years. Record the tag, immutable digest, counts, discovery-complete/provisional status and verification receipt in compact task status. The operator must be able to verify the index without pulling large scan blobs.

## First iteration and continued useful work

1. Read this revised assignment and compact saved task state. Explicitly acknowledge the scope change in your first reply. Record a small durable assignment/progress record under data/nauka/state showing scope "all-years", the new deadline, master tag, preserved 60-file baseline and discovery progress. Avoid rereading the full old history or doing general repository audits.
2. Adapt task discovery/merge and completion logic to all years. Use targeted fixtures for new catalog parsing, repeated links, preserving the existing published records and master-index status if those paths change; existing cancellation/cold-resume fixtures have already passed. Do not repeatedly rerun or redesign unrelated fixtures.
3. Publish the truthful provisional master promptly, then complete the year/issue inventory and update it. Do real durable work on catalog discovery, master publication and new scan retrieval, not disposable speed probes or a renamed old 60-file index.
4. Retrieve newly inventoried scans in bounded foreground batches, promptly publishing complete files and prioritizing nearly complete partials. Continue retrieval/publication after ordinary checkpoints. The full expanded discovery backlog remains in scope even when a batch focuses on selected files.
5. Keep compact status and small batch records: years/pages/issues/files discovered, discovery completeness, total and newly published files/bytes beyond the 60-file baseline, verified durable partial bytes, immutable master/checkpoint receipts, discarded transfer bytes if known, and concrete blockers/next actions. Refresh the master when catalog or durable publication progress changes.
6. If several batches save no new inventory, verified bytes or publication while work remains, diagnose the actual task blocker instead of repeating the same no-op command, audits or benchmarks. Respect origin cooldowns and save precise retry/resume evidence. Do not confuse a flat published count with a lack of useful durable partial progress.

## Retrieval and persistence constraints

Keep aggregate origin throttling at or below 512 KiB/s, request-start gap at least 2 seconds, bounded concurrency and Retry-After/exponential backoff with jitter. Apply the same conservative request discipline to catalog discovery. No unthrottled curl fan-outs or routine speed probes. Handle Range/If-Range, response length/range/validators and dropped connections correctly; never append a full 200 response to a partial or discard valid chunks on ordinary cancellation.

Retain the existing complete shutdown/drain protocol for requests, child processes and filesystem writers before returning from a tool. Use bounded foreground batches with a tool timeout that includes transfer plus durable cleanup. Admit requests only while enough time remains to finish useful chunks; do not leave orphan writers, background pipelines or timeout wrappers across checkpoints. The original checkpoint ENOENT lifecycle defect was repaired; preserve those fixes. Old GitHub "Internal Server Error" push failures were infrastructure failures, not origin failures; task code cannot repair GitHub and must not push competing work/control refs.

All original scans, chunks, staging, ORAS binaries/OCI directories, large archives and large catalog exports must stay out of work-branch history. Keep task data ignored; configured control checkpointPaths remain data/nauka/state and data/nauka/partials. Publish large useful data and original scans to GHCR, retain hash-validated chunk checkpoint receipts for cold resume, and keep only small useful source/docs in work commits. Never expose credentials or merge the PR.

# Nauka i Zhizn: all years and a GHCR master issue index

## Current assignment — explicitly expanded by the user

The user requests ALL YEARS of the magazine and a master index of all issues on GHCR. On October 8 the user explicitly authorized another FOUR HOURS after the previous deadline ("Run 4 hours more"). The new absolute deadline supplied by the supervisor/control.json is authoritative and replaces the expired 2026-10-08T07:00:00.000Z deadline and all earlier deadlines. The model remains opencode-go/deepseek-v4.1-flash, reasoning high, 1800-second iterations and 120-second cooperative checkpoints. Obey the supervisor's new absolute deadline; do not extend it yourself.

All task discovery, implementation, tests, origin retrieval and artifact publication must be performed by you inside this Shurik loop. Never read or reuse falafel code, artifacts or history. Leave supervisor/workflows, .shurik settings, ownership, dispatch, native journal bookkeeping and atomic work/control commits unchanged.

Start from the magazine archive navigation associated with:
https://publ.lib.ru/ARCHIVES/N/''Nauka_i_jizn'''_(jurnal)/_NiJ_1934-39_.html
and its magazine archive directory. Locate and traverse every available magazine year/era index and related issue page, including earlier and later years wherever the archive lists them. Do not retain a hard-coded 60-file stopping condition or the old year restriction. Stay within this magazine's archive and linked original magazine scan/archive resources; do not expand to unrelated publications, crawl unrelated sites, or OCR/convert the files.

The old NAUKA_STATUS.md saying "60/60" means only the completed 1934-1939 subset. It does NOT mean this new all-years assignment is complete.

## Four-hour continuation: resume useful retrieval immediately

At the preceding final saved boundary, work 15b89ae8ecc6c86aeb2570dfcb354b1baba3b154, 875 regular scan files were retrieved and published, totaling 9,777,993,649 bytes. All 875 immutable scan manifests match saved scan-layer hashes/sizes, and saved full-file pull hashes match. Preserve these results; do not redownload or re-audit them.

The archive-listed inventory is already complete: 87 listed years, 941 issue entries, 1,112 regular files and 5 supplementary archives. Of these, 237 regular files and all 5 supplementary archives remain; 187 issue entries have no published copy and 36 have some formats still missing. No complete-but-unpublished files were recorded. This is the continuation baseline, not a new stopping condition.

The master and resume indexes already exist:
- nij-master-index @ sha256:a0f883cee51a0f58e6d13ec5a9dc0aec0e2a219bc94fe948351896580c3654f1
- nij-master-checkpoint @ sha256:9249d0520178fc8710ec9626af90d2076bca1d5a968eeea405b47951052db805

Resume the five saved partials first where practical: nij-1949-n06-djv, nij-2010-n10-pdf, nij-1949-n06-pdf, nij-1949-n07-djv and nij-1971-n02-djv. Their GHCR chunk checkpoints contain 92,274,688 durable bytes (88 MiB), with per-chunk hashes in saved state. Restore and hash-validate the needed existing chunks before continuing. Selected control prefixes are fallback subsets, not the full durable partial total.

Acknowledge the authorized four-hour continuation and current supervisor deadline in the first reply and refresh the compact assignment record. Then promptly run bounded foreground retrieval/publication batches and keep the master/resume indexes accurate. Do not repeat completed inventory discovery, boot audits, broad history reads, disposable speed probes or fixture/test cycles without a concrete new failure. Ordinary checkpoints should be followed by more retrieval while time and work remain.

## Preserve verified results and resume data

The preserved original 1934-1939 subset consists of 60 files, fully published in ghcr.io/igor-makarov/shurik-nauka, totaling 2,311,630,290 bytes. Their immutable manifests and scan layer hashes/sizes have been independently checked, and saved worker full-pull SHA-256 receipts match all 60. Preserve all existing file IDs, publication references, original filenames and valid resume state. Do not redownload or repeatedly pull all 60 files.

Baseline work commit: af65e939ed127760c1df8c7b4bdca754a3a2a78c.
Existing 1934-1939 collection: sha256:e0a10a710784b433339b63e53ed068f1057aacba9144949821c20284a709a84d.
Existing completed-subset resume index: sha256:ea7e4bc0ff8b43b11ff06fa3ff1d68ff4522fc23c3a84910d4fe2ae1f361039d.

Merge new discoveries into durable state, deduplicating repeated source links and preserving published records. Distinguish issue identities from scan/file variants and combined issues; preserve original ZIP/DJV/PDF/etc. bytes. Do not silently replace validators, chunk layouts or publication receipts. A discovered issue with no retrievable scan is catalog metadata, not a completed download.

## Master index: publish early and keep it accurate

Canonical user-facing master index:
ghcr.io/igor-makarov/shurik-nauka:nij-master-index
Suggested all-years resume index:
ghcr.io/igor-makarov/shurik-nauka:nij-master-checkpoint

The all-years master is already published and the archive-listed inventory is complete. Keep it current as remaining originals and supplementary archives publish. Revisit catalog discovery only for a concrete missing-page or inventory error; do not restart the completed discovery pass.

The master index must let a reader find all discovered issues by year and issue number, including combined/special issues, with available file variants, source page/URL and original filename, truthful retrieval status, known sizes and SHA-256 hashes, and immutable per-file GHCR references for published originals. Include magazine/year coverage, source pages visited/pending/failed, discovery completeness, available issue and file totals, published/remaining totals, and generation/update metadata. Distinguish issues from files and known archive gaps from discovery failures. Do not invent absent months or downloadable scans.

Use JSON as the machine-readable entry point; include a readable catalog if useful. If the complete payload needs per-year shards, publish those on GHCR and reference their immutable digests from the master. Keep the master usable as a single entry point and include the existing 60 files. Preserve the old nij-1934-39-index as a correctly scoped subset; never relabel that old index as the all-years master.

After publication, fetch the master JSON artifact back by immutable digest and verify its bytes/hash and representative entries, including old published files and newly discovered years. Record the tag, immutable digest, counts, discovery-complete/provisional status and verification receipt in compact task status. The operator must be able to verify the index without pulling large scan blobs.

## Continued useful work

1. Read this continuation assignment and compact saved task state. Record scope "all-years", the current supervisor deadline, master tag and 875-file continuation baseline; acknowledge the continuation in your first reply.
2. Restore valid saved partial chunks, then retrieve remaining regular files and supplementary archives in bounded foreground batches. Publish complete originals promptly and retain hash-validated resume receipts.
3. Keep small batch/status records of newly published files/bytes, remaining issue/file variants, durable partial bytes, master/checkpoint immutable receipts and concrete blockers. Refresh the master when durable publication or resume progress changes.
4. If several batches save no verified bytes or publication while work remains, diagnose the concrete blocker rather than repeating no-op commands, audits or benchmarks. Respect origin cooldowns and preserve precise retry/resume evidence. Flat publication counts alone do not mean no useful durable partial progress.

## Retrieval and persistence constraints

Keep aggregate origin throttling at or below 512 KiB/s, request-start gap at least 2 seconds, bounded concurrency and Retry-After/exponential backoff with jitter. Apply the same conservative request discipline to catalog discovery. No unthrottled curl fan-outs or routine speed probes. Handle Range/If-Range, response length/range/validators and dropped connections correctly; never append a full 200 response to a partial or discard valid chunks on ordinary cancellation.

Retain the existing complete shutdown/drain protocol for requests, child processes and filesystem writers before returning from a tool. Use bounded foreground batches with a tool timeout that includes transfer plus durable cleanup. Admit requests only while enough time remains to finish useful chunks; do not leave orphan writers, background pipelines or timeout wrappers across checkpoints. The original checkpoint ENOENT lifecycle defect was repaired; preserve those fixes. Old GitHub "Internal Server Error" push failures were infrastructure failures, not origin failures; task code cannot repair GitHub and must not push competing work/control refs.

All original scans, chunks, staging, ORAS binaries/OCI directories, large archives and large catalog exports must stay out of work-branch history. Keep task data ignored; configured control checkpointPaths remain data/nauka/state and data/nauka/partials. Publish large useful data and original scans to GHCR, retain hash-validated chunk checkpoint receipts for cold resume, and keep only small useful source/docs in work commits. Never expose credentials or merge the PR.

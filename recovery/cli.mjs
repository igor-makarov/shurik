#!/usr/bin/env node
// Shurik hazfalafel recovery CLI.
//
//   node recovery/cli.mjs discover                 # CDX inventory of captured URLs
//   node recovery/cli.mjs posts [postId...]        # fetch + parse captured post pages
//   node recovery/cli.mjs images [postId...]       # resolve every post image to archived bytes
//   node recovery/cli.mjs publish [postId...]      # build + push OCI artifacts (tag = post ID)
//   node recovery/cli.mjs run --limit 25           # discover→posts→images→publish→report
//   node recovery/cli.mjs report                   # regenerate RECOVERY.md + data/summary.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, Recovery, ROOT } from './pipeline.mjs';
import { createRegistry, publishAll, publishPost } from './publish.mjs';
import { log, readJsonl, writeJson } from './lib/util.mjs';

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) flags.set(args[i].slice(2), args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
  else positional.push(args[i]);
}
const command = positional[0] ?? 'help';
const numericFlag = (name, fallback) => (flags.has(name) ? Number(flags.get(name)) : fallback);

function renderReport(recovery) {
  const summary = recovery.summary();
  const published = readJsonl(PATHS.published);
  const missing = readJsonl(PATHS.missing);
  const byPost = new Map();
  for (const row of missing) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), row]);
  const partials = published.filter((row) => row.partial);
  const lines = [];
  lines.push('# Hazfalafel recovery status');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} by \`node recovery/cli.mjs report\`. Archive cutoff: \`20191231235959\` (inclusive).`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  for (const [key, value] of Object.entries(summary)) lines.push(`| ${key} | ${value} |`);
  lines.push('');
  lines.push('## Reproducible commands');
  lines.push('');
  lines.push('```sh');
  lines.push('npm run recover:discover     # CDX inventory -> data/post-captures.jsonl');
  lines.push('npm run recover:posts        # fetch + parse captured post pages');
  lines.push('npm run recover:images       # resolve post images to archived bytes');
  lines.push('npm run recover:publish      # build + push OCI artifacts (tag = post id)');
  lines.push('npm run recover:report       # regenerate this file');
  lines.push('npm run recover:run -- --limit 25');
  lines.push('npm run verify               # typecheck + unit tests (failure cases)');
  lines.push('```');
  lines.push('');
  lines.push('## Published artifacts (latest 20)');
  lines.push('');
  lines.push('| tag | images | expected | partial | caption chars | tags | capture | outcome |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of published.slice(-20).reverse()) {
    lines.push(`| ${row.postId} | ${row.imageCount} | ${row.expectedImageCount} | ${row.partial ? 'yes' : 'no'} | ${row.captionLength} | ${row.tagCount} | ${row.captureTimestamp} | ${row.outcome} |`);
  }
  lines.push('');
  lines.push('## Outstanding gaps');
  lines.push('');
  if (missing.length === 0) {
    lines.push('None recorded yet.');
  } else {
    lines.push('| kind | post | url | outcome | attempts | next methods to try |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of missing.slice(-40).reverse()) {
      const attempts = (row.attempts ?? []).map((a) => `${a.method}:${a.outcome}`).join('; ');
      lines.push(`| ${row.kind} | ${row.postId} | ${(row.url ?? '').slice(0, 90)} | ${row.outcome} | ${attempts.slice(0, 200)} | see data/missing.jsonl |`);
    }
  }
  lines.push('');
  lines.push('## State files');
  lines.push('');
  lines.push('- `data/post-captures.jsonl` — CDX inventory rows (urlkey, timestamp, original, digest).');
  lines.push('- `data/posts.jsonl` — parsed post records (content, tags, image list, capture provenance).');
  lines.push('- `data/images.jsonl` — per-image capture provenance: resolved bytes hash, capture timestamp, method used, or gap outcome.');
  lines.push('- `data/missing.jsonl` — append-only ledger of every post/image miss with attempts and errors.');
  lines.push('- `data/methods.jsonl` — append-only method log (queries, replays, outcomes).');
  lines.push('- `data/published.jsonl` — published artifact ledger (tag, digests, completeness).');
  lines.push('');
  if (partials.length > 0) {
    lines.push(`> ${partials.length} published artifact(s) are **partial**: some of their images are still missing and are listed in artifact metadata under \`missingImages\`.`);
    lines.push('');
  }
  writeJson(join(ROOT, 'data', 'summary.json'), summary);
  writeFileSync(join(ROOT, 'RECOVERY.md'), `${lines.join('\n')}\n`);
  return summary;
}

async function main() {
  const recovery = new Recovery({
    concurrency: numericFlag('concurrency', 4),
    cdxConcurrency: numericFlag('cdx-concurrency', 2),
  });
  const registry = flags.has('repository') ? createRegistry({ repository: String(flags.get('repository')) }) : createRegistry();
  const dryRun = flags.has('dry-run');

  switch (command) {
    case 'discover': {
      const res = await recovery.discover();
      log(`discover added ${res.added} rows; posts=${recovery.inventoryPostIds().size}`);
      break;
    }
    case 'posts': {
      const res = await recovery.crawlPosts({ postIds: positional.slice(1).length ? positional.slice(1) : null, perPostCaptures: numericFlag('captures', 2) });
      log(`posts: ${JSON.stringify(res)}`);
      break;
    }
    case 'images': {
      const res = await recovery.crawlImages({ postIds: positional.slice(1).length ? positional.slice(1) : null });
      log(`images: ${JSON.stringify(res)}`);
      break;
    }
    case 'publish': {
      const ids = positional.slice(1).length ? positional.slice(1) : null;
      const results = ids
        ? await Promise.all(ids.map((id) => publishPost({ recovery, registry, postId: id, dryRun })))
        : await publishAll({ recovery, registry, dryRun, limit: numericFlag('limit', Infinity) });
      log(`publish results: ${results.length}`);
      break;
    }
    case 'run': {
      const limit = numericFlag('limit', 25);
      const postIds = positional.slice(1);
      if (!postIds.length) await recovery.discover();
      const targets = postIds.length ? postIds : [...recovery.inventoryPostIds().keys()].sort().slice(0, limit);
      await recovery.crawlPosts({ postIds: targets, perPostCaptures: numericFlag('captures', 1) });
      await recovery.crawlImages({ postIds: targets });
      await publishAll({ recovery, registry, postIds: targets, dryRun });
      break;
    }
    case 'report': {
      const summary = renderReport(recovery);
      log(`report: ${JSON.stringify(summary)}`);
      break;
    }
    case 'verify-package': {
      const manifest = await registry.pullManifest(flags.get('tag') ?? positional[1]);
      log(JSON.stringify(manifest, null, 2).slice(0, 4000));
      break;
    }
    default:
      log('usage: node recovery/cli.mjs <discover|posts|images|publish|run|report|verify-package> [--flags]');
  }
  if (flags.has('report')) renderReport(recovery);
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});

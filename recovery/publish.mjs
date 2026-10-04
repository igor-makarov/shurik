// Progressive, idempotent OCI publishing to GHCR. One tag per Tumblr post ID.
import { existsSync, readFileSync } from 'node:fs';
import { GhcrRegistry, buildArtifact } from './lib/oci.mjs';
import { PATHS } from './pipeline.mjs';
import { appendJsonl, isoFromTimestamp, log, readJsonl, sha256 } from './lib/util.mjs';

export const DEFAULT_REPOSITORY = `${process.env.GHCR_USERNAME ?? 'igor-makarov'}/shurik-hazfalafel-com`;

export function createRegistry({ repository = DEFAULT_REPOSITORY } = {}) {
  const [registryHost, ...rest] = repository.split('/');
  return new GhcrRegistry({
    registry: registryHost,
    repository: rest.join('/'),
    username: process.env.GHCR_USERNAME,
    token: process.env.GITHUB_TOKEN,
  });
}

/**
 * Publish only when the new artifact is at least as complete as what is already
 * published, so reruns can add images/metadata but never regress them.
 */
export function shouldPublish(existing, candidate) {
  if (!existing) return { publish: true, reason: 'new' };
  if (existing.metadataHash === candidate.metadataHash && existing.imageCount === candidate.imageCount) {
    return { publish: false, reason: 'unchanged' };
  }
  const regressions = [];
  if (candidate.imageCount < existing.imageCount) regressions.push('images');
  if (candidate.captionLength < existing.captionLength) regressions.push('caption');
  if (candidate.tagCount < existing.tagCount) regressions.push('tags');
  if (regressions.length > 0) {
    return { publish: false, reason: `would-regress:${regressions.join('+')}` };
  }
  return { publish: true, reason: candidate.imageCount > existing.imageCount ? 'more-images' : 'richer-metadata' };
}

export function loadImagesForPost(recovery, postId) {
  const post = recovery.posts.get(postId);
  if (!post) return [];
  return recovery
    .imageRecordsFor(postId)
    .map((record, index) => {
      if (!existsSync(record.cachePath)) return null;
      const source = post.images.find((image) => image.url === record.originalUrl);
      return {
        data: readFileSync(record.cachePath),
        mimetype: record.mimetype,
        originalUrl: record.originalUrl,
        captureTimestamp: record.captureTimestamp,
        captureUrl: record.captureUrl,
        strategy: record.strategy,
        caption: source?.alt ?? record.caption ?? '',
        alt: source?.alt ?? record.alt ?? '',
        layerPath: `images/${String(index + 1).padStart(2, '0')}-${record.sha256.slice(0, 8)}.${record.ext}`,
      };
    })
    .filter(Boolean);
}

export async function publishPost({ recovery, registry, postId, dryRun = false, createdAt }) {
  const post = recovery.posts.get(postId);
  if (!post) return { postId: String(postId), outcome: 'unknown-post' };
  const images = loadImagesForPost(recovery, postId);
  const missing = recovery.missingFor(postId);
  const expectedImageCount = post.images?.length ?? images.length;

  const artifact = buildArtifact({
    post: {
      ...post,
      expectedImages: expectedImageCount,
      missingImages: missing.map((m) => ({ url: m.url, outcome: m.outcome })),
      captureUrl: post.captureUrl,
      captures: post.captures ?? [],
    },
    images,
    createdAt: createdAt ?? isoFromTimestamp(post.captureTimestamp) ?? '2020-01-01T00:00:00Z',
  });

  const summary = {
    postId: String(postId),
    tag: String(postId),
    imageCount: images.length,
    expectedImageCount,
    captionLength: (post.captionText ?? '').length,
    tagCount: (post.tags ?? []).length,
    metadataHash: sha256(JSON.stringify(artifact.metadata)),
    configDigest: artifact.manifest.config.digest,
    manifestDigest: null,
    partial: images.length < expectedImageCount,
    missingImages: missing.map((m) => ({ url: m.url, outcome: m.outcome })),
    captureTimestamp: post.captureTimestamp,
    permalink: post.permalink,
    repository: registry?.repository ?? null,
  };

  const existing = readJsonl(PATHS.published).find((row) => row.postId === String(postId));
  const decision = shouldPublish(existing, summary);
  if (!decision.publish) {
    log(`publish skip ${postId}: ${decision.reason}`);
    return { postId: String(postId), outcome: `skipped:${decision.reason}`, ...summary };
  }
  if (dryRun || !registry) {
    log(`publish dry-run ${postId}: ${images.length} layers -> tag ${postId}`);
    return { postId: String(postId), outcome: 'dry-run', ...summary };
  }

  await registry.pushBlob(artifact.configBytes);
  for (const tar of artifact.layerTars) await registry.pushBlob(tar);
  const result = await registry.pushManifest(String(postId), artifact.manifestBytes);
  const record = {
    ...summary,
    manifestDigest: result.digest,
    decision: decision.reason,
    outcome: 'published',
    publishedAt: new Date().toISOString(),
  };
  appendJsonl(PATHS.published, record);
  log(`published ${registry.repository}:${postId} layers=${images.length} partial=${record.partial}`);
  return record;
}

/** Publish every post with usable content; failures are logged, never fatal. */
export async function publishAll({ recovery, registry, postIds = null, dryRun = false, limit = Infinity }) {
  const targets = (postIds ?? [...recovery.posts.keys()]).filter((postId) => {
    const post = recovery.posts.get(postId);
    if (!post) return false;
    return (post.images?.length ?? 0) > 0 || (post.captionText?.length ?? 0) > 0 || (post.captionHtml?.length ?? 0) > 0;
  });
  const results = [];
  for (const postId of targets) {
    if (results.length >= limit) break;
    try {
      results.push(await publishPost({ recovery, registry, postId, dryRun }));
    } catch (err) {
      log(`publish failed ${postId}: ${err.message}`);
      recovery.logMethod({ stage: 'publish', postId, outcome: 'error', error: String(err.message).slice(0, 300) });
      results.push({ postId: String(postId), outcome: 'error', error: String(err.message).slice(0, 300) });
    }
  }
  return results;
}

// Resumable recovery pipeline. Every stage appends JSONL to recovery/data so an
// interrupted run can resume without re-downloading what it already has.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePostPage, stripTags } from './lib/parse-post.mjs';
import { chooseCapture, imageStrategies, validateImageBody } from './lib/images.mjs';
import { OUTCOME, WaybackClient } from './lib/wayback.mjs';
import { CUTOFF, appendJsonl, assertPreCutoff, isoFromTimestamp, log, readJsonl, sha256 } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const DATA = join(ROOT, 'data');
export const CACHE = join(ROOT, '.cache');

export const PATHS = {
  postCaptures: join(DATA, 'post-captures.jsonl'),
  siteUrls: join(DATA, 'site-urls.jsonl'),
  posts: join(DATA, 'posts.jsonl'),
  images: join(DATA, 'images.jsonl'),
  missing: join(DATA, 'missing.jsonl'),
  published: join(DATA, 'published.jsonl'),
  methods: join(DATA, 'methods.jsonl'),
};

export const mkdirs = () => {
  for (const dir of [DATA, join(CACHE, 'posts'), join(CACHE, 'images')]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

/** Richness comparison: reruns must never replace better metadata with worse. */
export function postScore(post) {
  return (
    (post.images?.length ?? 0) * 1000 +
    (post.captionHtml?.length ?? 0) +
    (post.tags?.length ?? 0) * 50 +
    (post.captureUrl ? 20 : 0) +
    (post.postedOn ? 5 : 0)
  );
}

export function mergePost(oldPost, newPost) {
  if (!oldPost) return newPost;
  const keep = postScore(oldPost) >= postScore(newPost) ? oldPost : newPost;
  const other = keep === oldPost ? newPost : oldPost;
  return {
    ...other,
    ...keep,
    images: dedupeImages([...(keep.images ?? []), ...(other.images ?? [])]),
    tags: dedupeBy([...(keep.tags ?? []), ...(other.tags ?? [])], (tag) => String(tag.slug ?? tag).toLowerCase()),
    captures: dedupeBy([...(keep.captures ?? []), ...(other.captures ?? [])], (ts) => ts).sort(),
    // Keep the earliest confirmed capture as provenance and remember alternates.
    captureTimestamp: [keep.captureTimestamp, other.captureTimestamp].filter(Boolean).sort()[0] ?? null,
    mergedFrom: dedupeBy([...(keep.mergedFrom ?? []), ...(other.mergedFrom ?? [])], (v) => v).sort(),
  };
}

export const dedupeBy = (items, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

export function dedupeImages(images) {
  const byUrl = new Map();
  for (const image of images) {
    if (!image?.url) continue;
    const existing = byUrl.get(image.url);
    if (!existing || (image.resolved && !existing.resolved)) byUrl.set(image.url, { ...existing, ...image });
  }
  return [...byUrl.values()];
}

/** Load a JSONL file as a keyed map for resumable stages. */
export function loadKeyed(file, keyFn) {
  const map = new Map();
  for (const record of readJsonl(file)) {
    const key = keyFn(record);
    if (key != null) map.set(key, map.has(key) ? mergeRecord(map.get(key), record) : record);
  }
  return map;
}

function mergeRecord(oldRec, newRec) {
  return { ...oldRec, ...newRec, attempts: [...(oldRec.attempts ?? []), ...(newRec.attempts ?? [])] };
}

export class Recovery {
  constructor({ concurrency = 4, cdxConcurrency = 2, cache = CACHE, dryRun = false } = {}) {
    mkdirs();
    this.client = new WaybackClient({ timeoutMs: 60_000 });
    this.cdxLimiter = cdxConcurrency;
    this.concurrency = concurrency;
    this.cache = cache;
    this.dryRun = dryRun;
    this.posts = loadKeyed(PATHS.posts, (r) => r.postId);
    this.images = loadKeyed(PATHS.images, (r) => `${r.postId}|${r.originalUrl}`);
  }

  logMethod(entry) {
    appendJsonl(PATHS.methods, { at: new Date().toISOString(), ...entry });
  }

  noteMissing(entry) {
    appendJsonl(PATHS.missing, { at: new Date().toISOString(), ...entry });
  }

  /**
   * Stage 1 — inventory captured URLs. Cheap CDX queries, resumable by urlkey.
   */
  async discover({ limit = 0 } = {}) {
    const known = new Set(readJsonl(PATHS.postCaptures).map((r) => `${r.urlkey ?? r.original}|${r.timestamp}`));
    const queries = [
      { name: 'post-pages', query: { url: 'hazfalafel.com/post/*', collapse: 'urlkey', filter: 'statuscode:200', fl: 'urlkey,timestamp,original,statuscode,mimetype,digest,length' } },
      { name: 'amp-pages', query: { url: 'hazfalafel.com/post/*/amp', collapse: 'urlkey', filter: 'statuscode:200', fl: 'urlkey,timestamp,original,statuscode,mimetype,digest,length' } },
      { name: 'photoset-pages', query: { url: 'hazfalafel.com/post/*/photoset_iframe/*', collapse: 'urlkey', filter: 'statuscode:200', fl: 'urlkey,timestamp,original,statuscode,mimetype,digest,length' } },
      { name: 'tag-pages', query: { url: 'hazfalafel.com/tagged/*', collapse: 'urlkey', filter: 'statuscode:200', fl: 'urlkey,timestamp,original,statuscode,mimetype,digest,length' } },
    ];
    let added = 0;
    for (const { name, query } of queries) {
      if (limit && added >= limit) break;
      const res = await this.client.cdx({ ...query, to: CUTOFF });
      this.logMethod({ stage: 'discover', query: name, outcome: res.outcome, rows: res.rows.length, url: res.url });
      log(`discover ${name}: ${res.rows.length} rows (${res.outcome})`);
      for (const row of res.rows) {
        if (!/^\d{14}$/.test(row.timestamp ?? '')) continue;
        if (row.timestamp > CUTOFF) continue;
        const key = `${row.urlkey ?? row.original}|${row.timestamp}`;
        if (known.has(key)) continue;
        known.add(key);
        appendJsonl(PATHS.postCaptures, { source: name, ...row });
        added += 1;
      }
    }
    return { added };
  }

  /** Post ids seen anywhere in the CDX inventory (permalink, amp, photoset). */
  inventoryPostIds() {
    const ids = new Map();
    for (const row of readJsonl(PATHS.postCaptures)) {
      const m = /\/post\/(\d{6,})/.exec(row.original ?? '');
      if (!m) continue;
      const list = ids.get(m[1]) ?? [];
      if (!list.some((r) => r.timestamp === row.timestamp && r.original === row.original)) {
        list.push({ timestamp: row.timestamp, original: row.original, source: row.source, mimetype: row.mimetype, digest: row.digest, statuscode: row.statuscode });
      }
      ids.set(m[1], list);
    }
    return ids;
  }

  cachePath(ts, original) {
    const name = sha256(`${ts}|${original}`).slice(0, 24);
    return join(this.cache, 'posts', `${ts}-${name}.html`);
  }

  /** Stage 2 — fetch + parse captured post pages. */
  async crawlPosts({ postIds = null, perPostCaptures = 2 } = {}) {
    const inventory = this.inventoryPostIds();
    const targets = postIds ?? [...inventory.keys()].sort();
    const queue = [];
    for (const postId of targets) {
      const captures = (inventory.get(postId) ?? []).filter((c) => c.timestamp <= CUTOFF).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (const capture of captures.slice(0, perPostCaptures)) queue.push({ postId, ...capture });
    }
    const done = new Set();
    for (const post of this.posts.values()) for (const ts of post.captures ?? []) done.add(`${post.postId}|${ts}`);
    const pending = queue.filter((item) => !done.has(`${item.postId}|${item.timestamp}`));
    log(`crawlPosts: ${pending.length} capture fetches pending (${this.posts.size} posts known)`);
    let index = 0;
    const worker = async () => {
      while (index < pending.length) {
        const item = pending[index++];
        await this.ingestCapture(item);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return { posts: this.posts.size };
  }

  async ingestCapture({ postId, timestamp, original, source }) {
    const attempts = [];
    try {
      assertPreCutoff(timestamp, `post ${postId} capture`);
      const file = this.cachePath(timestamp, original);
      let html;
      if (existsSync(file)) {
        html = readFileSync(file, 'utf8');
      } else {
        const res = await this.client.fetchTextCapture(timestamp, original);
        html = res.body.toString('utf8');
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, html);
        attempts.push({ method: 'replay-id_', url: res.finalUrl, outcome: OUTCOME.OK, bytes: res.body.length });
      }
      const parsed = parsePostPage(html, { url: original, timestamp });
      if (!parsed) {
        attempts.push({ method: 'parse', url: original, outcome: 'not-a-post-page' });
        this.noteMissing({ kind: 'post', postId, url: original, captureTimestamp: timestamp, source, attempts, outcome: 'not-a-post-page' });
        this.mergePostRecord({ postId, captures: [timestamp], captureTimestamp: timestamp, permalink: `http://hazfalafel.com/post/${postId}`, images: [], tags: [], captionHtml: '', captionText: '', expectedImages: 0, parseNote: 'not-a-post-page' });
        return;
      }
      const captureUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
      this.mergePostRecord({
        ...parsed,
        postId,
        expectedImages: parsed.images.length,
        captureUrl,
        captureOriginalUrl: original,
        captureModifiedTimestamp: timestamp,
        captureRedirectedTimestamp: timestamp,
        captureSource: source ?? 'post-pages',
        captures: [timestamp],
        postHtml: extractPostHtml(html, parsed),
      });
      this.logMethod({ stage: 'crawl-posts', postId, captureTimestamp: timestamp, url: captureUrl, outcome: OUTCOME.OK, images: parsed.images.length, bytes: html.length, attempts });
    } catch (err) {
      const outcome = err.outcome ?? OUTCOME.ERROR;
      attempts.push({ method: 'replay', url: original, outcome, error: String(err.message).slice(0, 300) });
      this.noteMissing({ kind: 'post', postId, url: original, captureTimestamp: timestamp, source, outcome, attempts, error: String(err.message).slice(0, 400) });
      this.logMethod({ stage: 'crawl-posts', postId, captureTimestamp: timestamp, url: original, outcome, attempts });
    }
  }

  mergePostRecord(record) {
    const merged = mergePost(this.posts.get(record.postId), record);
    this.posts.set(record.postId, merged);
    appendJsonl(PATHS.posts, merged);
    return merged;
  }

  /** Stage 3 — resolve every post image to archived bytes, cache, and ledger. */
  async crawlImages({ postIds = null, maxPerPost = 12 } = {}) {
    const targets = (postIds ?? [...this.posts.keys()]).filter((id) => (this.posts.get(id)?.images?.length ?? 0) > 0);
    const pendingImages = [];
    for (const postId of targets) {
      const post = this.posts.get(postId);
      for (const image of post.images.slice(0, maxPerPost)) {
        const key = `${postId}|${image.url}`;
        if (this.images.has(key) && this.images.get(key).resolved) continue;
        pendingImages.push({ postId, image, near: post.captureTimestamp });
      }
    }
    log(`crawlImages: ${pendingImages.length} image lookups pending`);
    let index = 0;
    const worker = async () => {
      while (index < pendingImages.length) {
        const item = pendingImages[index++];
        await this.ingestImage(item);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return { resolved: [...this.images.values()].filter((i) => i.resolved).length };
  }

  async ingestImage({ postId, image, near }) {
    const attempts = [];
    const strategies = imageStrategies(image.url);
    for (const strategy of strategies) {
      try {
        const { captures, outcome, queryUrl } = await this.client.capturesFor(strategy.url);
        attempts.push({ method: strategy.method, url: strategy.url, query: queryUrl, outcome, captures: captures.length });
        if (!captures.length) continue;
        const pick = chooseCapture(captures, near);
        const replay = await this.client.fetchCapture(pick.timestamp, strategy.url, { modifier: 'id_' });
        const check = validateImageBody(replay.body, replay.contentType);
        if (!check.ok) {
          attempts[attempts.length - 1].download = { outcome: OUTCOME.BAD_BODY, reason: check.reason, contentType: replay.contentType, bytes: replay.body.length };
          continue;
        }
        const digest = sha256(replay.body);
        const cachePath = join(this.cache, 'images', postId, `${digest}.${check.ext}`);
        if (!existsSync(cachePath)) {
          mkdirSync(dirname(cachePath), { recursive: true });
          appendFileSync(cachePath, replay.body);
        }
        const record = {
          postId,
          originalUrl: image.url,
          resolved: true,
          requestedUrl: strategy.url,
          captureTimestamp: pick.timestamp,
          captureUrl: `https://web.archive.org/web/${pick.timestamp}id_/${strategy.url}`,
          strategy: strategy.method,
          strategyUrl: strategy.url,
          sha256: digest,
          bytes: replay.body.length,
          mimetype: check.mimetype,
          ext: check.ext,
          contentType: replay.contentType,
          caption: image.alt ?? '',
          alt: image.alt ?? '',
          cachePath,
          attempts,
          nearCapture: near,
        };
        this.images.set(`${postId}|${image.url}`, record);
        appendJsonl(PATHS.images, record);
        this.logMethod({ stage: 'crawl-images', postId, url: image.url, outcome: OUTCOME.OK, via: strategy.method, captureTimestamp: pick.timestamp, bytes: replay.body.length, sha256: digest });
        return record;
      } catch (err) {
        const outcome = err.outcome ?? OUTCOME.ERROR;
        attempts.push({ method: strategy.method, url: strategy.url, outcome, error: String(err.message).slice(0, 200) });
        if (outcome === OUTCOME.TIMEOUT || outcome === OUTCOME.THROTTLED || outcome === OUTCOME.TRANSIENT) break;
        if (outcome === OUTCOME.AFTER_CUTOFF) continue;
      }
    }
    const confirmedGap = attempts.every((a) => a.outcome === OUTCOME.ARCHIVE_GAP || a.outcome === OUTCOME.NOT_FOUND);
    const record = {
      postId,
      originalUrl: image.url,
      resolved: false,
      outcome: confirmedGap ? OUTCOME.ARCHIVE_GAP : (attempts.at(-1)?.outcome ?? OUTCOME.ERROR),
      caption: image.alt ?? '',
      attempts,
    };
    this.images.set(`${postId}|${image.url}`, record);
    appendJsonl(PATHS.images, record);
    this.noteMissing({
      kind: 'image',
      postId,
      url: image.url,
      outcome: record.outcome,
      confirmedGap,
      attempts,
    });
    this.logMethod({ stage: 'crawl-images', postId, url: image.url, outcome: record.outcome, attempts: attempts.length });
    return record;
  }

  imageRecordsFor(postId) {
    const post = this.posts.get(postId);
    if (!post) return [];
    return post.images
      .map((image) => this.images.get(`${postId}|${image.url}`))
      .filter(Boolean)
      .filter((record) => record.resolved);
  }

  missingFor(postId) {
    const post = this.posts.get(postId);
    if (!post) return [];
    return post.images
      .map((image) => this.images.get(`${postId}|${image.url}`))
      .filter((record) => record && !record.resolved)
      .map((record) => ({ url: record.originalUrl, outcome: record.outcome, attempts: record.attempts }));
  }

  summary() {
    const posts = [...this.posts.values()];
    const images = [...this.images.values()];
    const published = readJsonl(PATHS.published);
    const missing = readJsonl(PATHS.missing);
    const publishedByPost = new Map();
    for (const record of published) publishedByPost.set(record.postId, record);
    return {
      discoveredCaptureRows: readJsonl(PATHS.postCaptures).length,
      discoveredPosts: this.inventoryPostIds().size,
      parsedPosts: posts.length,
      postsWithContent: posts.filter((p) => (p.captionHtml?.length ?? 0) > 0 || (p.images?.length ?? 0) > 0).length,
      postsWithImages: posts.filter((p) => (p.images?.length ?? 0) > 0).length,
      resolvedImages: images.filter((i) => i.resolved).length,
      missingImages: images.filter((i) => !i.resolved).length,
      missingPosts: missing.filter((m) => m.kind === 'post').length,
      publishedPosts: publishedByPost.size,
      publishedComplete: [...publishedByPost.values()].filter((r) => !r.partial).length,
      publishedPartial: [...publishedByPost.values()].filter((r) => r.partial).length,
      publishedImages: [...publishedByPost.values()].reduce((sum, r) => sum + (r.imageCount ?? 0), 0),
    };
  }
}

export function extractPostHtml(html, parsed) {
  if (parsed?.postHtmlRange) return html.slice(parsed.postHtmlRange[0], parsed.postHtmlRange[1]);
  const start = html.search(/<div[^>]*class=["'][^"']*\bpost\b[^"']*["'][^>]*>/i);
  return start >= 0 ? html.slice(start, start + 40_000) : null;
}

export { stripTags, isoFromTimestamp, readJsonl, CUTOFF, OUTCOME, WaybackClient, appendJsonl };

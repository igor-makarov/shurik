// Minimal OCI artifact builder + GHCR registry client (no dependencies).
//
// Each Tumblr post becomes one OCI image artifact:
//   config  -> full post metadata (HTML/text/tags/captions/provenance) in Labels
//   layers  -> one tar layer per recovered image, each holding the image bytes
//              plus a UTF-8 `.caption.txt` sidecar (Hebrew preserved).
import { createHash } from 'node:crypto';
import { sha256 } from './util.mjs';

const BLOCK = 512;

function tarHeader({ name, size, type = '0' }) {
  const header = Buffer.alloc(BLOCK);
  const write = (value, offset, length) => {
    header.write(value.slice(0, length - 1), offset, length - 1, 'utf8');
  };
  write(name, 0, 100);
  write('000644\0', 100, 8);
  write('000000\0', 108, 8);
  write('000000\0', 116, 8);
  write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  write('00000000000\0', 136, 12); // deterministic mtime
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder
  header.write(type, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

/** Deterministic (reproducible) ustar tar archive. */
export function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    if (data.length > 8 * 1024 * 1024) throw new Error(`tar entry too large: ${entry.name}`);
    chunks.push(tarHeader({ name: entry.name, size: data.length }));
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

const jsonBlob = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export const MEDIA_TYPES = {
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  config: 'application/vnd.oci.image.config.v1+json',
  layer: 'application/vnd.oci.image.layer.v1.tar',
};

const SOURCE_URL = 'https://github.com/igor-makarov/shurik';

/**
 * Build the artifact for one post.
 * `post` is the parsed/recovered record; `images` are validated recovered files.
 */
export function buildArtifact({ post, images, createdAt, generator = 'shurik-hazfalafel-recovery' }) {
  const metadata = {
    schema: 'shurik.hazfalafel/post/v1',
    postId: post.postId,
    site: 'hazfalafel.com',
    blog: post.blogName ?? 'icanhazfalafel',
    permalink: post.permalink,
    originalUrl: post.permalink,
    capture: {
      timestamp: post.captureTimestamp,
      url: post.captureUrl ?? null,
      modifiedTimestamp: post.captureModifiedTimestamp ?? null,
      redirectedTimestamp: post.captureRedirectedTimestamp ?? null,
      waybackId: post.captureUrl ?? null,
      withinCutoff: post.captureTimestamp <= '20191231235959',
    },
    allCaptures: post.captures ?? [],
    postedOn: post.postedOn ?? null,
    title: post.title ?? null,
    tags: (post.tags ?? []).map((tag) => ({ name: tag.name, slug: tag.slug })),
    caption: {
      html: post.captionHtml ?? '',
      text: post.captionText ?? '',
      perImage: images.map((img) => ({ path: img.layerPath, caption: img.caption ?? null, alt: img.alt ?? null })),
    },
    content: {
      html: post.captionHtml ?? '',
      text: post.captionText ?? '',
      postBodyHtml: post.postHtml ?? null,
      description: post.description ?? null,
    },
    embeddedMedia: post.embedded ?? [],
    images: images.map((img) => ({
      path: img.layerPath,
      originalUrl: img.originalUrl,
      captureTimestamp: img.captureTimestamp,
      captureUrl: img.captureUrl,
      strategy: img.strategy ?? null,
      sha256: sha256(img.data),
      bytes: img.data.length,
      mimetype: img.mimetype,
      caption: img.caption ?? null,
      alt: img.alt ?? null,
      missing: false,
    })),
    missingImages: post.missingImages ?? [],
    recovery: {
      generator,
      cutoff: '20191231235959',
      recoveredAt: createdAt,
      methods: post.methods ?? [],
      notes: post.notes ?? null,
      partial: images.length < (post.expectedImages ?? images.length),
    },
    source: SOURCE_URL,
  };

  const config = {
    architecture: 'amd64',
    os: 'linux',
    created: createdAt,
    config: {
      Env: [],
      Labels: {
        'org.opencontainers.image.title': `hazfalafel post ${post.postId}`,
        'org.opencontainers.image.description': (post.captionText ?? '').slice(0, 400) || `hazfalafel post ${post.postId}`,
        'org.opencontainers.image.source': SOURCE_URL,
        'org.opencontainers.image.url': post.permalink ?? `http://hazfalafel.com/post/${post.postId}`,
        'org.opencontainers.image.created': createdAt,
        'org.opencontainers.image.version': post.captureTimestamp ?? '',
        'org.opencontainers.image.revision': post.postId,
        'io.hazfalafel.post.id': String(post.postId),
        'io.hazfalafel.post.permalink': post.permalink ?? '',
        'io.hazfalafel.post.tags': metadata.tags.map((t) => t.name).join(','),
        'io.hazfalafel.post.caption.text': post.captionText ?? '',
        'io.hazfalafel.post.content.html': post.captionHtml ?? '',
        'io.hazfalafel.post.capture.timestamp': post.captureTimestamp ?? '',
        'io.hazfalafel.post.capture.url': post.captureUrl ?? '',
        'io.hazfalafel.post.image.count': String(images.length),
        'io.hazfalafel.post.image.missing': String((post.missingImages ?? []).length),
        'io.hazfalafel.post.metadata.json': JSON.stringify(metadata),
      },
    },
    history: [{ created: createdAt, created_by: `${generator} post ${post.postId}` }],
    rootfs: { type: 'layers', diff_ids: [] },
  };

  const layers = [];
  const layerTars = [];
  for (const image of images) {
    const captionText = [image.caption ?? '', image.alt ?? ''].filter(Boolean).join('\n');
    const tar = makeTar([
      { name: image.layerPath, data: image.data },
      { name: `${image.layerPath}.caption.txt`, data: `${captionText}\n`, type: '0' },
    ]);
    const digest = `sha256:${sha256(tar)}`;
    config.rootfs.diff_ids.push(digest);
    layerTars.push(tar);
    layers.push({
      mediaType: MEDIA_TYPES.layer,
      digest,
      size: tar.length,
      annotations: {
        'org.opencontainers.image.title': image.layerPath,
        'io.hazfalafel.image.original.url': image.originalUrl,
        'io.hazfalafel.image.capture.timestamp': image.captureTimestamp ?? '',
        'io.hazfalafel.image.capture.url': image.captureUrl ?? '',
        'io.hazfalafel.image.caption': captionText,
        'io.hazfalafel.image.sha256': sha256(image.data),
        'io.hazfalafel.image.recovery.strategy': image.strategy ?? '',
      },
    });
  }

  const configBlob = jsonBlob(config);
  const manifest = {
    schemaVersion: 2,
    mediaType: MEDIA_TYPES.manifest,
    config: { mediaType: MEDIA_TYPES.config, digest: `sha256:${sha256(configBlob)}`, size: configBlob.length },
    layers,
    annotations: {
      'org.opencontainers.image.title': `hazfalafel post ${post.postId}`,
      'org.opencontainers.image.description': (post.captionText ?? '').slice(0, 400) || `hazfalafel post ${post.postId}`,
      'org.opencontainers.image.source': SOURCE_URL,
      'org.opencontainers.image.url': post.permalink ?? `http://hazfalafel.com/post/${post.postId}`,
      'org.opencontainers.image.created': createdAt,
      'org.opencontainers.image.licenses': 'see-source',
      'io.hazfalafel.post.id': String(post.postId),
      'io.hazfalafel.post.capture.timestamp': post.captureTimestamp ?? '',
      'io.hazfalafel.post.partial': String(images.length < (post.expectedImages ?? images.length)),
      'io.shurik.recovery.schema': 'shurik.hazfalafel/post/v1',
    },
  };

  return { manifest, manifestBytes: jsonBlob(manifest), configBytes: configBlob, metadata, layerTars };
}

export class RegistryError extends Error {
  constructor(status, body, url) {
    super(`registry ${status} for ${url}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = String(body).slice(0, 1000);
    this.url = url;
  }
}

export class GhcrRegistry {
  constructor({ registry = 'ghcr.io', repository, username, token, fetchImpl = fetch } = {}) {
    if (!repository) throw new Error('repository required');
    this.registry = registry;
    this.repository = repository;
    this.username = username;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.stats = { blobUploads: 0, blobsSkipped: 0, manifests: 0 };
  }

  async access() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 30_000) return this.accessToken;
    if (!this.username || !this.token) throw new Error('registry credentials missing from environment');
    const scope = `repository:${this.repository}:pull,push`;
    const url = `https://${this.registry}/token?service=${this.registry}&scope=${encodeURIComponent(scope)}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}` },
    });
    if (!res.ok) throw new RegistryError(res.status, await res.text(), url);
    const body = await res.json();
    this.accessToken = body.token;
    this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in ?? 300) - 60) * 1000;
    return this.accessToken;
  }

  async request(path, init = {}) {
    const token = await this.access();
    const url = `https://${this.registry}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 404) throw new RegistryError(res.status, await res.text(), url);
    return res;
  }

  async blobExists(digest) {
    const res = await this.request(`/v2/${this.repository}/blobs/${digest}`, { method: 'HEAD' });
    return res.status === 200;
  }

  async pushBlob(buf) {
    const digest = `sha256:${sha256(buf)}`;
    if (await this.blobExists(digest)) {
      this.stats.blobsSkipped += 1;
      return digest;
    }
    const start = await this.request(`/v2/${this.repository}/blobs/uploads/`, { method: 'POST' });
    const location = start.headers.get('location');
    if (!location) throw new Error('registry did not return an upload location');
    const putUrl = `${location.startsWith('http') ? '' : `https://${this.registry}`}${location}${location.includes('?') ? '&' : '?'}digest=${encodeURIComponent(digest)}`;
    const res = await this.request(putUrl.startsWith('http') ? putUrl.slice(`https://${this.registry}`.length) : putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: buf,
    });
    if (!res.ok) throw new RegistryError(res.status, await res.text(), putUrl);
    this.stats.blobUploads += 1;
    return digest;
  }

  async pushManifest(tag, manifest, mediaType = MEDIA_TYPES.manifest) {
    const bytes = Buffer.isBuffer(manifest) ? manifest : Buffer.from(JSON.stringify(manifest), 'utf8');
    const res = await this.request(`/v2/${this.repository}/manifests/${tag}`, {
      method: 'PUT',
      headers: { 'content-type': mediaType },
      body: bytes,
    });
    if (!res.ok) throw new RegistryError(res.status, await res.text(), `manifest ${tag}`);
    this.stats.manifests += 1;
    return { digest: res.headers.get('docker-content-digest'), bytes };
  }

  async pullManifest(tag) {
    const res = await this.request(`/v2/${this.repository}/manifests/${tag}`);
    if (res.status === 404) return null;
    return res.json();
  }
}

export { sha256, createHash, SOURCE_URL };

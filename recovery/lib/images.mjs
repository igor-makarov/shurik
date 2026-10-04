// Image recovery helpers: archived-CDN variants, body validation, capture choice.
import { OUTCOME } from './wayback.mjs';
import { mediaKey } from './parse-post.mjs';

/** Magic-byte sniffing: archived HTML error pages must never be stored as images. */
export function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mimetype: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimetype: 'image/png', ext: 'png' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return { mimetype: 'image/gif', ext: 'gif' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimetype: 'image/webp', ext: 'webp' };
  }
  if (buf.subarray(0, 2).toString('ascii') === 'BM') return { mimetype: 'image/bmp', ext: 'bmp' };
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    return { mimetype: 'image/tiff', ext: 'tif' };
  }
  return null;
}

/** Reject archive error/interstitial pages masquerading as image bytes. */
export function looksLikeHtml(buf) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.includes('<head');
}

export function validateImageBody(buf, contentType = '') {
  if (/text\/html/i.test(contentType)) return { ok: false, reason: 'html-content-type' };
  if (looksLikeHtml(buf)) return { ok: false, reason: 'html-body' };
  const type = detectImageType(buf);
  if (!type) return { ok: false, reason: 'unknown-magic-bytes' };
  return { ok: true, ...type, bytes: buf.length };
}

/** Ordered size variants of a Tumblr media URL (bigger first, original last). */
const SIZE_VARIANTS = ['1280', '1024', '540', '500', '400', '250', '128', '64'];

/** Alternate cache shards; captures sometimes exist under a different host. */
const SHARD_VARIANTS = ['24', '2', '8', '16', '32', '1', '64'];

export function variantUrls(url) {
  const key = mediaKey(url);
  if (!key) return [url];
  const build = (host, size) => {
    const sizePart = size ? `_${size}` : '';
    return `http://${host}.media.tumblr.com/${key.dir}/${key.slug}${sizePart}${key.ext}`;
  };
  const urls = [];
  const sizes = key.size ? [...SIZE_VARIANTS.filter((s) => s !== key.size), null] : [null];
  urls.push(build(key.host, key.size)); // exact original first
  for (const size of sizes) {
    const candidate = build(key.host, size);
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  for (const shard of SHARD_VARIANTS) {
    if (shard === key.host) continue;
    for (const size of [key.size, '1280', null]) {
      const candidate = build(shard, size);
      if (!urls.includes(candidate)) urls.push(candidate);
    }
  }
  return urls;
}

/** Distinct archived-capture lookup strategies, tried in order, for one image. */
export function imageStrategies(url, { hostPrefix = true } = {}) {
  const key = mediaKey(url);
  const strategies = [
    { method: 'cdx-exact-capture', url },
  ];
  if (key && hostPrefix) {
    strategies.push({ method: 'cdx-host-prefix-sizes', url: `http://${key.host}.media.tumblr.com/${key.dir}/${key.slug}` });
  }
  for (const variant of variantUrls(url).slice(1, 12)) {
    strategies.push({ method: 'cdx-variant-url', url: variant });
  }
  return strategies;
}

/** Choose the capture to replay: closest to the post capture, still pre-cutoff. */
export function chooseCapture(captures, nearTimestamp) {
  if (!captures.length) return null;
  const sorted = [...captures].sort((a, b) => Math.abs(Number(a.timestamp) - Number(nearTimestamp ?? 0)) - Math.abs(Number(b.timestamp) - Number(nearTimestamp ?? 0)));
  return sorted[0];
}

export { OUTCOME };

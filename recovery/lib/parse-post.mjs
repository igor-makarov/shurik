// Tumblr post page parser.
//
// Deliberately dependency-free: the archive returns theme HTML that no modern
// parser survives well, and we only need a handful of well-identified fields.
// Every value we emit comes from the captured HTML; nothing is invented.
import { CUTOFF, isPreCutoff } from './util.mjs';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'",
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“',
  rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×', copy: '©', reg: '®',
};

export function decodeEntities(text) {
  if (!text) return '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

export const stripTags = (html) =>
  decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();

/** Return [start, end) of the element whose opening tag begins at `openIdx`. */
export function elementRange(html, openIdx, tagName = 'div') {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  openRe.lastIndex = openIdx;
  const openMatch = openRe.exec(html);
  if (!openMatch || openMatch.index !== openIdx) return null;
  let depth = 0;
  const scanner = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
  scanner.lastIndex = openIdx;
  let m;
  while ((m = scanner.exec(html))) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return [openIdx, m.index + m[0].length];
  }
  return null;
}

function attribute(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** Class list of an opening tag. */
const classesOf = (tag) => (attribute(tag, 'class') ?? '').split(/\s+/).filter(Boolean);

export function metaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'gi');
  for (const tag of html.match(re) ?? []) {
    const content = attribute(tag, 'content');
    if (content) return content;
  }
  return null;
}

/** Non-image post media (video/audio/quote/photoset markers) kept as evidence. */
const EMBED_RE = /<(video|audio|source|iframe|embed)\b([^>]*)>/gi;
const EMBED_HREF_RE = /\b(?:src|data-orig-file|data-href|href)=["']([^"']+)["']/gi;

function embeddedMedia(html) {
  const out = [];
  for (const m of html.matchAll(EMBED_RE)) {
    const tag = m[0];
    const src = attribute(tag, 'src') ?? attribute(tag, 'data-href');
    out.push({ kind: m[1].toLowerCase(), url: src ?? null });
  }
  for (const m of html.matchAll(/data-(?:tumblr-)?(?:video|audio|post)-id=["'](\d+)["']/gi)) {
    out.push({ kind: 'tumblr-media-id', id: m[1] });
  }
  return out;
}

const AVATAR_RE = /\/avatar_|\/preload\/|\/tumblr_.*_avatar/i;
const TRACKER_RE = /stats\.|pixel|1x1|tracking|beacon|doubleclick|analytics/i;

/**
 * Images that belong to a post body. Avatars, theme assets and tracking pixels
 * are excluded; everything else is kept with its alt/caption text.
 */
export function postImages(postHtml, pageHtml = postHtml) {
  const scope = postHtml ?? pageHtml;
  const seen = new Set();
  const images = [];
  for (const m of scope.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attribute(tag, 'src') ?? attribute(tag, 'data-src');
    if (!src) continue;
    if (!/^https?:/i.test(src)) continue;
    if (AVATAR_RE.test(src) || TRACKER_RE.test(src)) continue;
    if (!/media\.tumblr\.com|\/tumblr_|\/image\//i.test(src)) continue;
    const key = src.replace(/^https?:/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      url: src,
      alt: attribute(tag, 'alt') ?? '',
      width: attribute(tag, 'width') ?? null,
      height: attribute(tag, 'height') ?? null,
    });
  }
  // <a href> wrappers sometimes carry the full-size original for the same photo.
  for (const m of scope.matchAll(/<a\b[^>]*href=["']([^"']*media\.tumblr\.com[^"']*)["'][^>]*>/gi)) {
    const src = decodeEntities(m[1]);
    const key = src.replace(/^https?:/, '');
    if (seen.has(key) || AVATAR_RE.test(src) || TRACKER_RE.test(src)) continue;
    seen.add(key);
    images.push({ url: src, alt: '', width: null, height: null });
  }
  return images;
}

/** Split a Tumblr media URL into its variant coordinates. */
export function mediaKey(url) {
  const u = String(url);
  const m = /^(https?:\/\/)([^/]+)\/([0-9a-f]{6,40})\/(tumblr_[A-Za-z0-9]+?)(?:_(\d+))?(\.[A-Za-z0-9]+)$/i.exec(u);
  if (!m) return null;
  return { host: m[2], dir: m[3], slug: m[4], size: m[5] ?? null, ext: m[6] };
}

/**
 * Parse a captured Tumblr post page. Returns null when the capture is not a post
 * page (login walls, error pages, blog indexes).
 */
export function parsePostPage(html, { url, timestamp, rawStatus } = {}) {
  if (!html || typeof html !== 'string') return null;
  const isErrorPage = /<title>\s*(?:Internet Archive|404|Wayback Machine has not archived)/i.test(html);
  const postId =
    (/[?&]post(?:ID)?=([0-9]{6,})/i.exec(html)?.[1]) ??
    /post\/([0-9]{6,})/.exec(url ?? '')?.[1] ??
    null;
  if (!postId) return null;
  if (isErrorPage && !/<div class="post"/i.test(html)) {
    return { postId, parseError: 'error-page', url, timestamp, rawStatus };
  }

  const postStart = html.search(/<div[^>]*class=["'][^"']*\bpost\b[^"']*["'][^>]*>/i);
  let postHtml = html;
  let postHtmlRange = null;
  if (postStart >= 0) {
    const range = elementRange(html, postStart, 'div');
    if (range) {
      postHtml = html.slice(range[0], range[1]);
      postHtmlRange = range;
    }
  }

  const captionBlocks = [];
  for (const m of postHtml.matchAll(/<div[^>]*class=["'][^"']*\b(?:copy|caption|post-content|post_text|caption-inner)\b[^"']*["'][^>]*>/gi)) {
    const range = elementRange(postHtml, m.index, 'div');
    if (range) {
      const inner = postHtml.slice(range[0], range[1]);
      const innerInner = inner.replace(/^<div[^>]*>/i, '').replace(/<\/div>$/i, '');
      captionBlocks.push(innerInner.trim());
    }
  }
  const ogDescription = metaContent(html, 'og:description') ?? metaContent(html, 'twitter:description');
  const captionHtml = captionBlocks.length > 0 ? captionBlocks.join('\n') : (ogDescription ?? '');

  const tags = [];
  const seenTags = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']*\/tagged\/([^"'#?]+))[^"']*["'][^>]*>/gi)) {
    const raw = decodeEntities(m[2]);
    const label = stripTags(m[0]) || raw;
    const key = raw.toLowerCase();
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tags.push({ slug: raw, name: label || raw, url: m[1] });
  }

  const postedOn = /title=["']Posted on ([^"']+)["']/i.exec(html)?.[1] ?? null;
  const permalink =
    metaContent(html, 'og:url') ??
    attribute(/<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0] ?? '', 'href') ??
    (/post\/([0-9]{6,})/.exec(url ?? '') ? `http://hazfalafel.com/post/${postId}` : null);

  const images = postImages(postHtml, html);
  const embedded = embeddedMedia(postHtml);
  const ogType = metaContent(html, 'og:type');

  return {
    postId,
    permalink,
    parsedUrl: url,
    captureTimestamp: timestamp,
    captureWithinCutoff: isPreCutoff(timestamp) && timestamp <= CUTOFF,
    title: metaContent(html, 'og:title'),
    blogName: /blogName=([A-Za-z0-9_-]+)/i.exec(html)?.[1] ?? null,
    postedOn,
    ogType,
    keywords: metaContent(html, 'keywords'),
    captionHtml,
    captionText: stripTags(captionHtml),
    description: ogDescription,
    tags,
    images,
    embedded,
    postHtmlRange,
    postHtmlLength: postHtml.length,
    parseError: null,
  };
}

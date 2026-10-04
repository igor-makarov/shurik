// Wayback Machine access: rate-limited HTTP, CDX inventory queries, capture fetches.
//
// Safety rules encoded here:
//   * every capture URL is built from an explicit pre-cutoff timestamp (assertPreCutoff),
//   * redirects are followed manually and a redirect that points at a post-cutoff
//     capture is refused instead of silently fetching it,
//   * `id_` (raw bytes) is preferred, `if_` is the fallback for assets,
//   * timeouts are bounded and failures are classified so the ledger can tell a
//     confirmed archive gap from a timeout / throttle / temporary failure.
import { assertPreCutoff, isPreCutoff, log, sleep, timestampFromRedirect } from './util.mjs';

export const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';
const USER_AGENT = 'shurik-hazfalafel-recovery/1.0 (+https://github.com/igor-makarov/shurik)';

export const OUTCOME = {
  OK: 'ok',
  ARCHIVE_GAP: 'archive-gap', // CDX answered successfully and listed no captures
  NOT_FOUND: 'not-found', // capture replay answered 404 (page/image never archived)
  TIMEOUT: 'timeout',
  THROTTLED: 'throttled',
  TRANSIENT: 'transient',
  AFTER_CUTOFF: 'after-cutoff', // archive redirect pointed past the cutoff
  BAD_BODY: 'bad-body', // replay returned non-asset bytes (archive error page)
  ERROR: 'error',
};

export class TransientError extends Error {
  constructor(outcome, message, detail = {}) {
    super(message);
    this.outcome = outcome;
    this.detail = detail;
  }
}

/** Minimal token-bucket rate limiter so we stay polite to the archive. */
export class RateLimiter {
  constructor({ minIntervalMs = 400, concurrency = 3 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.concurrency = concurrency;
    this.active = 0;
    this.nextSlot = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active >= this.concurrency) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const done = async () => {
      this.active -= 1;
      this.queue.shift()?.();
    };
    return async () => {
      await gate;
      await done();
    };
  }
}

export class WaybackClient {
  constructor({ timeoutMs = 60_000, retries = 3, rateLimiter, fetchImpl = fetch } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.limiter = rateLimiter ?? new RateLimiter();
    this.fetchImpl = fetchImpl;
    this.stats = { requests: 0, retries: 0, bytes: 0 };
  }

  async rawFetch(url, { method = 'GET', headers = {}, body, redirect = 'manual' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const release = await this.limiter.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.stats.requests += 1;
        const res = await this.fetchImpl(url, {
          method,
          headers: { 'user-agent': USER_AGENT, ...headers },
          body,
          redirect,
          signal: controller.signal,
        });
        if (attempt < this.retries && (res.status === 429 || res.status >= 500)) {
          const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
          log(`retry ${res.status} ${url} in ${backoff}ms`);
          release();
          clearTimeout(timer);
          await sleep(backoff);
          this.stats.retries += 1;
          continue;
        }
        clearTimeout(timer);
        release();
        return res;
      } catch (err) {
        clearTimeout(timer);
        release();
        lastError = err;
        const aborted = err?.name === 'AbortError';
        if (attempt < this.retries) {
          const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
          log(`retry ${aborted ? 'timeout' : err?.message} ${url} in ${backoff}ms`);
          this.stats.retries += 1;
          await sleep(backoff);
          continue;
        }
        throw new TransientError(aborted ? OUTCOME.TIMEOUT : OUTCOME.TRANSIENT, `${aborted ? 'timeout' : 'fetch error'}: ${url}`, {
          cause: String(err?.message ?? err),
        });
      }
    }
    throw lastError;
  }

  /**
   * CDX inventory query. Resolves to { rows, outcome } and never throws for gaps:
   * an empty successful answer is a confirmed archive gap.
   */
  async cdx(query, { limit = 200_000 } = {}) {
    const params = new URLSearchParams({ output: 'json', limit: String(limit), ...query });
    const url = `${CDX_ENDPOINT}?${params}`;
    const res = await this.rawFetch(url);
    if (res.status === 404) return { rows: [], outcome: OUTCOME.ARCHIVE_GAP, url };
    if (res.status !== 200) {
      throw new TransientError(
        res.status === 429 ? OUTCOME.THROTTLED : OUTCOME.TRANSIENT,
        `cdx status ${res.status}`,
        { url, status: res.status },
      );
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TransientError(OUTCOME.BAD_BODY, `cdx returned non-JSON body`, { url, snippet: text.slice(0, 200) });
    }
    if (!Array.isArray(json) || json.length === 0) return { rows: [], outcome: OUTCOME.ARCHIVE_GAP, url };
    const [header, ...rest] = json;
    return {
      rows: rest.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]]))),
      outcome: OUTCOME.OK,
      url,
    };
  }

  /** Captures for one exact URL, all timestamps, deduplicated, pre-cutoff only. */
  async capturesFor(url, { fl = 'timestamp,original,statuscode,mimetype,digest,length' } = {}) {
    const { rows, outcome, url: queryUrl } = await this.cdx({
      url,
      fl,
      to: '20191231235959',
      filter: 'statuscode:200',
    });
    const pre = rows.filter((row) => isPreCutoff(row.timestamp));
    const dropped = rows.length - pre.length;
    return { captures: pre, outcome: dropped > 0 && pre.length === 0 ? OUTCOME.AFTER_CUTOFF : outcome, queryUrl };
  }

  /**
   * Fetch one capture as raw bytes. Refuses post-cutoff replays even when the
   * archive redirects to a newer capture.
   */
  async fetchCapture(timestamp, original, { modifier = 'id_', accept } = {}) {
    assertPreCutoff(timestamp, `capture of ${original}`);
    const target = `https://web.archive.org/web/${timestamp}${modifier}/${original}`;
    let url = target;
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await this.rawFetch(url, { headers: accept ? { accept } : {} });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        const ts = timestampFromRedirect(location);
        if (ts && !isPreCutoff(ts)) {
          throw new TransientError(OUTCOME.AFTER_CUTOFF, `redirect to post-cutoff capture ${ts}`, {
            from: url,
            location,
          });
        }
        if (!location) throw new TransientError(OUTCOME.NOT_FOUND, `redirect without location: ${url}`);
        url = location.startsWith('http') ? location : new URL(location, url).toString();
        continue;
      }
      if (res.status === 404) throw new TransientError(OUTCOME.NOT_FOUND, `capture missing: ${target}`, { url });
      if (res.status !== 200) {
        throw new TransientError(res.status === 429 ? OUTCOME.THROTTLED : OUTCOME.TRANSIENT, `replay status ${res.status}`, {
          url,
          status: res.status,
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      this.stats.bytes += buf.length;
      return {
        body: buf,
        contentType: res.headers.get('content-type') ?? '',
        requestedTimestamp: timestamp,
        finalUrl: url,
        redirectedTimestamp: timestampFromRedirect(url) ?? timestamp,
      };
    }
    throw new TransientError(OUTCOME.TRANSIENT, `too many redirects for ${target}`);
  }

  /** Text capture with the raw-bytes modifier falling back to `if_`. */
  async fetchTextCapture(timestamp, original) {
    try {
      const res = await this.fetchCapture(timestamp, original, { modifier: 'id_', accept: 'text/html' });
      return res;
    } catch (err) {
      if (err.outcome === OUTCOME.NOT_FOUND) {
        return this.fetchCapture(timestamp, original, { modifier: 'if_', accept: 'text/html' });
      }
      throw err;
    }
  }
}

export { isPreCutoff };

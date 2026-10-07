// Throttled, resumable HTTP range downloads.
//
// Design notes (defects these guard against):
//  * A single origin connection delivers only ~20 KiB/s, so the pool runs
//    several connections while an aggregate token bucket caps total bandwidth.
//  * The origin drops connections and can stall; we use idle + attempt
//    timeouts and bounded retries with jittered backoff and Retry-After.
//  * A server that ignores Range returns 200. We must never append that full
//    body onto an existing partial; the caller gets a typed RangeIgnored error
//    and restarts the file from zero.

import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// A cooperative cancellation error. It is distinct from transient/validator
// errors so callers can preserve already-verified chunks on ordinary abort.
export function abortError(reason = 'aborted') {
  const e = new Error(reason);
  e.name = 'AbortError';
  e.aborted = true;
  return e;
}

export function jitter(ms, ratio = 0.3) {
  const d = ms * ratio;
  return Math.round(ms - d + Math.random() * (2 * d));
}

// ---------------------------------------------------------------------------
// Origin reachability
// ---------------------------------------------------------------------------

// One bounded TCP connect. Resolves { ok, reason }; never rejects and always
// tears the socket down, so it is safe to call from a foreground batch.
export function tcpConnect(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let sock;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve({ ok, reason });
    };
    try {
      sock = net.connect({ host, port });
    } catch (err) {
      resolve({ ok: false, reason: err.code || err.message });
      return;
    }
    sock.setTimeout(timeoutMs, () => done(false, `connect timeout after ${timeoutMs}ms`));
    sock.once('connect', () => done(true, null));
    sock.once('error', (err) => done(false, err.code || err.message));
  });
}

// Probe the origin host/port a bounded number of times before a transfer batch.
// A down origin otherwise burns the whole batch retrying connections to a host
// that cannot be reached and reports it only as per-chunk timeouts.
export async function originReachable(url, { attempts = 2, timeoutMs = 8000, gapMs = 2000 } = {}) {
  if (!url) return { ok: true, reason: null };
  let host;
  let port;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch (err) {
    return { ok: false, reason: `bad probe url: ${err.message}` };
  }
  let reason = null;
  for (let i = 0; i < attempts; i++) {
    const r = await tcpConnect(host, port, timeoutMs);
    if (r.ok) return { ok: true, reason: null };
    reason = r.reason;
    if (i < attempts - 1) await sleep(gapMs);
  }
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Aggregate token bucket
// ---------------------------------------------------------------------------

export function createRateLimiter(bytesPerSecond) {
  let tokens = bytesPerSecond; // allow a small initial burst
  let last = Date.now();
  const refill = () => {
    const now = Date.now();
    if (now > last) {
      tokens = Math.min(bytesPerSecond, tokens + ((now - last) / 1000) * bytesPerSecond);
      last = now;
    }
  };
  return {
    async take(n) {
      if (!bytesPerSecond || bytesPerSecond <= 0) return;
      let remaining = n;
      while (remaining > 0) {
        refill();
        if (tokens >= remaining) {
          tokens -= remaining;
          return;
        }
        const need = remaining - tokens;
        await sleep(Math.max(5, Math.ceil((need / bytesPerSecond) * 1000)));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TransientError extends Error {
  constructor(msg, { retryAfterMs, status } = {}) {
    super(msg);
    this.name = 'TransientError';
    this.transient = true;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}
export class RangeIgnoredError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RangeIgnoredError';
    this.rangeIgnored = true;
  }
}
export class RangeMismatchError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RangeMismatchError';
    this.rangeMismatch = true;
  }
}
export class RangeNotSatisfiableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RangeNotSatisfiableError';
    this.rangeNotSatisfiable = true;
  }
}
export class PermanentError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'PermanentError';
    this.status = status;
  }
}

export function parseContentRange(value) {
  if (!value) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

function retryAfterToMs(headers) {
  const ra = headers['retry-after'];
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(ra);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

// ---------------------------------------------------------------------------
// One streaming GET
// ---------------------------------------------------------------------------

// Issues a GET. When destTmp is provided the (possibly partial) body is written
// there. Returns metadata plus the number of bytes written.
export async function httpGetToFile(url, opts) {
  const {
    destTmp,
    start = 0,
    end = null,
    ifRange = null,
    limiter = null,
    idleTimeoutMs = 30000,
    attemptTimeoutMs = 180000,
    headers: extraHeaders = {},
    metaOnly = false,
    maxRedirects = 5,
    signal = null,
  } = opts;

  if (signal && signal.aborted) throw abortError();

  const headers = { 'User-Agent': 'shurik-nauka/1.0', Accept: '*/*', ...extraHeaders };
  if (end != null) {
    headers.Range = `bytes=${start}-${end}`;
    if (start > 0 && ifRange) headers['If-Range'] = ifRange;
  } else if (start > 0) {
    headers.Range = `bytes=${start}-`;
    if (ifRange) headers['If-Range'] = ifRange;
  }

  const doRequest = (target, redirectsLeft) =>
    new Promise((resolve, reject) => {
      const mod = target.protocol === 'http:' ? http : https;
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        req.destroy(abortError());
      };
      const req = mod.request(
        target,
        { method: 'GET', headers: { ...headers, Host: target.host } },
        (res) => {
          const status = res.statusCode;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, target);
            resolve(doRequest(next, redirectsLeft - 1));
            return;
          }
          resolve({ res, finalUrl: target.toString() });
        },
      );
      const cleanup = () => {
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', cleanup);
      req.setTimeout(idleTimeoutMs, () => req.destroy(new Error(`idle timeout after ${idleTimeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });

  let timer;
  const attemptDeadline = Date.now() + attemptTimeoutMs;
  const overall = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TransientError(`attempt timeout after ${attemptTimeoutMs}ms`)),
      attemptTimeoutMs,
    );
    timer.unref?.();
  });

  let res;
  let finalUrl;
  try {
    const r = await Promise.race([doRequest(new URL(url), maxRedirects), overall]);
    res = r.res;
    finalUrl = r.finalUrl;
  } catch (err) {
    if (err && err.aborted) throw err;
    throw err instanceof TransientError ? err : new TransientError(`request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (signal && signal.aborted) {
    res.destroy();
    throw abortError();
  }

  const status = res.statusCode;
  const meta = {
    status,
    finalUrl,
    headers: res.headers,
    etag: res.headers.etag,
    lastModified: res.headers['last-modified'],
    contentRange: parseContentRange(res.headers['content-range']),
    contentLength: res.headers['content-length'] ? Number(res.headers['content-length']) : null,
    bytesWritten: 0,
  };

  const finish = (bytesWritten) => {
    meta.bytesWritten = bytesWritten;
    return meta;
  };

  if (status === 429 || (status >= 500 && status < 600)) {
    res.resume();
    throw new TransientError(`HTTP ${status}`, { status, retryAfterMs: retryAfterToMs(res.headers) });
  }
  if (status === 416) {
    res.resume();
    throw new RangeNotSatisfiableError('HTTP 416');
  }
  if (status === 200 && start > 0) {
    // Range ignored: do not write this body onto a partial.
    res.resume();
    throw new RangeIgnoredError('server returned 200 for a ranged request');
  }
  if (status !== 200 && status !== 206) {
    res.resume();
    throw new PermanentError(`unexpected HTTP ${status}`, status);
  }
  if (status === 206) {
    if (start > 0 && (!meta.contentRange || meta.contentRange.start !== start)) {
      res.resume();
      throw new RangeMismatchError(
        `Content-Range start ${meta.contentRange ? meta.contentRange.start : 'missing'} != ${start}`,
      );
    }
    if (end != null && meta.contentRange && meta.contentRange.end > end) {
      res.resume();
      throw new RangeMismatchError('Content-Range end beyond requested end');
    }
  }
  if (!destTmp || metaOnly) {
    res.destroy();
    return finish(0);
  }

  // The overall per-attempt timeout must cover body streaming too, not just the
  // response headers: a server that trickles bytes would otherwise keep a
  // writer alive past the batch deadline.
  const remaining = attemptDeadline - Date.now();
  if (remaining <= 0) {
    res.destroy();
    throw new TransientError(`attempt timeout after ${attemptTimeoutMs}ms`);
  }
  let bodyTimedOut = false;
  const bodyTimer = setTimeout(() => {
    bodyTimedOut = true;
    res.destroy(new Error('attempt timeout during body'));
  }, remaining);
  bodyTimer.unref?.();

  const out = createWriteStream(destTmp, { flags: 'w' });
  let written = 0;
  let failed = null;
  let streamError = null;
  out.on('error', (e) => {
    streamError = e;
  });
  try {
    for await (const chunk of res) {
      if (signal && signal.aborted) throw abortError();
      if (limiter) await limiter.take(chunk.length);
      if (signal && signal.aborted) throw abortError();
      if (!out.write(chunk)) {
        await new Promise((r) => out.once('drain', r));
      }
      if (streamError) throw streamError;
      written += chunk.length;
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    failed = signal && signal.aborted
      ? abortError()
      : bodyTimedOut
        ? new TransientError(`attempt timeout after ${attemptTimeoutMs}ms`)
        : err;
    out.destroy();
    res.destroy();
  } finally {
    clearTimeout(bodyTimer);
  }
  if (failed) {
    // The caller removes the incomplete .tmp; the chunk model never keeps it.
    if (failed.aborted) throw failed;
    throw new TransientError(`body stream failed after ${written} bytes: ${failed.message}`);
  }
  return finish(written);
}

export async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

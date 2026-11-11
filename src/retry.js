'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, url, retryAfterMs) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// 429, 408 and 5xx are worth retrying; other 4xx mean the request itself is wrong.
function isRetryable(err) {
  if (err instanceof HttpError) return err.status === 429 || err.status === 408 || err.status >= 500;
  return true; // network errors, timeouts, closed targets, etc.
}

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// Exponential backoff with jitter. Honours Retry-After when the server sends one.
async function withRetry(fn, { retries = 5, baseMs = 1000, maxMs = 60000, label = 'op', log = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const wait = err.retryAfterMs != null ? Math.min(maxMs, err.retryAfterMs) : backoff / 2 + Math.random() * (backoff / 2);
      log(`[retry] ${label} failed (${err.message.split('\n')[0]}), attempt ${attempt + 1}/${retries}, waiting ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, HttpError, isRetryable, parseRetryAfter, sleep };

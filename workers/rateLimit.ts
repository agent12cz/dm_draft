const MAX_TRACKED_KEYS = 5000;

const requestTimestamps = new Map<string, number[]>();

/**
 * Best-effort sliding window limiter. Cloudflare runs many isolates, so this only
 * caps repeated calls from a single isolate; the server-side expiry check and the
 * Firestore transaction remain the authoritative protection.
 */
export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
) {
  if (requestTimestamps.size > MAX_TRACKED_KEYS) {
    requestTimestamps.clear();
  }

  const windowStart = now - windowMs;
  const recent = (requestTimestamps.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

  if (recent.length >= limit) {
    requestTimestamps.set(key, recent);
    return false;
  }

  recent.push(now);
  requestTimestamps.set(key, recent);
  return true;
}

export function resetRateLimits() {
  requestTimestamps.clear();
}

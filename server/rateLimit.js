// Minimal in-memory rate limiter — one run per user-key per interval.
// We rate-limit ourselves so a single user can't accidentally hammer a carrier
// portal from refreshes or retries.
//
// Default: 60s between starts (forgiving for dev/testing).
// Production: set RATE_LIMIT_MS=86400000 to enforce one-per-day.
const lastStarts = new Map();
const DEFAULT_INTERVAL_MS = Number(process.env.RATE_LIMIT_MS || 60_000);

export function canStart(userKey, intervalMs = DEFAULT_INTERVAL_MS) {
  const last = lastStarts.get(userKey);
  if (!last) return { ok: true };
  const elapsed = Date.now() - last;
  if (elapsed >= intervalMs) return { ok: true };
  return { ok: false, retryAfterMs: intervalMs - elapsed };
}

export function recordStart(userKey) {
  lastStarts.set(userKey, Date.now());
}

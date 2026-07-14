export function createRateLimiter({
  now = Date.now,
  maxFailures = 5,
  windowMs = 10 * 60 * 1000,
  blockMs = 10 * 60 * 1000,
} = {}) {
  const attempts = new Map();

  function isBlocked(ip) {
    const entry = attempts.get(ip);
    if (!entry || !entry.blockedUntil) return false;
    if (now() >= entry.blockedUntil) {
      attempts.delete(ip);
      return false;
    }
    return true;
  }

  function recordFailure(ip) {
    const t = now();
    let entry = attempts.get(ip);

    if (!entry || t - entry.firstFailureAt > windowMs) {
      entry = { failures: 0, firstFailureAt: t, blockedUntil: null };
    }

    entry.failures += 1;
    if (entry.failures >= maxFailures) {
      entry.blockedUntil = t + blockMs;
    }

    attempts.set(ip, entry);
  }

  function recordSuccess(ip) {
    attempts.delete(ip);
  }

  return { isBlocked, recordFailure, recordSuccess };
}

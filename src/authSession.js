import crypto from 'crypto';

export function createSessionStore({ now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) {
  const sessions = new Map();

  function create() {
    const id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, now() + ttlMs);
    return id;
  }

  function isValid(id) {
    if (!id) return false;
    const expiresAt = sessions.get(id);
    if (!expiresAt) return false;
    if (now() >= expiresAt) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  function invalidateAll() {
    sessions.clear();
  }

  return { create, isValid, invalidateAll };
}

// cache.mjs — Generic time-based cache wrapper (C1.1).
//
// Extracts the TTL cache pattern already used in dashboard.mjs for
// health, task info, and gist data into a reusable utility.

/**
 * Wrap a function with a simple time-based cache.
 * NOTE: Stores a single cached value — not argument-aware. Suitable only for
 * functions that are always called with the same arguments (or none).
 * @param {Function} fn - The function to cache (called with forwarded args).
 * @param {number} ttlMs - Cache lifetime in milliseconds.
 * @returns {{ get: Function, bust: Function }}
 */
export function createCachedFn(fn, ttlMs) {
  let _val = null;
  let _ts = 0;
  return {
    get(...args) {
      const now = Date.now();
      if (_val !== null && now - _ts < ttlMs) return _val;
      _val = fn(...args);
      _ts = now;
      return _val;
    },
    bust() {
      _val = null;
      _ts = 0;
    },
  };
}

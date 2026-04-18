// gist.mjs — Read/write GitHub Gist files + distributed dispatch lock (F1.1).
//
// The lock prevents two machines from dispatching simultaneously.
// Protocol: claim → confirm → dispatch → release. 10-minute TTL auto-releases
// stale locks from crashed dispatchers.
//
// Graceful degradation: if no GITHUB_TOKEN or gist is unreachable, the lock
// is skipped (fail-open). This keeps single-machine setups working.

import { randomUUID } from "node:crypto";

const LOCK_FILENAME = "dispatch-lock.json";
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GIST_TIMEOUT_MS = 10_000;
const RACE_SETTLE_MS = 1000; // wait before re-read to detect race

/**
 * Read a single file from a GitHub Gist.
 * @param {string} gistId
 * @param {string} filename
 * @param {{ token?: string }} [opts]
 * @returns {Promise<object|null>} Parsed JSON content, or null if missing/unparseable.
 */
export async function readGistFile(gistId, filename, opts = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "budget-dispatcher-lock",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers,
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  if (!resp.ok) return null;

  const gist = await resp.json();
  const file = gist.files?.[filename];
  if (!file?.content) return null;

  try {
    return JSON.parse(file.content);
  } catch {
    return null;
  }
}

/**
 * Write (upsert) a single file in a GitHub Gist.
 * Requires GITHUB_TOKEN with gist scope.
 * @param {string} gistId
 * @param {string} filename
 * @param {object} data - Will be JSON.stringify'd.
 * @param {{ token: string }} opts
 * @returns {Promise<boolean>} true if write succeeded.
 */
export async function writeGistFile(gistId, filename, data, opts) {
  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "User-Agent": "budget-dispatcher-lock",
    },
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(data, null, 2) } } }),
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  return resp.ok;
}

/**
 * Attempt to acquire the distributed dispatch lock.
 *
 * Returns { acquired: true, lockId } on success,
 *         { acquired: false, reason } on contention,
 *         { acquired: true, lockId: null, degraded: true } on graceful degradation.
 *
 * @param {string} gistId
 * @param {string} machine - os.hostname()
 * @param {{ token?: string, lockTtlMs?: number, _readFn?: Function, _writeFn?: Function }} [opts]
 * @returns {Promise<{ acquired: boolean, lockId?: string|null, reason?: string, degraded?: boolean }>}
 */
export async function acquireDispatchLock(gistId, machine, opts = {}) {
  const token = opts.token;
  const ttl = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const read = opts._readFn ?? readGistFile;
  const write = opts._writeFn ?? writeGistFile;

  // No token → fail-open
  if (!token) {
    console.warn("[gist-lock] no GITHUB_TOKEN, proceeding without lock (fail-open)");
    return { acquired: true, lockId: null, degraded: true };
  }

  try {
    // Step 1: Check existing lock
    const existing = await read(gistId, LOCK_FILENAME, { token });

    if (existing && existing.machine !== null && existing.locked_at) {
      const age = Date.now() - new Date(existing.locked_at).getTime();
      if (age < ttl) {
        const ageSec = Math.round(age / 1000);
        return { acquired: false, reason: `locked by ${existing.machine} ${ageSec}s ago` };
      }
      // Lock is stale — proceed to claim
    }

    // Step 2: Write our claim
    const lockId = randomUUID();
    const lockData = { machine, locked_at: new Date().toISOString(), lock_id: lockId };
    const wrote = await write(gistId, LOCK_FILENAME, lockData, { token });
    if (!wrote) {
      console.warn("[gist-lock] write failed, proceeding without lock (fail-open)");
      return { acquired: true, lockId: null, degraded: true };
    }

    // Step 3: Wait, then re-read to confirm we won the race
    await new Promise((r) => setTimeout(r, RACE_SETTLE_MS));
    const confirmed = await read(gistId, LOCK_FILENAME, { token });

    if (confirmed?.lock_id === lockId) {
      return { acquired: true, lockId };
    }

    // Lost the race
    return { acquired: false, reason: `lost lock race to ${confirmed?.machine ?? "unknown"}` };
  } catch (e) {
    console.warn(`[gist-lock] lock check failed: ${e.message} — proceeding (fail-open)`);
    return { acquired: true, lockId: null, degraded: true };
  }
}

/**
 * Release the dispatch lock by writing { machine: null }.
 * Best-effort; logs warning on failure but never throws.
 * @param {string} gistId
 * @param {{ token?: string, _writeFn?: Function }} [opts]
 * @returns {Promise<void>}
 */
export async function releaseDispatchLock(gistId, opts = {}) {
  const token = opts.token;
  const write = opts._writeFn ?? writeGistFile;

  if (!token) return; // nothing to release without auth

  try {
    await write(gistId, LOCK_FILENAME, { machine: null, released_at: new Date().toISOString() }, { token });
  } catch (e) {
    console.warn(`[gist-lock] lock release failed (non-fatal): ${e.message}`);
  }
}

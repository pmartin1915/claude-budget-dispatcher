// gist.mjs — Distributed dispatch lock via GitHub Gist + ETag optimistic locking.
//
// Phase A hardening (2026-04-24, per docs/research/HARDENING-synthesis-gemini-
// 2026-04-24.md §4). Prior implementation used a read -> write -> wait -> re-read
// pattern with a 1s settle window; both machines could write inside the window
// and the "loser" detection had visible races.
//
// This version uses true ETag optimistic concurrency control on the GitHub
// Gists REST API. Properties:
//
// - Acquisition: PATCH with `If-Match: <etag>`. GitHub returns
//   **412 Precondition Failed** when any concurrent write has modified the
//   gist since we read its etag. Atomic at GitHub's data layer.
// - TTL: `expiresAt` integer (ms). Peer machines evaluate against local
//   wall-clock; expired locks are reclaimable. Default 15 minutes.
// - Fencing token: monotonic counter embedded in the lock payload. Downstream
//   operations can check their token against the current token to refuse
//   writes from a zombie GC-paused predecessor. (Phase A ships the token;
//   downstream checking is a future phase.)
// - Release: `null` payload deletes `lock.json` entirely (cleaner than
//   writing ghost state).
// - Defense-in-depth: after successful PATCH, re-reads and checks that our
//   own `lockId` is on the gist, in case GitHub ever stops enforcing If-Match
//   on gists specifically.
// - Fail-open: no GITHUB_TOKEN OR any thrown exception returns
//   `{ acquired: true, degraded: true }` so single-machine setups still
//   dispatch.

import { randomUUID } from "node:crypto";

const LOCK_FILENAME = "dispatch-lock.json";
const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const GIST_TIMEOUT_MS = 10_000;
const USER_AGENT = "budget-dispatcher-lock";

/**
 * Read the whole gist, extract lock.json, and return { data, etag, status }.
 * `data` is the parsed lock payload (or null if absent/unparseable).
 * `etag` is the HTTP ETag of the gist as a whole; passed back as If-Match
 * on the subsequent PATCH for atomic acquisition.
 *
 * @param {string} gistId
 * @param {{ token?: string }} [opts]
 * @returns {Promise<{ data: object|null, etag: string|null, status: number }>}
 */
export async function readLockWithEtag(gistId, opts = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers,
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  if (!resp.ok) return { data: null, etag: null, status: resp.status };

  const etag = resp.headers.get("etag");
  const gist = await resp.json();
  const file = gist.files?.[LOCK_FILENAME];

  let data = null;
  if (file?.content) {
    try {
      data = JSON.parse(file.content);
    } catch {
      // Malformed lock payload — treat as absent. Next acquire will overwrite.
    }
  }
  return { data, etag, status: 200 };
}

/**
 * Write (or delete, with payload=null) the lock file with optional If-Match
 * header. Returns HTTP status so the caller can distinguish 412 (lost race)
 * from other failures (network, auth).
 *
 * @param {string} gistId
 * @param {object|null} payload - JSON body for lock.json, or null to delete.
 * @param {{ token: string, etag?: string|null }} opts
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function writeLockWithIfMatch(gistId, payload, opts) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (opts.etag) headers["If-Match"] = opts.etag;

  const body = payload === null
    ? { files: { [LOCK_FILENAME]: null } }
    : { files: { [LOCK_FILENAME]: { content: JSON.stringify(payload, null, 2) } } };

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  return { ok: resp.ok, status: resp.status };
}

/**
 * Attempt to acquire the distributed dispatch lock.
 *
 * Returns one of:
 *   { acquired: true,  lockId, fencingToken }            on success
 *   { acquired: true,  lockId: null, degraded: true }    fail-open (no token / error)
 *   { acquired: false, reason: string }                  lost race or held by peer
 *
 * @param {string} gistId
 * @param {string} machine - os.hostname()
 * @param {{ token?: string, lockTtlMs?: number, _readFn?: Function, _writeFn?: Function }} [opts]
 */
export async function acquireDispatchLock(gistId, machine, opts = {}) {
  const token = opts.token;
  const ttl = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const read = opts._readFn ?? readLockWithEtag;
  const write = opts._writeFn ?? writeLockWithIfMatch;

  if (!token) {
    console.warn("[gist-lock] no GITHUB_TOKEN, proceeding without lock (fail-open)");
    return { acquired: true, lockId: null, degraded: true };
  }

  try {
    const { data, etag } = await read(gistId, { token });

    const now = Date.now();
    const isOwnedByOther = data && data.locked && data.lockedBy && data.lockedBy !== machine;
    const isUnexpired = data && typeof data.expiresAt === "number" && data.expiresAt > now;

    if (isOwnedByOther && isUnexpired) {
      const until = new Date(data.expiresAt).toISOString();
      return { acquired: false, reason: `locked by ${data.lockedBy} until ${until}` };
    }

    // Build our claim. Fencing token is monotonic across all holders:
    // if the current payload has fencingToken=N, ours is N+1. This holds
    // even when we're reclaiming an expired or own-abandoned lock.
    const fencingToken = (typeof data?.fencingToken === "number" ? data.fencingToken : 0) + 1;
    const lockId = randomUUID();
    const payload = {
      locked: true,
      lockedBy: machine,
      acquiredAt: now,
      expiresAt: now + ttl,
      fencingToken,
      lockId,
    };

    const { ok, status } = await write(gistId, payload, { token, etag });

    if (!ok) {
      if (status === 412) {
        return { acquired: false, reason: "lost ETag race (gist changed during acquisition)" };
      }
      console.warn(`[gist-lock] write failed (status ${status}); proceeding without lock (fail-open)`);
      return { acquired: true, lockId: null, degraded: true };
    }

    // Defense-in-depth: re-read to confirm our lockId landed. If GitHub ever
    // silently stops enforcing If-Match on gists (undocumented change), this
    // catches the resulting race. Cheap: one extra HTTP call on the happy path.
    const confirm = await read(gistId, { token });
    if (confirm.data?.lockId === lockId) {
      return { acquired: true, lockId, fencingToken };
    }
    const winner = confirm.data?.lockedBy ?? "unknown";
    return { acquired: false, reason: `lost lock race to ${winner} (re-read mismatch)` };
  } catch (e) {
    console.warn(`[gist-lock] lock check failed: ${e.message} — proceeding (fail-open)`);
    return { acquired: true, lockId: null, degraded: true };
  }
}

/**
 * Release the dispatch lock by deleting the lock.json file entirely.
 * Null payload on GitHub's gist PATCH removes the file cleanly (no ghost
 * "released" state to worry about, per GPT hardening recommendation).
 *
 * Best-effort: logs warning on failure but never throws.
 * @param {string} gistId
 * @param {{ token?: string, _writeFn?: Function }} [opts]
 */
export async function releaseDispatchLock(gistId, opts = {}) {
  const token = opts.token;
  const write = opts._writeFn ?? writeLockWithIfMatch;
  if (!token) return;

  try {
    await write(gistId, null, { token });
  } catch (e) {
    console.warn(`[gist-lock] lock release failed (non-fatal): ${e.message}`);
  }
}

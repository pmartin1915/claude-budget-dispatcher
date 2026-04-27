// gist.mjs — Distributed dispatch lock via GitHub Gist + read-confirmation.
//
// Phase A hardening (2026-04-24) originally relied on PATCH `If-Match: <etag>`
// for atomic acquisition. Bug E (surfaced 2026-04-27 by gate-7 smoke against
// canary PR #45) revealed that GitHub's gists API does NOT support conditional
// request headers on PATCH — they're rejected with 400 Bad Request and the
// message "Conditional request headers are not allowed in unsafe requests
// unless supported by the endpoint". The defense-in-depth re-read at
// `acquireDispatchLock` now serves as the sole concurrency primitive.
//
// Properties:
//
// - Acquisition: PATCH (no If-Match) followed by re-read confirming our
//   `lockId` landed. Race window is the ~milliseconds between PATCH and
//   re-read. With 2h dispatch cron cadence this is acceptable; for higher-
//   frequency callers, a separate concurrency layer is needed.
// - TTL: `expiresAt` integer (ms). Peer machines evaluate against local
//   wall-clock; expired locks are reclaimable. Default 15 minutes.
// - Fencing token: monotonic counter embedded in the lock payload. Downstream
//   operations can check their token against the current token to refuse
//   writes from a zombie GC-paused predecessor. (Phase A ships the token;
//   downstream checking is a future phase.)
// - Release: `null` payload deletes `lock.json` entirely (cleaner than
//   writing ghost state).
// - Fail-open: no GITHUB_TOKEN OR any thrown exception returns
//   `{ acquired: true, degraded: true }` so single-machine setups still
//   dispatch.
//
// Function names retained for diff minimality: `writeLockWithIfMatch` and
// `readLockWithEtag` no longer use If-Match but keep their historical names
// to avoid touching callers and tests beyond what the bug fix requires.
// A future refactor can rename to `writeLockFile` / `readLockFile`.

import { randomUUID } from "node:crypto";

const LOCK_FILENAME = "dispatch-lock.json";
const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const GIST_TIMEOUT_MS = 10_000;
const USER_AGENT = "budget-dispatcher-lock";

/**
 * Read the whole gist, extract lock.json, and return { data, etag, status }.
 * Thin wrapper over `readGistFile` with the lock filename hard-coded.
 *
 * `data` is the parsed lock payload (or null if absent/unparseable).
 * `etag` is the HTTP ETag of the gist as a whole. Historically passed back
 * as If-Match; post-Bug-E it's still returned (callers may store/log it for
 * change detection) but the write path no longer sends If-Match.
 *
 * @param {string} gistId
 * @param {{ token?: string }} [opts]
 * @returns {Promise<{ data: object|null, etag: string|null, status: number, malformed?: boolean }>}
 */
export async function readLockWithEtag(gistId, opts = {}) {
  return readGistFile(gistId, LOCK_FILENAME, opts);
}

/**
 * Write (or delete, with payload=null) the lock file. Thin wrapper over
 * `writeGistFile` with the lock filename hard-coded. Returns HTTP status so
 * the caller can distinguish failures (network, auth, GitHub-side 5xx).
 *
 * Historically used `If-Match: <etag>` for ETag-CAS, but the GitHub gists
 * API rejects conditional headers on PATCH with 400 (Bug E, 2026-04-27).
 * `opts.etag` is now ignored; concurrency safety lives in the re-read
 * confirmation in `acquireDispatchLock`.
 *
 * @param {string} gistId
 * @param {object|null} payload - JSON body for lock.json, or null to delete.
 * @param {{ token: string, etag?: string|null }} opts - `etag` is accepted
 *        but ignored, retained for callsite stability.
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function writeLockWithIfMatch(gistId, payload, opts) {
  return writeGistFile(gistId, LOCK_FILENAME, payload, opts);
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

    const { ok, status } = await write(gistId, payload, { token });

    if (!ok) {
      console.warn(`[gist-lock] write failed (status ${status}); proceeding without lock (fail-open)`);
      return { acquired: true, lockId: null, degraded: true };
    }

    // Concurrency primitive (post-Bug-E): re-read to confirm our lockId
    // landed. If a peer wrote in the ~ms window between our PATCH and
    // re-read, their lockId is on the gist and we lose. Cheap: one extra
    // HTTP call on the happy path.
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
 * Read a single named file from the status gist with the gist's ETag.
 * Generic version of readLockWithEtag for non-lock files (e.g. gate-7's
 * pending-merges.json). Returns:
 *   { data: parsed-json | null, etag: string | null, status, malformed?: bool }
 *
 * Fail-soft: any HTTP error returns `{ data: null, etag: null, status }`.
 * `malformed: true` is set when the file exists but isn't valid JSON; the
 * caller can choose to overwrite or fail-soft. ETag is returned for change-
 * detection / logging; the write path no longer sends If-Match (Bug E).
 *
 * @param {string} gistId
 * @param {string} filename - e.g. "pending-merges.json"
 * @param {{ token?: string }} [opts]
 */
export async function readGistFile(gistId, filename, opts = {}) {
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
  const file = gist.files?.[filename];
  if (!file?.content) return { data: null, etag, status: 200 };
  try {
    return { data: JSON.parse(file.content), etag, status: 200 };
  } catch {
    return { data: null, etag, status: 200, malformed: true };
  }
}

/**
 * Write (or delete via payload=null) a single named file in the gist.
 * Generic version of writeLockWithIfMatch for non-lock files (gate-7's
 * pending-merges.json).
 *
 * Historically used `If-Match: <etag>` for ETag-CAS, but the GitHub gists
 * API rejects conditional headers on PATCH with 400 (Bug E, 2026-04-27).
 * `opts.etag` is now ignored. Callers needing concurrency safety must
 * implement it at a higher layer (read-modify-write + idempotency by
 * domain key, e.g. pending-merges entries are de-duplicated by
 * (repo, pr_number, merge_commit_sha) tuple).
 *
 * @param {string} gistId
 * @param {string} filename
 * @param {object|null} payload
 * @param {{ token: string, etag?: string|null }} opts - `etag` is accepted
 *        but ignored, retained for callsite stability.
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function writeGistFile(gistId, filename, payload, opts) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const body = payload === null
    ? { files: { [filename]: null } }
    : { files: { [filename]: { content: JSON.stringify(payload, null, 2) } } };

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  return { ok: resp.ok, status: resp.status };
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

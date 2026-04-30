// sentinel.mjs — P1-2: Sentinel logic for dead-node detection and task recovery.
//
// The Sentinel reads heartbeat-*.json files from the status gist,
// calculates timestamp deltas against the current time, and implements
// a 3-miss threshold escalation:
//
//   Miss 0:   status = "alive"    — no action
//   Miss 1:   status = "degraded" — logged, no action
//   Miss 2:   status = "degraded" — logged, no action
//   Miss 3+:  status = "dead"     — extract current_task_hash → re-queue
//
// A "miss" is defined as:
//   current_time - last_active_timestamp > intervalMs * 1.5
//
// With 20min cron cadence:
//   - 1 miss = 30min silence
//   - 3 misses = 90min silence → declare dead
//
// State persistence: sentinel-state.json in the gist tracks miss_counts
// per node_id. This makes the sentinel stateless across dispatch cycles —
// ANY node can run sentinel duty without self-election.
//
// Orphan recovery: when a node is declared dead, its current_task_hash
// is extracted and written to pending-tasks.json in the gist. A healthy
// idle node claims it on the next cycle. Tasks are idempotent and
// non-destructive by design, so re-queueing is safe.
//
// Fail-soft: runSentinel never throws. All errors are caught and returned
// in the summary structure.
//
// P1-2 of the Architectural Audit and Hardening Roadmap (2026-04-30).

import { readGistFile, writeGistFile } from "./gist.mjs";

const HEARTBEAT_FILE_RE = /^heartbeat-.+\.json$/;
const SENTINEL_STATE_FILENAME = "sentinel-state.json";
const PENDING_TASKS_FILENAME = "pending-tasks.json";

// 1.5x interval = miss threshold. With 20min cron, a miss = 30min silence.
const MISS_MULTIPLIER = 1.5;
// Three consecutive misses = dead.
const DEAD_THRESHOLD = 3;

/**
 * Pure evaluator: given heartbeat snapshots and existing sentinel state,
 * compute new miss counts and identify dead nodes + orphaned tasks.
 *
 * @param {object} args
 * @param {Array<{filename: string, data: object}>} args.heartbeats
 * @param {object} args.sentinelState - Previous sentinel-state.json contents
 * @param {number} args.now - Current timestamp (ms)
 * @param {number} args.intervalMs - Expected heartbeat interval (cron cadence)
 * @returns {{
 *   updates: Array<{nodeId: string, machine: string, status: string, missCount: number, lastTs: number}>,
 *   deadNodes: Array<{nodeId: string, machine: string, missCount: number, currentTaskHash: string|null}>,
 *   orphanedTasks: Array<{taskHash: string, fromNode: string, fromMachine: string}>,
 *   newSentinelState: object
 * }}
 */
export function evaluateHeartbeats({ heartbeats, sentinelState, now, intervalMs }) {
  const missWindow = intervalMs * MISS_MULTIPLIER;
  const prevMissCounts = sentinelState?.miss_counts ?? {};
  const newMissCounts = {};
  const updates = [];
  const deadNodes = [];
  const orphanedTasks = [];

  for (const { data } of heartbeats) {
    if (!data || typeof data !== "object") continue;

    const nodeId = data.node_id;
    const machine = data.machine ?? "unknown";
    if (!nodeId) continue;

    const lastActiveTs = data.last_active_timestamp;
    if (typeof lastActiveTs !== "number" || !Number.isFinite(lastActiveTs)) {
      // Malformed heartbeat — treat as one miss from previous count.
      const prevMiss = typeof prevMissCounts[nodeId] === "number" ? prevMissCounts[nodeId] : 0;
      newMissCounts[nodeId] = prevMiss + 1;
      updates.push({ nodeId, machine, status: "malformed", missCount: newMissCounts[nodeId], lastTs: 0 });
      continue;
    }

    const age = now - lastActiveTs;

    if (age <= missWindow) {
      // Alive — reset miss count.
      newMissCounts[nodeId] = 0;
      updates.push({ nodeId, machine, status: "alive", missCount: 0, lastTs: lastActiveTs });
    } else {
      // Miss — increment.
      const prevMiss = typeof prevMissCounts[nodeId] === "number" ? prevMissCounts[nodeId] : 0;
      const newMiss = prevMiss + 1;
      newMissCounts[nodeId] = newMiss;

      if (newMiss >= DEAD_THRESHOLD) {
        const status = "dead";
        updates.push({ nodeId, machine, status, missCount: newMiss, lastTs: lastActiveTs });
        deadNodes.push({
          nodeId,
          machine,
          missCount: newMiss,
          currentTaskHash: data.current_task_hash ?? null,
        });
        // Extract orphaned task if the dead node was working on something.
        if (data.current_task_hash) {
          orphanedTasks.push({
            taskHash: data.current_task_hash,
            fromNode: nodeId,
            fromMachine: machine,
          });
        }
      } else {
        updates.push({ nodeId, machine, status: "degraded", missCount: newMiss, lastTs: lastActiveTs });
      }
    }
  }

  const newSentinelState = {
    schema_version: 1,
    miss_counts: newMissCounts,
    last_evaluated_ts: now,
    last_evaluated_iso: new Date(now).toISOString(),
    dead_nodes: deadNodes.map((d) => d.nodeId),
  };

  return { updates, deadNodes, orphanedTasks, newSentinelState };
}

/**
 * Read all heartbeat-*.json files from the status gist.
 * Returns an array of { filename, data } objects.
 *
 * @param {string} gistId
 * @param {string} token
 * @returns {Promise<Array<{filename: string, data: object|null}>>}
 */
async function readAllHeartbeats(gistId, token) {
  // We need to read the full gist to enumerate heartbeat files.
  // readGistFile reads the whole gist anyway, so we use a raw fetch
  // and parse all heartbeat-*.json files from the response.
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "budget-dispatcher-sentinel",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];

  const gist = await resp.json();
  const results = [];

  for (const [filename, file] of Object.entries(gist.files ?? {})) {
    if (!HEARTBEAT_FILE_RE.test(filename)) continue;
    let data = null;
    try {
      data = JSON.parse(file?.content ?? "");
    } catch {
      // Malformed — data stays null.
    }
    results.push({ filename, data });
  }

  return results;
}

/**
 * Merge orphaned tasks into the pending-tasks.json gist file.
 * De-duplicates by taskHash — re-queueing the same hash is a no-op.
 *
 * @param {string} gistId
 * @param {string} token
 * @param {Array<{taskHash: string, fromNode: string, fromMachine: string}>} orphans
 * @returns {Promise<{ok: boolean}>}
 */
async function requeueOrphanedTasks(gistId, token, orphans) {
  if (orphans.length === 0) return { ok: true };

  // Read existing pending-tasks.json.
  const existing = await readGistFile(gistId, PENDING_TASKS_FILENAME, { token });
  let entries = [];
  if (existing?.data?.entries && Array.isArray(existing.data.entries)) {
    entries = existing.data.entries;
  }

  // De-duplicate by taskHash.
  const existingHashes = new Set(entries.map((e) => e.task_hash));
  let added = 0;
  for (const orphan of orphans) {
    if (existingHashes.has(orphan.taskHash)) continue;
    entries.push({
      task_hash: orphan.taskHash,
      from_node: orphan.fromNode,
      from_machine: orphan.fromMachine,
      queued_at: Date.now(),
      queued_iso: new Date().toISOString(),
      claimed_by: null,
    });
    added++;
  }

  if (added === 0) return { ok: true };

  const payload = {
    schema_version: 1,
    entries,
  };

  return writeGistFile(gistId, PENDING_TASKS_FILENAME, payload, { token });
}

/**
 * Orchestrator. Reads heartbeats, evaluates staleness, persists sentinel
 * state, and re-queues orphaned tasks. Fail-soft: never throws.
 *
 * @param {object} args
 * @param {string} args.gistId - status_gist_id
 * @param {string} args.token - GITHUB_TOKEN / GIST_AUTH_TOKEN
 * @param {number} args.intervalMs - Expected heartbeat interval (cron cadence in ms)
 * @param {object} [args.config] - Merged config (for future use)
 * @param {number} [args.now] - Clock injection for testing (default Date.now())
 * @param {Function} [args._readHeartbeats] - DI for testing
 * @param {Function} [args._readGistFile] - DI for testing
 * @param {Function} [args._writeGistFile] - DI for testing
 * @returns {Promise<{
 *   updates: Array<object>,
 *   deadNodes: Array<object>,
 *   orphanedTasks: Array<object>,
 *   error?: string
 * }>}
 */
export async function runSentinel({
  gistId,
  token,
  intervalMs,
  config,
  now = Date.now(),
  _readHeartbeats,
  _readGistFile,
  _writeGistFile,
}) {
  const emptyResult = { updates: [], deadNodes: [], orphanedTasks: [] };

  if (!gistId || !token) {
    return { ...emptyResult, error: "missing gistId or token" };
  }

  const readHB = _readHeartbeats ?? readAllHeartbeats;
  const readGF = _readGistFile ?? readGistFile;
  const writeGF = _writeGistFile ?? writeGistFile;

  try {
    // 1. Read all heartbeat files.
    const heartbeats = await readHB(gistId, token);
    if (heartbeats.length === 0) {
      return { ...emptyResult, error: "no heartbeat files found" };
    }

    // 2. Read existing sentinel state.
    const stateResult = await readGF(gistId, SENTINEL_STATE_FILENAME, { token });
    const sentinelState = stateResult?.data ?? { miss_counts: {} };

    // 3. Evaluate heartbeats.
    const evaluation = evaluateHeartbeats({
      heartbeats,
      sentinelState,
      now,
      intervalMs,
    });

    // 4. Write updated sentinel state.
    try {
      await writeGF(gistId, SENTINEL_STATE_FILENAME, evaluation.newSentinelState, { token });
    } catch (e) {
      // State write failure is non-fatal — the next cycle will re-evaluate.
      console.warn(`[sentinel] state write failed: ${e?.message ?? e}`);
    }

    // 5. Re-queue orphaned tasks from dead nodes.
    if (evaluation.orphanedTasks.length > 0) {
      try {
        await requeueOrphanedTasks(gistId, token, evaluation.orphanedTasks);
      } catch (e) {
        console.warn(`[sentinel] orphan requeue failed: ${e?.message ?? e}`);
      }
    }

    // 6. Log dead nodes for visibility.
    for (const dead of evaluation.deadNodes) {
      console.warn(
        `[sentinel] node DEAD: ${dead.machine} (id=${dead.nodeId}, misses=${dead.missCount}` +
        (dead.currentTaskHash ? `, task=${dead.currentTaskHash.slice(0, 12)}…` : "") + ")"
      );
    }

    return {
      updates: evaluation.updates,
      deadNodes: evaluation.deadNodes,
      orphanedTasks: evaluation.orphanedTasks,
    };
  } catch (e) {
    return { ...emptyResult, error: String(e?.message ?? e) };
  }
}

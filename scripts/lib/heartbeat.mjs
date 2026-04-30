// heartbeat.mjs — P1-1: Push-based heartbeat telemetry for fleet nodes.
//
// Each dispatcher node pushes a heartbeat to the shared status gist on
// every cron cycle. The heartbeat carries a comprehensive diagnostic
// snapshot (node_id, timestamps, task hashes, environmental health) that
// the Sentinel uses for dead-node detection and the dashboard uses for
// live fleet visibility.
//
// Design:
//   - buildHeartbeatPayload() is pure (no I/O) — testable in isolation.
//   - pushHeartbeat() adds jitter before writing to avoid API rate limits
//     and write collisions when fleet nodes fire cron simultaneously.
//   - collectEnvHealth() is cross-platform (Windows + POSIX).
//   - All functions are fail-soft: pushHeartbeat never throws (wraps in
//     try/catch); collectEnvHealth never throws (best-effort values).
//
// P1-1 of the Architectural Audit and Hardening Roadmap (2026-04-30).

import { hostname } from "node:os";
import { randomInt } from "node:crypto";
import { createHash } from "node:crypto";
import { writeGistFile } from "./gist.mjs";

const HEARTBEAT_FILENAME_PREFIX = "heartbeat-";

/**
 * Build a heartbeat payload. Pure function — no I/O.
 *
 * @param {object} args
 * @param {string} args.nodeId - Stable identifier for this machine (UUID
 *   from local.json `node_id`, or hostname() as fallback).
 * @param {string} args.machineName - os.hostname() lowercased.
 * @param {string|null} [args.currentTaskHash] - SHA-256 of
 *   (project + branch + commitish) when actively working; null when idle.
 * @param {object} [args.envHealth] - Environmental health snapshot from
 *   collectEnvHealth().
 * @param {number|null} [args.driftVelocity] - Ratio of (actual_duration -
 *   baseline_duration) / baseline_duration. Positive = slower than expected.
 *   Null when no baseline available.
 * @returns {object} heartbeat payload
 */
export function buildHeartbeatPayload({
  nodeId,
  machineName,
  currentTaskHash = null,
  envHealth = {},
  driftVelocity = null,
}) {
  return {
    schema_version: 1,
    node_id: nodeId ?? machineName ?? "unknown",
    machine: machineName ?? hostname().toLowerCase(),
    last_active_timestamp: Date.now(),
    current_task_hash: currentTaskHash,
    environmental_health: envHealth,
    drift_velocity: driftVelocity,
    heartbeat_ts: new Date().toISOString(),
  };
}

/**
 * Compute a SHA-256 task hash from project + branch + commitish.
 * Used as the `current_task_hash` in heartbeat payloads so the Sentinel
 * can identify exactly what a dead node was working on.
 *
 * @param {string} project - project slug
 * @param {string} branch - auto/* branch name
 * @param {string} [commitish] - HEAD SHA or "uncommitted"
 * @returns {string} hex SHA-256
 */
export function computeTaskHash(project, branch, commitish = "uncommitted") {
  return createHash("sha256")
    .update(`${project}:${branch}:${commitish}`)
    .digest("hex");
}

/**
 * Push a heartbeat payload to the status gist. Applies random jitter
 * (default 0–5s) before the write to avoid simultaneous PATCH calls
 * from fleet nodes whose cron fires at the same second.
 *
 * Fail-soft: returns { ok, status } on success, { ok: false, error } on
 * failure. Never throws.
 *
 * @param {object} payload - From buildHeartbeatPayload().
 * @param {string} gistId - status_gist_id from config.
 * @param {string} token - GITHUB_TOKEN / GIST_AUTH_TOKEN.
 * @param {{ jitterMs?: number }} [opts] - Max jitter in ms (default 5000).
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function pushHeartbeat(payload, gistId, token, opts = {}) {
  if (!gistId || !token) {
    return { ok: false, error: "missing gistId or token" };
  }

  // Jitter: random delay 0–jitterMs to stagger fleet writes.
  const maxJitter = opts.jitterMs ?? 5000;
  if (maxJitter > 0) {
    const jitter = randomInt(0, maxJitter + 1);
    await new Promise((r) => setTimeout(r, jitter));
  }

  const machine = payload.machine ?? hostname().toLowerCase();
  const filename = `${HEARTBEAT_FILENAME_PREFIX}${machine}.json`;

  try {
    const result = await writeGistFile(gistId, filename, payload, { token });
    return result;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Collect an environmental health snapshot. Cross-platform (Windows/POSIX).
 * Best-effort: any field that fails to read returns a safe default.
 * Never throws.
 *
 * @returns {object} environmental health snapshot
 */
export function collectEnvHealth() {
  try {
    return {
      gemini_key_set: !!process.env.GEMINI_API_KEY,
      mistral_key_set: !!process.env.MISTRAL_API_KEY,
      github_token_set: !!process.env.GITHUB_TOKEN,
      gist_token_set: !!(process.env.GIST_AUTH_TOKEN || process.env.GITHUB_TOKEN),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime_sec: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage.rss?.() ?? process.memoryUsage().rss / (1024 * 1024)),
    };
  } catch {
    // Absolute fallback: some fields (e.g. memoryUsage) might throw in
    // constrained environments.
    return {
      gemini_key_set: !!process.env.GEMINI_API_KEY,
      mistral_key_set: !!process.env.MISTRAL_API_KEY,
      github_token_set: !!process.env.GITHUB_TOKEN,
      platform: process.platform,
    };
  }
}

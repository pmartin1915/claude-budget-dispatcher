// log.mjs — JSONL append logging and last-run marker for dispatch.mjs.

import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = resolve(__dirname, "..", "..", "status");
const LOG_PATH = resolve(STATUS_DIR, "budget-dispatch-log.jsonl");
const LAST_RUN_PATH = resolve(STATUS_DIR, "budget-dispatch-last-run.json");

function ensureStatusDir() {
  if (!existsSync(STATUS_DIR)) {
    mkdirSync(STATUS_DIR, { recursive: true });
  }
}

/**
 * Append one JSONL record to the dispatch log.
 * @param {object} entry - Log fields (ts is auto-added if missing)
 */
export function appendLog(entry) {
  ensureStatusDir();
  const record = { ts: new Date().toISOString(), ...entry };
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
}

/**
 * Write the last-run marker file (used by monitoring / dashboards).
 * @param {object} result - Final outcome fields
 * @param {number} durationMs - Total wall-clock time in ms
 */
export function writeLastRun(result, durationMs) {
  ensureStatusDir();
  writeFileSync(
    LAST_RUN_PATH,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: result.outcome,
        error: result.reason ?? "",
        duration_ms: durationMs,
        engine: "dispatch.mjs",
      },
      null,
      2
    )
  );
}

/**
 * Count today's non-skipped runs in the JSONL log.
 * @returns {number}
 */
export function countTodayRuns() {
  if (!existsSync(LOG_PATH)) return 0;

  const lines = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);

  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let count = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (
        obj.ts?.startsWith(todayPrefix) &&
        obj.outcome !== "skipped"
      ) {
        count++;
      }
    } catch {
      // corrupt line, skip
    }
  }
  return count;
}

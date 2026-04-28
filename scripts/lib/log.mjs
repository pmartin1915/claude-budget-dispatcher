// log.mjs — JSONL append logging and last-run marker for dispatch.mjs.

import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// BUDGET_DISPATCH_STATUS_DIR overrides the default for tests, preventing
// unit-test fixtures (e.g. {outcome:"test-success", duration_ms:1234})
// from polluting the live JSONL/last-run files that fleet.mjs syncs to
// the status gist. Production reads the resolved default.
const STATUS_DIR = process.env.BUDGET_DISPATCH_STATUS_DIR
  ? resolve(process.env.BUDGET_DISPATCH_STATUS_DIR)
  : resolve(__dirname, "..", "..", "status");
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
 * Count today's non-skipped runs in the JSONL log (R-5 optimized).
 * Reads in reverse and stops as soon as it hits a previous day's entry,
 * so only today's entries are parsed regardless of total log size.
 * Corrupt lines are skipped individually — a single bad line can't break
 * the entire gate check.
 * @returns {number}
 */
export function countTodayRuns() {
  if (!existsSync(LOG_PATH)) return 0;

  let content;
  try {
    content = readFileSync(LOG_PATH, "utf8");
  } catch {
    return 0; // unreadable log — fail safe (count=0 permits dispatch)
  }

  const lines = content.split("\n").filter(Boolean);
  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let count = 0;

  // Walk backwards — today's entries are at the end
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!obj.ts?.startsWith(todayPrefix)) {
        break; // Hit a previous day — done scanning
      }
      if (
        obj.outcome !== "skipped" &&
        obj.outcome !== "wrapper-success"
      ) {
        count++;
      }
    } catch {
      // corrupt line, skip but keep scanning
    }
  }
  return count;
}

/**
 * Rotate the JSONL log — archive entries older than `retainDays` (R-5).
 * Called at dispatcher startup. Writes old entries to a dated archive file
 * and truncates the main log to only recent entries.
 * @param {number} [retainDays=7] - Days of entries to keep in the main log
 */
export function rotateLog(retainDays = 7) {
  if (!existsSync(LOG_PATH)) return;

  let content;
  try {
    content = readFileSync(LOG_PATH, "utf8");
  } catch {
    return;
  }

  const lines = content.split("\n").filter(Boolean);
  if (lines.length < 100) return; // Don't bother rotating small logs

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retainDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const keep = [];
  const archive = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.ts && obj.ts.slice(0, 10) < cutoffStr) {
        archive.push(line);
      } else {
        keep.push(line);
      }
    } catch {
      keep.push(line); // Keep corrupt lines in main log for debugging
    }
  }

  if (archive.length === 0) return;

  // Write archive
  const archivePath = resolve(STATUS_DIR, `budget-dispatch-log-archive-${cutoffStr}.jsonl`);
  try {
    appendFileSync(archivePath, archive.join("\n") + "\n");
    // Rewrite main log with only recent entries
    writeFileSync(LOG_PATH, keep.join("\n") + "\n");
    console.log(`[log] rotated ${archive.length} entries to ${archivePath}`);
  } catch (e) {
    console.warn(`[log] rotation failed: ${e.message}`);
  }
}

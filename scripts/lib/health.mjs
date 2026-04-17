// Dispatcher health summary. Reads the JSONL log and reports whether
// the dispatcher is producing successful commits.
//
// State rules (binary):
//   down     -> consecutive_errors >= 3 OR hours_since_success > 6
//   healthy  -> otherwise
//
// A "success" is a real dispatch that produced a commit on an auto/ branch
// (outcome === "success"). Reverts, errors, skips, and dry-runs do NOT
// count as success, because Perry's goal is "am I getting useful work".

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_OUTCOMES = new Set(["success", "error", "reverted", "skipped", "dry-run"]);
const DOWN_ERROR_STREAK = 3;
const DOWN_HOURS_WITHOUT_SUCCESS = 6;

function parseLines(raw) {
  // Split on LF or CRLF. PowerShell's Add-Content writes CRLF on Windows;
  // JSON.parse tolerates a trailing \r as whitespace (ECMA-404) so the old
  // `split("\n")` worked, but splitting on /\r?\n/ removes that dependency.
  return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function computeHealth(logPath) {
  let entries = [];
  try {
    entries = parseLines(readFileSync(logPath, "utf8"));
  } catch {
    return { state: "unknown", reason: "log unreadable", last_success_ts: null, consecutive_errors: 0, hours_since_success: null };
  }

  const real = entries.filter((e) => REAL_OUTCOMES.has(e.outcome));

  // Most recent real success
  let lastSuccessTs = null;
  for (let i = real.length - 1; i >= 0; i--) {
    if (real[i].outcome === "success") { lastSuccessTs = real[i].ts; break; }
  }

  // Consecutive errors from the tail. Skips and dry-runs are neutral (neither
  // success nor failure), so they don't break the streak. Success or reverted
  // DOES break it, because those indicate the dispatcher is running code.
  let consecutiveErrors = 0;
  for (let i = real.length - 1; i >= 0; i--) {
    const o = real[i].outcome;
    if (o === "error") consecutiveErrors++;
    else if (o === "skipped" || o === "dry-run") continue;
    else break;
  }

  const hoursSinceSuccess = lastSuccessTs
    ? (Date.now() - new Date(lastSuccessTs).getTime()) / 3_600_000
    : null;

  let state = "healthy";
  let reason = "ok";

  if (consecutiveErrors >= DOWN_ERROR_STREAK) {
    state = "down";
    reason = `${consecutiveErrors} consecutive errors`;
  } else if (hoursSinceSuccess !== null && hoursSinceSuccess > DOWN_HOURS_WITHOUT_SUCCESS) {
    state = "down";
    reason = `no successful dispatch in ${hoursSinceSuccess.toFixed(1)}h`;
  } else if (lastSuccessTs === null && real.length > 20) {
    state = "down";
    reason = "no successful dispatch on record";
  }

  return {
    state,
    reason,
    last_success_ts: lastSuccessTs,
    consecutive_errors: consecutiveErrors,
    hours_since_success: hoursSinceSuccess,
    computed_at: new Date().toISOString(),
  };
}

export function writeHealthFile(logPath, outPath) {
  const health = computeHealth(logPath);
  writeFileSync(outPath, JSON.stringify(health, null, 2));
  return health;
}

// CLI entry: `node scripts/lib/health.mjs <logPath> <outPath>`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , logPath, outPath] = process.argv;
  if (!logPath || !outPath) {
    console.error("Usage: node scripts/lib/health.mjs <logPath> <outPath>");
    process.exit(1);
  }
  const h = writeHealthFile(logPath, outPath);
  console.log(`health: ${h.state} (${h.reason})`);
}

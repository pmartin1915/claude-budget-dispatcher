// Dispatcher health summary. Reads the JSONL log and reports whether
// the dispatcher is producing successful commits.
//
// State rules (four-state, highest wins):
//   down      -> consecutive_errors >= 3 OR hours_since_success > 6 with non-benign skips
//   degraded  -> structural_failures >= DEGRADED_THRESHOLD in last DEGRADED_WINDOW cycles
//   idle      -> hours_since_success > 6 AND recent entries are all benign skips
//   healthy   -> otherwise
//
// "degraded" catches silent structural failures (selector-failed, router-failed)
// that the old three-state model collapsed into "idle". Phase 2 of
// PLAN-smooth-error-handling-and-auto-update.md.
//
// A "success" is a real dispatch that produced a commit on an auto/ branch
// (outcome === "success"). Reverts, errors, skips, and dry-runs do NOT
// count as success, because Perry's goal is "am I getting useful work".

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_OUTCOMES = new Set(["success", "error", "reverted", "skipped", "dry-run"]);
const DOWN_ERROR_STREAK = 3;
const DOWN_HOURS_WITHOUT_SUCCESS = 6;
const DEGRADED_WINDOW = 6;
const DEGRADED_THRESHOLD = 3;

// Benign skips: the dispatcher chose not to work (legitimate, not broken).
// Structural skips: the dispatcher tried to work and broke.
// IMPORTANT: if you add a new gate skip reason in dispatch.mjs, add it here
// too. Otherwise the new reason will be misclassified as structural and
// trigger false "degraded" alerts.
const BENIGN_SKIP_REASONS = new Set([
  "user-active",
  "paused",
  "budget-below-headroom",
  "weekly-reserve-floor-threatened",
  "trailing30-headroom-below-trigger",
  "daily-quota-reached",
  "dispatch-locked",
  "estimator-snapshot-parse-error",
  "no-eligible-projects",
  "insufficient-history-for-bootstrap",
  "insufficient-history-span",
]);

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

  // Classify recent skips: benign (chose not to work) vs structural (tried and broke).
  // A skip is structural only if it has a reason AND that reason is NOT benign.
  // Skips with no reason (legacy log entries, dry-runs) are treated as benign.
  const isStructuralSkip = (e) =>
    e.outcome === "skipped" && e.reason && !BENIGN_SKIP_REASONS.has(e.reason);
  const isBenignSkipOrDryRun = (e) =>
    e.outcome === "dry-run" ||
    (e.outcome === "skipped" && (!e.reason || BENIGN_SKIP_REASONS.has(e.reason)));

  const tail = real.slice(-DEGRADED_WINDOW);
  const recentStructuralSkips = tail.filter(isStructuralSkip).length;
  // recentAllBenign: the tail contains ONLY benign skips/dry-runs (no errors,
  // no reverts, no structural skips). If there are errors mixed in, this is
  // NOT an idle state — it's potentially down.
  const recentAllBenign = tail.length > 0 && tail.every(
    (e) => isBenignSkipOrDryRun(e) || e.outcome === "success"
  );

  // Find the most recent structural failure for the alert body
  let lastStructuralFailure = null;
  for (let i = real.length - 1; i >= 0; i--) {
    if (isStructuralSkip(real[i])) {
      lastStructuralFailure = real[i];
      break;
    }
  }

  // State determination (highest priority wins)
  let state = "healthy";
  let reason = "ok";

  if (consecutiveErrors >= DOWN_ERROR_STREAK) {
    state = "down";
    reason = `${consecutiveErrors} consecutive errors`;
  } else if (hoursSinceSuccess !== null && hoursSinceSuccess > DOWN_HOURS_WITHOUT_SUCCESS) {
    if (recentAllBenign) {
      state = "idle";
      reason = `no work found in ${hoursSinceSuccess.toFixed(1)}h`;
    } else {
      state = "down";
      reason = `no successful dispatch in ${hoursSinceSuccess.toFixed(1)}h`;
    }
  } else if (lastSuccessTs === null && real.length > 20) {
    if (recentAllBenign) {
      state = "idle";
      reason = "running but no dispatches yet";
    } else {
      state = "down";
      reason = "no successful dispatch on record";
    }
  }

  // Degraded: structural failures in the recent window, but not yet down.
  // Only fires if we haven't already escalated to down.
  if (state !== "down" && recentStructuralSkips >= DEGRADED_THRESHOLD) {
    state = "degraded";
    const failReason = lastStructuralFailure?.reason ?? "unknown";
    const failDetail = lastStructuralFailure?.error_detail ?? "";
    reason = `${recentStructuralSkips} structural failures in last ${tail.length} cycles` +
      (failDetail ? ` (${failReason}: ${failDetail})` : ` (${failReason})`);
  }

  return {
    state,
    reason,
    last_success_ts: lastSuccessTs,
    consecutive_errors: consecutiveErrors,
    structural_failures: recentStructuralSkips,
    hours_since_success: hoursSinceSuccess,
    last_structural_failure: lastStructuralFailure ? {
      reason: lastStructuralFailure.reason,
      detail: lastStructuralFailure.error_detail ?? null,
      model: lastStructuralFailure.error_model ?? null,
      message: lastStructuralFailure.error_message ?? null,
      ts: lastStructuralFailure.ts,
    } : null,
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

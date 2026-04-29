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
// Sustained selector_fallback usage means Gemini is unreachable cycle after
// cycle (free-tier quota blackout, key revoked, sustained outage). Three of
// the last six cycles in fallback = 50% sample rate, enough signal to alert
// without flapping. Hardcoded for v1; see handoff for "DO NOT add a config
// key to tune this yet."
const FALLBACK_DEGRADED_THRESHOLD = 3;

// No-progress detector: an opted-in auto-push project that has been cycling
// for 3 calendar days without a single successful push is a silent failure mode
// the existing alerting doesn't catch. 3 days is the sweet spot:
//   - 1 day is too noisy (gating, allowlist churn, or startup warmup periods
//     are all plausible reasons for a newly-activated project to produce 0 PRs
//     on day 1).
//   - 7 days is too late — a week of silent saturation (97 cycles/day × 7 days
//     = ~679 blocked cycles) is real cost, not background noise.
//   - 3 days with at least MIN_PUSH_ATTEMPTS push-phase entries means the
//     mechanism is actively firing on the project yet never succeeding; that
//     is the targeted signal.
const NO_PROGRESS_DAYS = 3;
// Minimum number of push-phase attempts in the window before the no-progress
// rule fires. Guards against false positives on freshly-opted-in projects
// (day 1 warmup) or projects with legitimately low cycle activity (e.g. a
// project that is only in rotation on one machine). With the current 97
// cycles/day fleet rate, 5 attempts over 3 days requires that the project
// was eligible on at least 5 cycles — strong signal that dispatching IS
// happening on this project.
const MIN_PUSH_ATTEMPTS_FOR_NO_PROGRESS = 5;

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

/**
 * No-progress detector: identifies auto-push projects that have been
 * dispatching for NO_PROGRESS_DAYS calendar days but never produced a
 * successful push. Pure function — no I/O.
 *
 * Push-phase JSONL entries (written by maybeAutoPush) carry:
 *   { phase: "auto-push", outcome: "auto-push-success"|"auto-push-blocked"|
 *     "auto-push-failed"|"auto-push-dry-run", project, ts, ... }
 *
 * "Attempt" = any auto-push phase entry (including blocked/failed — these mean
 * the mechanism ran and tried to push, not just that conditions were skipped
 * upstream). "auto-push-dry-run" is excluded because dry-run never makes a
 * real push decision; it is a test-mode artifact.
 *
 * @param {object[]} entries - All raw JSONL entries (not filtered to REAL_OUTCOMES).
 * @param {Date} now - Current time (injected for testability).
 * @returns {{ stuck: boolean, projects: Array<{project: string, attempts: number,
 *   pushed_count: number, last_attempt_ts: string|null}> }}
 */
export function evaluateNoProgress(entries, now) {
  const windowStart = new Date(now.getTime() - NO_PROGRESS_DAYS * 24 * 3_600_000);

  // Collect push-phase entries within the window.
  // Exclude "auto-push-dry-run" — dry-runs never reflect a real push decision.
  const pushEntries = entries.filter(
    (e) =>
      e.phase === "auto-push" &&
      e.outcome !== "auto-push-dry-run" &&
      e.ts &&
      new Date(e.ts) >= windowStart
  );

  // Group by project.
  /** @type {Map<string, {attempts: number, pushed_count: number, last_attempt_ts: string|null}>} */
  const byProject = new Map();
  for (const e of pushEntries) {
    const key = e.project ?? "(unknown)";
    if (!byProject.has(key)) {
      byProject.set(key, { attempts: 0, pushed_count: 0, last_attempt_ts: null });
    }
    const rec = byProject.get(key);
    rec.attempts++;
    if (e.outcome === "auto-push-success") rec.pushed_count++;
    // Keep the most-recent timestamp for reporting.
    if (!rec.last_attempt_ts || e.ts > rec.last_attempt_ts) {
      rec.last_attempt_ts = e.ts;
    }
  }

  // Find stuck projects: enough attempts to be significant, but zero pushes.
  const stuckProjects = [];
  for (const [project, rec] of byProject) {
    if (rec.attempts >= MIN_PUSH_ATTEMPTS_FOR_NO_PROGRESS && rec.pushed_count === 0) {
      stuckProjects.push({ project, ...rec });
    }
  }

  return {
    stuck: stuckProjects.length > 0,
    projects: stuckProjects,
  };
}

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
    return { state: "unknown", reason: "log unreadable", last_success_ts: null, consecutive_errors: 0, hours_since_success: null, no_progress_projects: [] };
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
  const recentFallbacks = tail.filter((e) => e.selector_fallback === true).length;
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

  // Fallback-rate degraded: catches sustained Gemini quota exhaustion that
  // would otherwise stay silent because fallback dispatches return success.
  // Doesn't override an existing structural-skip degraded reason (that's
  // more informative when both conditions fire); only escalates from healthy.
  if (state === "healthy" && recentFallbacks >= FALLBACK_DEGRADED_THRESHOLD) {
    state = "degraded";
    reason = `${recentFallbacks} of last ${tail.length} cycles used selector fallback (Gemini quota or auth?)`;
  }

  // No-progress degraded: an opted-in auto-push project that has cycled
  // for 3+ days without a single successful push is a silent failure mode.
  // Uses the full `entries` list (not `real`) because push-phase entries have
  // outcome "auto-push-*", which REAL_OUTCOMES does not include.
  // Only escalates from healthy — an already-down or degraded state is more
  // informative and should not be overridden.
  const noProgressResult = evaluateNoProgress(entries, new Date());
  if (state === "healthy" && noProgressResult.stuck) {
    state = "degraded";
    const first = noProgressResult.projects[0];
    reason = `no-progress: ${first.project} has 0 pushes in ${first.attempts} attempts over ${NO_PROGRESS_DAYS} days`;
  }

  return {
    state,
    reason,
    last_success_ts: lastSuccessTs,
    consecutive_errors: consecutiveErrors,
    structural_failures: recentStructuralSkips,
    selector_fallback_count: recentFallbacks,
    hours_since_success: hoursSinceSuccess,
    last_structural_failure: lastStructuralFailure ? {
      reason: lastStructuralFailure.reason,
      detail: lastStructuralFailure.error_detail ?? null,
      model: lastStructuralFailure.error_model ?? null,
      message: lastStructuralFailure.error_message ?? null,
      ts: lastStructuralFailure.ts,
    } : null,
    no_progress_projects: noProgressResult.projects,
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

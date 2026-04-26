// Per-machine fleet snapshot. Reads the JSONL log and writes a summary of
// what this machine's dispatcher last did, for cross-machine visibility via
// the shared status gist.
//
// Two pairs of "last" fields by design:
//   last_run_*      -> most recent JSONL entry (wrapper-success, skipped,
//                      error). Shows "is this machine alive, when did it
//                      last check in."
//   last_dispatch_* -> most recent entry with outcome === "success" AND a
//                      populated project field. Shows "last time this
//                      machine actually committed code."
// Separation matters: a machine skipping user-active all day is alive, not
// dead. Keeping the two apart prevents the fleet view from looking red when
// it should look yellow-idle.
//
// Schema additions 2026-04-26 (operator opt-in diagnostic surfaces):
//   last_run_reason         -> reason field on the most recent skip/error
//                              entry (e.g. "daily-quota-reached"). Was
//                              already in the JSONL but not surfaced.
//   dispatches_today        -> count of today's non-skip non-wrapper-success
//                              entries. Gives the dashboard a per-machine
//                              quota counter.
//   dispatches_today_max    -> upper bound the gate is enforcing today
//                              (from usage-estimate.json's deadline-scaled
//                              effective_max_runs_per_day). null when no
//                              snapshot is readable.
//   weekly_pct / monthly_pct / weekly_headroom_pct / weekly_gate_passes /
//   monthly_gate_passes / weekly_hours_until_reset / urgency_mode
//                           -> selected fields from usage-estimate.json
//                              (sibling file in same status/ dir). Gives
//                              the dashboard the burn-rate context that
//                              explains every skip the dispatcher takes.
// All additions are best-effort: missing/malformed usage-estimate.json
// produces nulls (never throws). Existing fields are untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseLines(raw) {
  // Split on LF or CRLF. PowerShell's Add-Content writes CRLF on Windows;
  // JSON.parse tolerates a trailing \r as whitespace (ECMA-404) so the old
  // `split("\n")` worked, but splitting on /\r?\n/ removes that dependency.
  return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Count today's "real" dispatch entries — same definition gates.mjs uses
 * (anything other than skipped/wrapper-success counts toward the daily
 * quota). Walks backwards and stops at the first pre-today entry.
 *
 * @param {object[]} entries - Parsed JSONL entries (chronological order)
 * @param {Date} [now] - Optional clock injection for testing
 * @returns {number}
 */
export function countDispatchesToday(entries, now = new Date()) {
  const todayPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (typeof e?.ts !== "string") continue;
    if (!e.ts.startsWith(todayPrefix)) {
      // Below today — done. (Entries are chronological so anything earlier
      // in the array is older.)
      break;
    }
    if (e.outcome !== "skipped" && e.outcome !== "wrapper-success") {
      count++;
    }
  }
  return count;
}

/**
 * Best-effort read of usage-estimate.json from the sibling status/ dir.
 * Returns selected gate-relevant fields or nulls. Never throws — a missing,
 * unreadable, or malformed snapshot yields all-null fields rather than
 * cascading into the fleet writer.
 *
 * @param {string} logPath - Path to budget-dispatch-log.jsonl. The
 *   estimator writes usage-estimate.json next to the log file in the same
 *   status/ directory; we look there.
 * @returns {{
 *   dispatches_today_max: number|null,
 *   weekly_pct: number|null,
 *   weekly_headroom_pct: number|null,
 *   weekly_gate_passes: boolean|null,
 *   weekly_hours_until_reset: number|null,
 *   urgency_mode: string|null,
 *   monthly_pct: number|null,
 *   monthly_gate_passes: boolean|null,
 *   estimator_skip_reason: string|null,
 *   estimator_generated_at: string|null,
 * }}
 */
export function readEstimatorSnapshot(logPath) {
  const empty = {
    dispatches_today_max: null,
    weekly_pct: null,
    weekly_headroom_pct: null,
    weekly_gate_passes: null,
    weekly_hours_until_reset: null,
    urgency_mode: null,
    monthly_pct: null,
    monthly_gate_passes: null,
    estimator_skip_reason: null,
    estimator_generated_at: null,
  };
  let raw;
  try {
    const snapPath = pathResolve(dirname(logPath), "usage-estimate.json");
    raw = readFileSync(snapPath, "utf8");
  } catch {
    return empty;
  }
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    return empty;
  }
  // Numeric fields: only surface when they're actually finite. snap?.weekly
  // can be missing in legacy snapshots (insufficient-history-span); guard.
  const num = (v) => (Number.isFinite(v) ? v : null);
  const bool = (v) => (typeof v === "boolean" ? v : null);
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    dispatches_today_max: num(snap?.weekly?.effective_max_runs_per_day),
    weekly_pct: num(snap?.weekly?.actual_pct),
    weekly_headroom_pct: num(snap?.weekly?.headroom_pct),
    weekly_gate_passes: bool(snap?.weekly?.gate_passes),
    weekly_hours_until_reset: num(snap?.weekly?.hours_until_reset),
    urgency_mode: str(snap?.weekly?.urgency_mode),
    monthly_pct: num(snap?.trailing30?.actual_pct),
    monthly_gate_passes: bool(snap?.trailing30?.gate_passes),
    estimator_skip_reason: str(snap?.skip_reason),
    estimator_generated_at: str(snap?.generated_at),
  };
}

export function computeFleet(logPath, machineName) {
  let entries = [];
  try {
    entries = parseLines(readFileSync(logPath, "utf8"));
  } catch {
    return {
      machine: machineName,
      last_run_ts: null,
      last_run_outcome: null,
      last_run_reason: null,
      last_engine: null,
      wrapper_duration_sec: null,
      last_project: null,
      last_task: null,
      last_dispatch_outcome: null,
      last_dispatch_ts: null,
      last_error_reason: null,
      last_error_phase: null,
      last_error_ts: null,
      last_error_detail: null,
      last_error_model: null,
      last_error_retries: null,
      last_error_message: null,
      consecutive_errors: 0,
      dispatches_today: 0,
      ...readEstimatorSnapshot(logPath),
      computed_at: new Date().toISOString(),
    };
  }

  const lastRun = entries.length > 0 ? entries[entries.length - 1] : null;

  let lastDispatch = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.outcome === "success" && e.project) { lastDispatch = e; break; }
  }

  // Part 20: richest remote-debug signal. Most recent failure (error or
  // revert) so a laptop viewing fleet-<hostname>.json knows not just that
  // something went wrong but WHY and IN WHICH PHASE.
  //
  // Phase 1 of PLAN-smooth-error-handling-and-auto-update.md: also treat
  // selector-failed skips as "last error" material. They're outcome=skipped
  // structurally (no code ran) but represent the dispatcher trying-and-
  // breaking, which is exactly the signal a remote observer wants to see.
  let lastError = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const isStructuralSkip = e.outcome === "skipped" && e.reason === "selector-failed";
    if (e.outcome === "error" || e.outcome === "reverted" || isStructuralSkip) {
      lastError = e;
      break;
    }
  }

  // Consecutive error streak at tail. Mirrors health.mjs logic: skips and
  // dry-runs are neutral (don't break the streak); success and reverted
  // both break it. "reverted" means the dispatcher is running code, which
  // is the opposite of the "consecutive errors" failure mode we care about.
  let consecutiveErrors = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const o = entries[i].outcome;
    if (o === "error") consecutiveErrors++;
    else if (o === "skipped" || o === "dry-run" || o === "wrapper-success") continue;
    else break;
  }

  return {
    machine: machineName,
    last_run_ts: lastRun?.ts ?? null,
    last_run_outcome: lastRun?.outcome ?? null,
    // Surface the most recent skip/error reason. The dashboard pivots on
    // this for the per-machine "why is it idle" chip — without it the only
    // signal was last_error_reason, which only fires for non-benign skips.
    last_run_reason: lastRun?.reason ?? null,
    last_engine: lastRun?.engine ?? null,
    wrapper_duration_sec: lastRun?.wrapper_duration_sec ?? null,
    last_project: lastDispatch?.project ?? null,
    last_task: lastDispatch?.task ?? null,
    last_dispatch_outcome: lastDispatch?.outcome ?? null,
    last_dispatch_ts: lastDispatch?.ts ?? null,
    last_error_reason: lastError?.reason ?? null,
    last_error_phase: lastError?.phase ?? null,
    last_error_ts: lastError?.ts ?? null,
    last_error_detail: lastError?.error_detail ?? null,
    last_error_model: lastError?.error_model ?? null,
    last_error_retries: lastError?.error_retries ?? null,
    last_error_message: lastError?.error_message ?? null,
    consecutive_errors: consecutiveErrors,
    dispatches_today: countDispatchesToday(entries),
    // Estimator-sourced burn/gate fields (best-effort; nulls when no
    // usage-estimate.json on this host or the snapshot is malformed).
    ...readEstimatorSnapshot(logPath),
    computed_at: new Date().toISOString(),
  };
}

/**
 * Pure helper for the dashboard's fleet-aggregate "last successful dispatch"
 * computation. The shared health.json represents only the writing host's
 * view (last writer wins on the gist), so it under-reports when one machine
 * succeeded recently but a different machine wrote health.json from a stale
 * log. This function takes the per-machine fleet snapshots and returns the
 * most-recent last_dispatch_ts across all of them, plus the machine name
 * that produced it.
 *
 * MIRRORS docs/fleet-dashboard.html:aggregateLastDispatch — keep in sync.
 * The dashboard ships as static HTML with no build step, so the helper is
 * duplicated rather than imported. Any logic change must land in both
 * files. The mjs side is covered by fleet.test.mjs; smoke against the live
 * gist covers the dashboard side.
 *
 * @param {Array<{machine?: string, last_dispatch_ts?: string|null}>} fleetSnaps
 * @returns {{ts: string|null, machine: string|null}}
 */
export function aggregateLastDispatch(fleetSnaps) {
  let bestTs = null;
  let bestMachine = null;
  let bestMs = -Infinity;
  for (const snap of fleetSnaps ?? []) {
    const ts = snap?.last_dispatch_ts;
    if (typeof ts !== "string") continue;
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestTs = ts;
      bestMachine = snap?.machine ?? null;
    }
  }
  return { ts: bestTs, machine: bestMachine };
}

export function writeFleetFile(logPath, outPath, machineName) {
  const snap = computeFleet(logPath, machineName);
  writeFileSync(outPath, JSON.stringify(snap, null, 2));
  return snap;
}

// CLI: node scripts/lib/fleet.mjs <logPath> <outPath> [machineName]
// machineName defaults to os.hostname() lowercased. Override when hosts
// collide (e.g. two default DESKTOP-XXXX machines on different networks).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , logPath, outPath, machineArg] = process.argv;
  if (!logPath || !outPath) {
    console.error("Usage: node scripts/lib/fleet.mjs <logPath> <outPath> [machineName]");
    process.exit(1);
  }
  const machine = (machineArg || hostname()).toLowerCase();
  const snap = writeFleetFile(logPath, outPath, machine);
  console.log(`fleet: ${snap.machine} last_run=${snap.last_run_outcome ?? "none"} last_dispatch=${snap.last_project ?? "none"}`);
}

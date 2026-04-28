// gates.mjs — Phase 1: Budget gate, activity gate, daily quota, PAUSED check.
// All local, zero LLM tokens.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { countTodayRuns } from "./log.mjs";
import { getSafeTestEnv } from "./worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "..", "..");
// BUDGET_DISPATCH_STATUS_DIR overrides the snapshot location for tests so
// node-engine marker writes don't overwrite the live usage-estimate.json.
const STATUS_DIR = process.env.BUDGET_DISPATCH_STATUS_DIR
  ? resolve(process.env.BUDGET_DISPATCH_STATUS_DIR)
  : resolve(REPO_ROOT, "status");
const SNAPSHOT_PATH = resolve(STATUS_DIR, "usage-estimate.json");

/**
 * Run all gate checks. Returns { proceed, reason } where proceed=false means
 * the dispatcher should skip this cycle.
 * @param {object} config - Parsed budget.json
 * @param {{ engine?: string, force?: boolean }} [opts] - Options. engine="node" skips budget gate. force=true skips activity gate (for manual testing).
 * @returns {{ proceed: boolean, reason: string|null }}
 */
export function runGates(config, opts = {}) {
  // Step 0: PAUSED kill switch
  const pauseFile = config.kill_switches?.pause_file;
  const configPausePath = resolve(REPO_ROOT, "config", "PAUSED");
  if (config.paused === true) {
    return { proceed: false, reason: "paused-config" };
  }
  if (existsSync(configPausePath)) {
    return { proceed: false, reason: "paused-sentinel" };
  }
  if (pauseFile && existsSync(pauseFile)) {
    return { proceed: false, reason: "paused-sentinel" };
  }

  // Step 1: Budget gate.
  //
  // Claude engine: refresh estimate from transcripts and gate. Refreshing has
  // zero LLM cost (just local file scanning).
  //
  // Node engine: skip the estimator entirely and write a minimal marker. The
  // estimator output uses Claude-Max vocabulary (weekly_pct,
  // weekly-reserve-floor-threatened) that the node engine doesn't consume,
  // and fleet.mjs / fleet-<host>.json was surfacing those fields as if they
  // gated dispatch when in fact node-engine cycles ignore them. The marker
  // makes readEstimatorSnapshot() naturally return null for the Claude-Max
  // fields (no .weekly / .trailing30 / .skip_reason keys), so the fleet
  // dashboard stops showing the misleading "weekly-reserve-floor-threatened"
  // skip reason against successful node-engine dispatches. Auto-mode in
  // run-dispatcher.ps1 runs its own estimator before invoking dispatch.mjs,
  // so it does not depend on this refresh.
  let snapshot = null;
  const isNode = opts.engine === "node";

  if (isNode) {
    try {
      writeFileSync(
        SNAPSHOT_PATH,
        JSON.stringify(
          {
            engine: "node",
            refresh_skipped: true,
            generated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (e) {
      console.warn(`[gates] failed to write node-engine marker: ${e.message}`);
    }
    console.log("[gates] node engine: skipping budget estimator (marker written)");
  } else {
    const estimatorScript = resolve(SCRIPTS_DIR, "estimate-usage.mjs");
    try {
      execFileSync("node", [estimatorScript], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
        env: getSafeTestEnv(),
      });
    } catch (e) {
      return { proceed: false, reason: `estimator-error-exit-${e.status ?? "unknown"}` };
    }

    if (existsSync(SNAPSHOT_PATH)) {
      try {
        snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
      } catch (parseErr) {
        return { proceed: false, reason: `estimator-snapshot-parse-error: ${parseErr.message}` };
      }
    }

    if (!snapshot) {
      return { proceed: false, reason: "estimator-no-snapshot" };
    }
    if (!snapshot.dispatch_authorized) {
      return { proceed: false, reason: snapshot.skip_reason ?? "gate-red" };
    }
  }

  // Step 2: Activity gate — run check-idle.mjs
  if (opts.force) {
    console.log("[gates] activity gate bypassed (--force)");
  } else {
    const idleScript = resolve(SCRIPTS_DIR, "check-idle.mjs");
    const idleMinutes = config.activity_gate?.idle_minutes_required ?? 20;
    try {
      execFileSync("node", [idleScript, String(idleMinutes)], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        env: getSafeTestEnv(),
      });
      // Exit 0 = idle, proceed
    } catch (e) {
      if (e.status === 1) {
        return { proceed: false, reason: "user-active" };
      }
      return { proceed: false, reason: "activity-gate-error" };
    }
  }

  // Step 3: Daily quota
  const effectiveMaxRuns = snapshot?.weekly?.effective_max_runs_per_day
    ?? config.max_runs_per_day
    ?? 8;
  const todayRuns = countTodayRuns();
  if (todayRuns >= effectiveMaxRuns) {
    return { proceed: false, reason: "daily-quota-reached" };
  }

  // Step 4: Dry-run gate (handled by caller, but check config here too)
  if (config.dry_run === true) {
    return { proceed: true, reason: null, dryRun: true };
  }

  return { proceed: true, reason: null, dryRun: false };
}

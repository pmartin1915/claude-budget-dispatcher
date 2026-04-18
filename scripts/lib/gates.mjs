// gates.mjs — Phase 1: Budget gate, activity gate, daily quota, PAUSED check.
// All local, zero LLM tokens.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { countTodayRuns } from "./log.mjs";
import { getSafeTestEnv } from "./worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "..", "..");

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

  // Step 1: Budget gate — always refresh estimate, gate only for Claude engine.
  // The node engine uses free-tier APIs and doesn't need budget gating, but
  // refreshing the estimate keeps the snapshot current for auto-mode routing
  // and monitoring (zero LLM cost — just local file scanning).
  let snapshot = null;
  const isNode = opts.engine === "node";
  const estimatorScript = resolve(SCRIPTS_DIR, "estimate-usage.mjs");
  try {
    execFileSync("node", [estimatorScript], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
      env: getSafeTestEnv(),
    });
  } catch (e) {
    if (!isNode) {
      return { proceed: false, reason: `estimator-error-exit-${e.status ?? "unknown"}` };
    }
    console.warn(`[gates] estimator refresh failed (non-blocking for node engine): exit ${e.status}`);
  }

  const snapshotPath = resolve(REPO_ROOT, "status", "usage-estimate.json");
  if (existsSync(snapshotPath)) {
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch (parseErr) {
      if (!isNode) {
        return { proceed: false, reason: `estimator-snapshot-parse-error: ${parseErr.message}` };
      }
    }
  }

  if (isNode) {
    console.log("[gates] budget estimate refreshed (node engine, not gating)");
  } else {
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

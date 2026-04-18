#!/usr/bin/env node
// dispatch.mjs — Zero-Claude budget dispatcher.
//
// Replaces the Claude Max prompt (budget-dispatch.md) with a Node.js CLI
// that calls Gemini/Mistral APIs directly. Zero Claude dependency at runtime.
//
// Usage:
//   node scripts/dispatch.mjs              # full run (requires 20 min idle)
//   node scripts/dispatch.mjs --dry-run    # gates + selector + router, no work
//   node scripts/dispatch.mjs --force      # bypass activity gate, do real work
//   node scripts/dispatch.mjs --force --dry-run  # full pipeline inspect, no commit
//
// Environment variables:
//   GEMINI_API_KEY  — Google AI Gemini API key (free tier)
//   MISTRAL_API_KEY — Mistral/Codestral API key (free tier)
//
// Exit codes:
//   0 = ran (dispatched work, skipped, or dry-run)
//   1 = error (non-fatal, logged)
//   2 = fatal setup error

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";

import { runGates } from "./lib/gates.mjs";
import { selectProjectAndTask } from "./lib/selector.mjs";
import { resolveModel } from "./lib/router.mjs";
import { executeWork } from "./lib/worker.mjs";
import { createWorktree, restoreOrigin, verifyAndCommit } from "./lib/verify-commit.mjs";
import { appendLog, writeLastRun, rotateLog } from "./lib/log.mjs";
import { sweepStaleIndexLocks, sweepStaleWorktrees, weeklyGitFsck, weeklyNpmAudit } from "./lib/git-lock.mjs";
import { initThrottle } from "./lib/throttle.mjs";
import { checkAndAlert } from "./lib/alerting.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "budget.json");
let globalStartMs = Date.now();

class DieError extends Error {
  constructor(msg) { super(msg); this.name = "DieError"; }
}

function die(msg) {
  console.error(`[dispatch] FATAL: ${msg}`);
  process.exitCode = 2;
  throw new DieError(msg);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) die(`config missing: ${CONFIG_PATH}`);
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`config parse error: ${e.message}`);
  }
}

function initClients() {
  const geminiKey = process.env.GEMINI_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;

  if (!geminiKey) die("GEMINI_API_KEY environment variable is required");
  if (!mistralKey) die("MISTRAL_API_KEY environment variable is required");

  return {
    gemini: new GoogleGenAI({ apiKey: geminiKey }),
    mistral: new Mistral({ apiKey: mistralKey }),
  };
}

async function main() {
  const startMs = Date.now();
  globalStartMs = startMs;
  const config = loadConfig();
  const dryRun = config.dry_run === true || process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  console.log(`[dispatch] starting (engine=dispatch.mjs${force ? ", force" : ""}${dryRun ? ", dry-run" : ""})`);

  // Register dynamic provider throttle intervals from config
  initThrottle(config.free_model_roster?.providers);

  // Warn about configured providers with missing env vars (non-fatal)
  for (const [name, cfg] of Object.entries(config.free_model_roster?.providers ?? {})) {
    if (cfg.env_key && !process.env[cfg.env_key]) {
      console.warn(`[dispatch] provider "${name}" configured but ${cfg.env_key} not set`);
    }
  }

  // Housekeeping: rotate old log entries (R-5)
  rotateLog();

  // Phase 1: Gates (0 tokens)
  console.log("[dispatch] phase 1: gates");
  const gateResult = runGates(config, { engine: "node", force });
  if (!gateResult.proceed) {
    console.log(`[dispatch] gated: ${gateResult.reason}`);
    appendLog({
      outcome: "skipped",
      reason: gateResult.reason,
      phase: "gate",
      engine: "dispatch.mjs",
    });
    writeLastRun({ outcome: "skipped", reason: gateResult.reason }, Date.now() - startMs);
    return;
  }

  // R-7: remove stale .git/index.lock files from rotation project clones.
  // Safe here because run-dispatcher.ps1's Global\claude-budget-dispatcher
  // mutex (R-3) guarantees no other dispatcher instance is holding a git
  // lock. 30-min age threshold never races a legitimate commit.
  const projectPaths = (config.projects_in_rotation ?? [])
    .map((p) => p.path)
    .filter(Boolean);
  sweepStaleIndexLocks(projectPaths);

  // Stale worktree cleanup: remove auto/* worktrees older than 7 days
  sweepStaleWorktrees(projectPaths);

  // C-4: weekly git fsck on rotation projects (detects object store corruption)
  weeklyGitFsck(projectPaths);

  // S-8: weekly npm audit for supply chain vulnerability monitoring
  weeklyNpmAudit(REPO_ROOT);

  // Initialize API clients (only after gates pass to avoid key errors on no-op)
  const clients = initClients();

  // Phase 2: Selector (Gemini, ~2-5K free tokens)
  console.log("[dispatch] phase 2: selector");
  const selection = await selectProjectAndTask(config, clients);
  if (!selection) {
    console.log("[dispatch] selector returned null, skipping");
    appendLog({
      outcome: "skipped",
      reason: "selector-failed",
      phase: "selector",
      engine: "dispatch.mjs",
    });
    writeLastRun({ outcome: "skipped", reason: "selector-failed" }, Date.now() - startMs);
    return;
  }

  console.log(
    `[dispatch] selected: project=${selection.project} task=${selection.task} reason="${selection.reason}"`
  );

  // Phase 3: Router (0 tokens)
  console.log("[dispatch] phase 3: router");
  const route = resolveModel(selection.task, config.free_model_roster, selection.project);
  console.log(
    `[dispatch] route: delegate_to=${route.delegate_to} model=${route.model} class=${route.taskClass}` +
    (route.auditModel ? ` auditModel=${route.auditModel}` : "") +
    (route.candidates ? ` candidates=[${route.candidates.join(",")}]` : "")
  );

  if (route.delegate_to === "skip") {
    console.log(`[dispatch] route says skip: ${route.reason}`);
    appendLog({
      outcome: "skipped",
      reason: route.reason,
      project: selection.project,
      task: selection.task,
      phase: "router",
      engine: "dispatch.mjs",
    });
    writeLastRun({ outcome: "skipped", reason: route.reason }, Date.now() - startMs);
    return;
  }

  // Dry-run exit point
  if (dryRun) {
    console.log("[dispatch] dry-run: would dispatch, exiting");
    appendLog({
      outcome: "dry-run",
      project: selection.project,
      task: selection.task,
      delegate_to: route.model ?? "local",
      taskClass: route.taskClass,
      reason: selection.reason,
      phase: "dry-run",
      engine: "dispatch.mjs",
    });
    writeLastRun({ outcome: "dry-run" }, Date.now() - startMs);
    return;
  }

  // Phase 4: Worker (free-tier tokens)
  console.log("[dispatch] phase 4: worker");
  let worktree = null;

  try {
    // Create worktree for non-local tasks
    if (route.delegate_to !== "local") {
      console.log("[dispatch] creating worktree");
      worktree = createWorktree(
        selection.projectConfig.path,
        selection.project,
        selection.task
      );
      console.log(`[dispatch] worktree: ${worktree.path} branch=${worktree.branch}`);
    }

    const workResult = await executeWork(
      selection,
      route,
      config,
      clients,
      worktree?.path
    );
    // Attach worktree info for verify-commit
    if (worktree) workResult.worktree = worktree;

    console.log(`[dispatch] worker result: ${workResult.outcome}`);

    // Phase 5: Verify + Commit + Log (0 tokens, except clinical gate)
    console.log("[dispatch] phase 5: verify + commit");
    const finalResult = await verifyAndCommit(
      workResult,
      selection,
      route,
      config,
      clients
    );

    console.log(`[dispatch] final: ${finalResult.outcome}`);

    appendLog({
      ...finalResult,
      phase: "complete",
      engine: "dispatch.mjs",
      duration_ms: Date.now() - startMs,
    });
    writeLastRun(finalResult, Date.now() - startMs);
  } finally {
    // Always restore origin pushurl on worktree (H1 ceremony cleanup)
    if (worktree?.path) {
      restoreOrigin(worktree.path, worktree.originalPushUrl ?? null);
    }
  }
}

main()
  .catch((e) => {
    if (e instanceof DieError) {
      // die() already logged FATAL to stderr and set exitCode=2.
      // Still write JSONL + last-run so the gist sync reflects the error.
      appendLog({ outcome: "error", reason: e.message, phase: "fatal", engine: "dispatch.mjs" });
      writeLastRun({ outcome: "error", reason: e.message }, 0);
      return;
    }
    console.error(`[dispatch] unhandled error: ${e.stack || e.message}`);
    appendLog({
      outcome: "error",
      reason: e.message,
      phase: "unhandled",
      engine: "dispatch.mjs",
    });
    writeLastRun({ outcome: "error", reason: e.message }, Date.now() - globalStartMs);
    process.exitCode = 1;
  })
  .finally(async () => {
    // E1.1: Check health state transitions and send alerts (ntfy.sh).
    try {
      const alertConfig = JSON.parse(readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "budget.json"),
        "utf8",
      ));
      await checkAndAlert(alertConfig);
    } catch (e) {
      console.warn(`[dispatch] alerting check failed (non-fatal): ${e.message}`);
    }
    // Give HTTP keep-alive handles time to drain before forcing exit.
    // setImmediate was insufficient -- Gemini/Mistral clients need more than
    // one tick to close their sockets, causing a libuv UV_HANDLE_CLOSING
    // assertion crash on Windows (exit -1073740791 / 0xC0000409).
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  });

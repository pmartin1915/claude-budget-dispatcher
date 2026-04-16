#!/usr/bin/env node
// dispatch.mjs — Zero-Claude budget dispatcher.
//
// Replaces the Claude Max prompt (budget-dispatch.md) with a Node.js CLI
// that calls Gemini/Mistral APIs directly. Zero Claude dependency at runtime.
//
// Usage:
//   node scripts/dispatch.mjs              # full run
//   node scripts/dispatch.mjs --dry-run    # gates + selector + router, no work
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
import { sweepStaleIndexLocks, weeklyGitFsck } from "./lib/git-lock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "budget.json");

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
  const config = loadConfig();
  const dryRun = config.dry_run === true || process.argv.includes("--dry-run");

  console.log("[dispatch] starting (engine=dispatch.mjs)");

  // Housekeeping: rotate old log entries (R-5)
  rotateLog();

  // Phase 1: Gates (0 tokens)
  console.log("[dispatch] phase 1: gates");
  const gateResult = runGates(config, { engine: "node" });
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

  // C-4: weekly git fsck on rotation projects (detects object store corruption)
  weeklyGitFsck(projectPaths);

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
  const route = resolveModel(selection.task, config.free_model_roster);
  console.log(
    `[dispatch] route: delegate_to=${route.delegate_to} model=${route.model} class=${route.taskClass}`
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
    if (e instanceof DieError) return; // already logged by die(), exitCode already set
    console.error(`[dispatch] unhandled error: ${e.stack || e.message}`);
    appendLog({
      outcome: "error",
      reason: e.message,
      phase: "unhandled",
      engine: "dispatch.mjs",
    });
    process.exitCode = 1;
  })
  .finally(() => {
    // Give the event loop one tick to drain pending HTTP handles (libuv crash fix).
    // Without this, process.exit() fires while @google/genai keep-alive handles
    // are still closing, risking a libuv UV_HANDLE_CLOSING assertion.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });

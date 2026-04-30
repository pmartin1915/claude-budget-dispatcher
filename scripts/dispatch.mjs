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
import { hostname } from "node:os";

import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import Ajv from "ajv";

import { runGates } from "./lib/gates.mjs";
import { selectProjectAndTask } from "./lib/selector.mjs";
import { resolveModel } from "./lib/router.mjs";
import { executeWork } from "./lib/worker.mjs";
import { createWorktree, restoreOrigin, verifyAndCommit } from "./lib/verify-commit.mjs";
import { appendLog, writeLastRun, rotateLog } from "./lib/log.mjs";
import { sweepStaleIndexLocks, sweepStaleWorktrees, weeklyGitFsck, weeklyNpmAudit } from "./lib/git-lock.mjs";
import { initThrottle } from "./lib/throttle.mjs";
import { checkAndAlert } from "./lib/alerting.mjs";
import { acquireDispatchLock, releaseDispatchLock } from "./lib/gist.mjs";
import { materializeConfig, ConfigDriftError, validateConfigCompleteness } from "./lib/config.mjs";
import { maybeAutoPush, createDefaultClients } from "./lib/auto-push.mjs";
import { runPostMergeMonitor } from "./post-merge-monitor.mjs";
import { advancePipelineState } from "./lib/pipelines.mjs";
import { verifyProjectScaffolds } from "./lib/scaffold.mjs";
import { pushConfigDriftAlert } from "./lib/config-drift-alert.mjs";
import { buildHeartbeatPayload, pushHeartbeat, collectEnvHealth } from "./lib/heartbeat.mjs";
import { runSentinel } from "./lib/sentinel.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "budget.json");

// Materialize layered config (shared.json + local.json → budget.json)
// before anything reads CONFIG_PATH. No-op in legacy mode.
materializeConfig();
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
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`config parse error: ${e.message}`);
  }

  // E3.1: Validate config against JSON Schema at startup.
  const schemaPath = resolve(REPO_ROOT, "config", "budget.schema.json");
  if (existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(schema);
      if (!validate(config)) {
        const errors = validate.errors.map(
          (e) => `  ${e.instancePath || "/"}: ${e.message}`
        ).join("\n");
        die(`budget.json schema validation failed:\n${errors}`);
      }
    } catch (e) {
      if (e instanceof DieError) throw e;
      console.warn(`[dispatch] schema validation skipped: ${e.message}`);
    }
  }

  // P0-2: Post-schema semantic completeness check.
  // Catches issues the JSON schema can't express: missing project paths,
  // empty gist IDs, missing model roster entries. On failure, push a
  // config-drift alert to the gist before dying so the central dashboard
  // can see WHY this node stopped.
  const completeness = validateConfigCompleteness(config);
  if (!completeness.valid) {
    const gistId = config.status_gist_id || "";
    const token = process.env.GIST_AUTH_TOKEN || process.env.GITHUB_TOKEN || "";
    // Best-effort gist alert — fire-and-forget. We can't await here because
    // die() throws synchronously. Schedule the alert and let it race with
    // process exit.
    pushConfigDriftAlert(gistId, token, completeness.errors, [
      CONFIG_PATH,
      resolve(REPO_ROOT, "config", "shared.json"),
      resolve(REPO_ROOT, "config", "local.json"),
    ]).catch(() => {});
    die(`config completeness check failed:\n  ${completeness.errors.join("\n  ")}`);
  }

  return config;
}

function initClients() {
  const geminiKey = process.env.GEMINI_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;

  const clients = {};
  if (geminiKey) {
    clients.gemini = new GoogleGenAI({ apiKey: geminiKey });
  } else {
    console.warn("[dispatch] GEMINI_API_KEY not set; Gemini tasks will be skipped");
  }

  if (mistralKey) {
    clients.mistral = new Mistral({ apiKey: mistralKey });
  } else {
    console.warn("[dispatch] MISTRAL_API_KEY not set; Mistral/Codestral tasks will be skipped");
  }

  return clients;
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

  // Resolve gist auth token once — used by heartbeat, sentinel, and Phase 0.
  const gistToken = process.env.GIST_AUTH_TOKEN || process.env.GITHUB_TOKEN || "";

  // Phase -1: Heartbeat push (P1-1).
  // Pushes a signed state snapshot to the status gist so the Sentinel and
  // watchdog know this node is alive. Runs before gates because a gated
  // skip is still a sign of life. Jittered to avoid API write collisions
  // when multiple fleet nodes fire cron simultaneously.
  // Fail-soft: never aborts dispatch.
  try {
    const hbPayload = buildHeartbeatPayload({
      nodeId: config.node_id ?? hostname().toLowerCase(),
      machineName: hostname().toLowerCase(),
      currentTaskHash: null,  // pre-gates: not working yet
      envHealth: collectEnvHealth(),
      driftVelocity: null,
    });
    await pushHeartbeat(hbPayload, config.status_gist_id, gistToken, {
      jitterMs: 3000,  // 0-3s jitter for fleet write-collision avoidance
    });
  } catch (e) {
    console.warn(`[dispatch] heartbeat push failed (non-fatal): ${e?.message ?? e}`);
  }

  // Phase -0.5: Sentinel (P1-2).
  // Reads heartbeat files from the gist, detects dead nodes (3-miss
  // threshold), and re-registers orphaned task hashes to the global queue.
  // Any node can run sentinel duty (stateless via gist). Runs before Phase
  // 0 so orphaned tasks are available for reallocation before gates.
  // Fail-soft: never aborts dispatch.
  try {
    const sentinelSummary = await runSentinel({
      gistId: config.status_gist_id,
      token: gistToken,
      intervalMs: (config.activity_gate?.idle_minutes_required ?? 20) * 60 * 1000,
      config,
    });
    if (sentinelSummary.deadNodes?.length > 0) {
      console.log(`[dispatch] sentinel: ${sentinelSummary.deadNodes.length} dead node(s), ${sentinelSummary.orphanedTasks?.length ?? 0} task(s) re-queued`);
    }
  } catch (e) {
    console.warn(`[dispatch] sentinel failed (non-fatal): ${e?.message ?? e}`);
  }

  // Phase 0: post-merge canary monitor (gate 7).
  // Reads pending-merges.json from the status gist, replays canary against
  // any merged commit whose deadline has elapsed (T+15min/1h/4h/24h), and
  // auto-suspends the project's auto_push flag in local.json on a single
  // failure. Runs BEFORE gates because:
  //  - It doesn't need the budget/activity gate (replays are deadline-driven).
  //  - It doesn't need the dispatch lock (uses its own gist ETag CAS).
  //  - It must fire on every cron tick regardless of dispatch-skip state.
  // Fail-soft: never aborts the rest of dispatch.
  try {
    // Gist-auth fallback chain (host-aware). On a dispatcher host the operator
    // typically has GITHUB_TOKEN set with full PAT scope (used by gh CLI for
    // pushes, the dispatch lock, etc.), so falling back to it is safe when
    // GIST_AUTH_TOKEN isn't separately provisioned. The Overseer (Actions)
    // uses a different fallback (OVERSEER_GH_TOKEN) because the auto-
    // provisioned GITHUB_TOKEN there does NOT include `gist` scope. Keeping
    // both fallbacks distinct means each host uses the most-likely-scoped
    // token in its environment without forcing operators to provision a
    // separate GIST_AUTH_TOKEN secret on every host. PAL focus 4 / 2026-04-28.
    const phase0Summary = await runPostMergeMonitor({
      gistId: config.status_gist_id,
      gistToken: gistToken,
      projectsInRotation: config.projects_in_rotation ?? [],
      ntfyTopic: config.alerting?.topic ?? null,
      ntfyEnabled: config.alerting?.enabled === true,
    });
    if ((phase0Summary.processed ?? 0) > 0 || (phase0Summary.deferred ?? 0) > 0 || (phase0Summary.suspended ?? 0) > 0) {
      console.log(`[dispatch] phase 0 (gate 7): processed=${phase0Summary.processed} deferred=${phase0Summary.deferred} skipped=${phase0Summary.skipped} suspended=${phase0Summary.suspended}`);
    }
  } catch (e) {
    // Phase 0 must not crash the dispatcher. Log and continue.
    console.warn(`[dispatch] phase 0 (gate 7) failed: ${e?.message ?? e}`);
    appendLog({ phase: "post-merge-canary", engine: "dispatch.mjs", outcome: "error", reason: "phase-0-uncaught", error: String(e?.message ?? e).slice(-500) });
  }

  // Phase 0.5: scaffold verification (Bug A defensive observability).
  // Surfaces the silent skip in context.mjs:56-59 — projects without
  // DISPATCH.md drop out of selector context with no log surface today.
  // Emits one `outcome: "scaffold-missing"` JSONL entry per affected
  // project per cron tick so dashboards / evaluateNoProgress / morning-
  // briefing can see which rotation projects are dormant due to missing
  // scaffolds. Runs upstream of gates because the audit trail should be
  // complete regardless of whether dispatch fires. Fail-soft: never aborts.
  try {
    verifyProjectScaffolds({
      projects: config.projects_in_rotation ?? [],
      appendLog,
    });
  } catch (e) {
    console.warn(`[dispatch] phase 0.5 (scaffold-check) failed: ${e?.message ?? e}`);
  }

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

  // F1.1: Distributed dispatch lock — prevent two machines dispatching simultaneously
  const lockGistId = config.status_gist_id;
  const lockToken = process.env.GITHUB_TOKEN;
  const lockResult = await acquireDispatchLock(
    lockGistId, hostname().toLowerCase(), { token: lockToken }
  );
  if (!lockResult.acquired) {
    console.log(`[dispatch] lock not acquired: ${lockResult.reason}`);
    appendLog({ outcome: "skipped", reason: "dispatch-locked", phase: "lock", engine: "dispatch.mjs" });
    writeLastRun({ outcome: "skipped", reason: `dispatch-locked: ${lockResult.reason}` }, Date.now() - startMs);
    return;
  }
  if (lockResult.degraded) {
    console.warn("[dispatch] running without distributed lock (degraded mode)");
  }

  // Everything after lock acquisition is wrapped in try/finally to guarantee lock release.
  try {

  // Phase 2: Selector (Gemini, ~2-5K free tokens)
  console.log("[dispatch] phase 2: selector");
  const selection = await selectProjectAndTask(config, clients);
  if (!selection?.project) {
    // Phase 1 of PLAN-smooth-error-handling-and-auto-update.md: carry
    // structured error detail through to the JSONL entry so fleet.mjs and
    // a future "degraded" health state can see WHY the selector failed.
    // Fields are optional -- downstream readers must tolerate absence.
    const err = selection?.error ?? { reason: "unknown" };
    console.log(
      `[dispatch] selector failed (${err.reason}${err.detail ? `: ${err.detail}` : ""}${err.model ? `, model=${err.model}` : ""}), skipping`
    );
    appendLog({
      outcome: "skipped",
      reason: "selector-failed",
      phase: "selector",
      engine: "dispatch.mjs",
      error_detail: err.reason,
      ...(err.model && { error_model: err.model }),
      ...(err.retries !== undefined && { error_retries: err.retries }),
      ...(err.message && { error_message: err.message.slice(0, 500) }),
      ...(err.api_status && { error_api_status: err.api_status }),
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
      ...(selection._fallback && {
        selector_fallback: true,
        ...(selection._fallback_reason && { selector_fallback_reason: selection._fallback_reason }),
      }),
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
      ...(selection._fallback && {
        selector_fallback: true,
        ...(selection._fallback_reason && { selector_fallback_reason: selection._fallback_reason }),
      }),
    });
    writeLastRun({ outcome: "dry-run" }, Date.now() - startMs);
    return;
  }

  // Phase 4: Worker (free-tier tokens)
  console.log("[dispatch] phase 4: worker");
  let worktree = null;

  let finalResult;
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
    finalResult = await verifyAndCommit(
      workResult,
      selection,
      route,
      config,
      clients
    );

    console.log(`[dispatch] final: ${finalResult.outcome}`);

    // Pipeline state advancement (Phase A): only fires when this dispatch
    // came from the pipeline pre-pass (selection.pipelineStep set). For
    // leaf-task selections this is a no-op. Failures here are logged but
    // never block appendLog/writeLastRun below — the underlying work
    // outcome is what matters for the dispatcher's run record.
    if (selection.pipelineStep && selection.pipelineStatePath) {
      try {
        const auditCritical =
          finalResult?.auditResult?.hasCritical === true ||
          finalResult?.outcome === "reverted"; // revert implies a critical signal upstream
        const advance = advancePipelineState({
          statePath: selection.pipelineStatePath,
          pipelineName: selection.pipelineName,
          stepId: selection.pipelineStep.id,
          outcome: finalResult.outcome,
          branch: worktree?.branch ?? finalResult.branch ?? null,
          pipelineDef: selection.pipelineDef ?? null,
          lastStepAuditCritical: auditCritical,
        });
        if (advance.aborted) {
          appendLog({
            outcome: "pipeline-aborted",
            project: selection.project,
            task: selection.task,
            phase: "pipeline",
            engine: "dispatch.mjs",
            pipeline: selection.pipelineName,
            step_id: selection.pipelineStep.id,
            // Same as step_id today, but kept as a distinct field so future
            // multi-step abort scenarios (e.g. if a downstream step's audit
            // retroactively aborts the pipeline) stay debuggable.
            triggering_step_id: selection.pipelineStep.id,
            reason: advance.abortReason,
          });
        }
      } catch (e) {
        console.warn(`[dispatch] pipeline state advance error: ${e.message}`);
      }
    }

    appendLog({
      ...finalResult,
      // Always carry project/task from selection on ALL outcomes (success,
      // reverted, skipped-from-worker). verify-commit early-returns the raw
      // workResult on non-success, and worker's no-files-to-analyze skip
      // lacks these fields -- which left the selector's recent_outcomes
      // blind and caused single-project starvation (Part 19).
      project: selection.project,
      task: selection.task,
      phase: "complete",
      engine: "dispatch.mjs",
      duration_ms: Date.now() - startMs,
      ...(selection.pipelineName && {
        pipeline: selection.pipelineName,
        pipeline_step_id: selection.pipelineStep?.id,
      }),
      ...(selection._fallback && {
        selector_fallback: true,
        ...(selection._fallback_reason && { selector_fallback_reason: selection._fallback_reason }),
      }),
    });
    writeLastRun(finalResult, Date.now() - startMs);
  } finally {
    // Always restore origin pushurl on worktree (H1 ceremony cleanup)
    if (worktree?.path) {
      restoreOrigin(worktree.path, worktree.originalPushUrl ?? null);
    }
  }

  // Phase 5b: Path-firewalled auto-push to origin + draft PR.
  //
  // Policy lives in scripts/lib/auto-push.mjs (per-project allowlist, global
  // protected globs, dry-run, fail-soft). Runs OUTSIDE the try/finally above
  // so it executes after restoreOrigin() -- pushes go to the real origin URL,
  // not the H1-tampered worktree pushurl.
  //
  // auto_pr is deprecated. Draft PR creation is implicit on push success.
  // The seven-gate stack (worldbuilder/VEYDRIA-VISION.md Pillar 3): this is
  // gate 1 (path firewall) + the push mechanism gates 2-7 plug into.
  if (finalResult?.outcome === "success" && finalResult.branch) {
    const workingDir = worktree?.path ?? selection.projectConfig.path;
    const apClients = createDefaultClients(workingDir);
    finalResult.auto_push = await maybeAutoPush({
      branch: finalResult.branch,
      project: selection.project,
      projectConfig: selection.projectConfig,
      globalConfig: config,
      finalResult,
      selection,
      route,
      buildPrBody,
      workingDir,
      gitClient: apClients.gitClient,
      ghClient: apClients.ghClient,
      canaryRunner: apClients.canaryRunner,
      dryRun,
      logger: { appendLog },
    });
    console.log(
      `[dispatch] auto-push: ${finalResult.auto_push.outcome}` +
      (finalResult.auto_push.reason ? ` (${finalResult.auto_push.reason})` : "") +
      (finalResult.auto_push.pr_url ? ` ${finalResult.auto_push.pr_url}` : "")
    );
  }

  } finally {
    // F1.1: Release distributed lock (best-effort, never throws)
    if (lockGistId && lockToken) {
      await releaseDispatchLock(lockGistId, { token: lockToken });
    }
  }
}

/**
 * Build the markdown body for a dispatcher auto-PR.
 * @param {object} finalResult - verify-commit output (outcome, branch, commit_hash, files_changed, summary, modelUsed)
 * @param {{ project: string, task: string, reason?: string }} selection
 * @param {{ taskClass: string, model: string, candidates?: string[] }} route
 */
function buildPrBody(finalResult, selection, route) {
  const lines = [
    "## Dispatcher auto-PR",
    "",
    `- **Project:** \`${selection.project}\``,
    `- **Task:** \`${selection.task}\``,
    `- **Task class:** \`${route.taskClass}\``,
    `- **Model:** \`${finalResult.modelUsed ?? route.model}\``,
    `- **Machine:** \`${hostname()}\``,
    `- **Branch:** \`${finalResult.branch}\``,
  ];
  if (finalResult.commit_hash) lines.push(`- **Commit:** \`${String(finalResult.commit_hash).slice(0, 8)}\``);
  if (finalResult.files_changed !== undefined) lines.push(`- **Files changed:** ${finalResult.files_changed}`);
  lines.push("", "### Summary", finalResult.summary ?? "(no summary)", "");
  lines.push("### How to review");
  lines.push("- This PR is opened as **draft**. The Overseer (Pillar 1) or Perry marks it ready-for-review when satisfied.");
  lines.push("- **Accept:** mark ready-for-review, then merge.");
  lines.push("- **Reject:** click **Close**.");
  lines.push("- Comment for revision: not currently wired \u2014 planned for a later phase.");
  if (selection.reason || route.candidates) {
    lines.push("", "### Metadata");
    if (route.candidates) lines.push(`- Candidates considered: ${route.candidates.join(", ")}`);
    if (selection.reason) lines.push(`- Selector reason: ${selection.reason}`);
  }
  return lines.join("\n") + "\n";
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

// post-merge-monitor.mjs -- Pillar 1 step 4 -- gate 7 (post-merge canary).
//
// Dispatcher-side companion to gate 6 (Overseer auto-merge). After the
// Overseer merges a PR via `PUT /pulls/{n}/merge` and writes a pending-
// merges.json entry to the status gist, this module replays the project's
// `canary_command` against the merged commit on a schedule (T+15min, T+1h,
// T+4h, T+24h). A SINGLE failure within the 24h window auto-suspends the
// project's `auto_push` flag in `local.json` (write-temp-then-rename),
// fires a fatal ntfy at priority 5, and marks the entry completed.
//
// One-strike rule: no auto-recovery. Once a project is auto-suspended,
// `auto_push: false` stays false until Perry manually flips it back. This
// is intentional -- a regression that shipped past gate 4 (canary
// pre-push) and gate 5 (Overseer review) is exactly what we want to halt
// for human review.
//
// Hosting: this module runs on the DISPATCHER HOST (it needs the project
// worktree for git fetch + git worktree add + canary spawn). It CAN
// import from scripts/lib/* (different host than overseer.mjs's
// hosting-independence constraint).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { tmpdir, hostname } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readGistFile, writeGistFile } from "./lib/gist.mjs";
import { _defaultCanaryRunner } from "./lib/auto-push.mjs";
import { appendLog } from "./lib/log.mjs";
import { sendNtfy } from "./lib/alerting.mjs";
import { recordPipelineMerges } from "./lib/pipelines.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_LOCAL_JSON_PATH = resolve(REPO_ROOT, "config", "local.json");
const PENDING_MERGES_GIST_FILE = "pending-merges.json";
const PENDING_MERGES_SCHEMA_VERSION = 1;
const TRAIL_MAX = 500;
const GIT_TIMEOUT_MS = 60_000;
const COMPLETED_GC_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_CANARY_TIMEOUT_MS = 120_000;

function _trail(s, max = TRAIL_MAX) {
  if (s == null) return "";
  const str = String(s);
  return str.length > max ? str.slice(-max) : str;
}

/**
 * Pure. Decide which entries are due for a replay tick, given a list of
 * pending-merge entries and a clock. Default-to-skip on bad shape.
 *
 * Returns an object with three categories:
 *   { dueNow, notYetDue, completedToGc }
 *
 * @param {object} args
 * @param {Array} args.entries
 * @param {number} args.now
 * @param {string} args.machine - hostname; entries with target_machine !=
 *                                machine are NOT skipped here (skipping
 *                                happens in evaluateOneEntry against
 *                                projectsInRotation).
 */
export function categorizeEntries({ entries, now, gcOlderThanMs = COMPLETED_GC_MS }) {
  const dueNow = [];
  const notYetDue = [];
  const completedToGc = [];
  if (!Array.isArray(entries)) return { dueNow, notYetDue, completedToGc };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.completed) {
      const mergedAt = Number.isFinite(entry.merged_at_ms) ? entry.merged_at_ms : 0;
      if (mergedAt > 0 && now - mergedAt > gcOlderThanMs) {
        completedToGc.push(entry);
      }
      continue;
    }
    const deadline = Number.isFinite(entry.next_deadline_ms) ? entry.next_deadline_ms : 0;
    if (deadline <= now) dueNow.push(entry);
    else notYetDue.push(entry);
  }
  return { dueNow, notYetDue, completedToGc };
}

/**
 * Pure. Compute the next deadline after a successful replay tick.
 * Returns null when the schedule is exhausted (entry should be marked
 * completed: true, outcome: replays-clean).
 *
 * @param {Array<number>} schedule  - array of ms offsets from merged_at_ms
 * @param {number} replaysDoneAfter - replays_done AFTER incrementing
 * @param {number} mergedAtMs
 * @returns {number|null}
 */
export function nextDeadline(schedule, replaysDoneAfter, mergedAtMs) {
  if (!Array.isArray(schedule) || replaysDoneAfter >= schedule.length) return null;
  const offset = Number.isFinite(schedule[replaysDoneAfter]) ? schedule[replaysDoneAfter] : 0;
  return mergedAtMs + offset;
}

/**
 * Pure. Map a canary runner result to a structured outcome.
 *
 * @param {object} result - { exitCode, stdout, stderr, timedOut, durationMs, spawnError }
 * @returns {{ pass: boolean, failure_mode?: string, exit_code: number|null, duration_ms: number, stdout_tail: string, stderr_tail: string }}
 */
export function evaluateCanaryResult(result) {
  const stdout_tail = _trail(result?.stdout ?? "");
  const stderr_tail = _trail(result?.stderr ?? "");
  const duration_ms = Number.isFinite(result?.durationMs) ? result.durationMs : 0;
  const exit_code = Number.isFinite(result?.exitCode) ? result.exitCode : null;
  if (result?.spawnError) return { pass: false, failure_mode: "spawn-error", exit_code, duration_ms, stdout_tail, stderr_tail };
  if (result?.timedOut)   return { pass: false, failure_mode: "timeout",     exit_code, duration_ms, stdout_tail, stderr_tail };
  if (exit_code !== 0)    return { pass: false, failure_mode: "non-zero",    exit_code, duration_ms, stdout_tail, stderr_tail };
  return { pass: true, exit_code, duration_ms, stdout_tail, stderr_tail };
}

/**
 * Atomically mutate `local.json` to flip a single project's `auto_push`
 * field. Write-temp-then-rename: writes to <path>.tmp.<uuid> in the same
 * directory then renames atomically. Only mutates the affected project;
 * all other entries pass through unchanged. Idempotent: returns
 * `{ changed: false, alreadySuspended: true }` when auto_push is already
 * the target value.
 *
 * @param {object} args
 * @param {string} args.localJsonPath
 * @param {string} args.projectSlug
 * @param {boolean} args.autoPushTarget - target value (false = suspend)
 * @param {object} [args.fs] - injectable for tests; defaults to node:fs
 * @returns {{ changed: boolean, alreadySuspended?: boolean, reason?: string }}
 */
export function mutateLocalJsonAtomic({ localJsonPath, projectSlug, autoPushTarget, fs = null }) {
  const realFs = fs ?? { readFileSync, writeFileSync, renameSync, existsSync, rmSync };
  if (!realFs.existsSync(localJsonPath)) {
    return { changed: false, reason: `local-json-missing:${localJsonPath}` };
  }
  let raw;
  try {
    raw = realFs.readFileSync(localJsonPath, "utf8");
  } catch (e) {
    return { changed: false, reason: `read-failed:${_trail(e?.message ?? e)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { changed: false, reason: `parse-failed:${_trail(e?.message ?? e)}` };
  }
  const rotation = Array.isArray(parsed?.projects_in_rotation) ? parsed.projects_in_rotation : null;
  if (!rotation) return { changed: false, reason: "no-projects-in-rotation" };

  let foundIdx = -1;
  for (let i = 0; i < rotation.length; i++) {
    if (rotation[i]?.slug === projectSlug) { foundIdx = i; break; }
  }
  if (foundIdx === -1) return { changed: false, reason: `project-not-found:${projectSlug}` };
  if (rotation[foundIdx].auto_push === autoPushTarget) {
    return { changed: false, alreadySuspended: autoPushTarget === false };
  }

  // Mutate ONLY the affected entry. Preserve all others byte-for-byte
  // beyond what JSON re-stringification reorders.
  const next = { ...parsed, projects_in_rotation: rotation.map((p, i) =>
    i === foundIdx ? { ...p, auto_push: autoPushTarget } : p
  ) };
  const tmpPath = `${localJsonPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    realFs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    realFs.renameSync(tmpPath, localJsonPath);
    return { changed: true };
  } catch (e) {
    // Best-effort cleanup of orphan tmp on failed rename. realFs.rmSync is
    // pulled from the injectable fs (default is node:fs imported at top);
    // tests can supply a mock that records the cleanup call to assert the
    // tmp doesn't leak.
    try { if (realFs.existsSync(tmpPath)) realFs.rmSync(tmpPath); } catch { /* ignore */ }
    return { changed: false, reason: `write-rename-failed:${_trail(e?.message ?? e)}` };
  }
}

/**
 * Default git client for the dispatcher host. Spawns `git` with argv form,
 * shell:false. Tests inject a mock with the same shape.
 */
export function createDefaultGitClient() {
  const git = (cwd, args) => execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false,
  });
  return {
    fetch(projectPath, ref) {
      // Accept ref either as a SHA or a branch/tag. `git fetch origin <ref>`
      // works for both. If ref is undefined, `git fetch origin` pulls all refs.
      const args = ref ? ["fetch", "origin", ref] : ["fetch", "origin"];
      git(projectPath, args);
    },
    addWorktree(projectPath, tmpDir, sha) {
      git(projectPath, ["worktree", "add", "--detach", tmpDir, sha]);
    },
    removeWorktree(projectPath, tmpDir) {
      git(projectPath, ["worktree", "remove", "--force", tmpDir]);
    },
  };
}

/**
 * Default GitHub PR-state client. Used when an entry's merge_commit_sha is
 * null (lazy-fetch path). Calls `gh pr view <n> -R <repo> --json ...`. argv
 * form, shell:false. Tests inject a mock.
 */
export function createDefaultGhPrClient() {
  return {
    viewPr(repo, prNumber) {
      const out = execFileSync(
        "gh",
        ["pr", "view", String(prNumber), "-R", repo, "--json", "mergeCommit,state,baseRefName"],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false },
      );
      return JSON.parse(out);
    },
  };
}

/**
 * Process one due entry: lazy-fetch merge_commit_sha if null, locate the
 * project, replay the canary against the merge commit, mutate state. Returns
 * the updated entry (or null if entry should be removed).
 *
 * Never throws. All errors flow through the JSONL log. If the project isn't
 * in this machine's rotation (different host owns the replay), returns the
 * entry unchanged with a `_skipped: "wrong-machine"` flag.
 */
export async function processOneEntry({
  entry, projectsInRotation, localJsonPath,
  ntfyTopic, ntfyEnabled,
  gh, git, runner, appender, now, mkdtemp,
}) {
  const baseLog = {
    phase: "post-merge-canary",
    engine: "post-merge-monitor.mjs",
    repo: entry.repo,
    pr_number: entry.pr_number,
    project_slug: entry.project_slug,
    machine: hostname(),
  };
  const log = (extra) => { try { appender({ ...baseLog, ...extra }); } catch { /* never throw */ } };

  // Locate project locally. If not in rotation, this machine doesn't own
  // the replay -- another machine will. Mark entry skipped (returned
  // unchanged so other machines see it).
  const project = projectsInRotation.find((p) => p?.slug === entry.project_slug);
  if (!project) {
    return { entry, skipped: true, reason: "project-not-in-local-rotation" };
  }
  const projectPath = project.path;
  if (!projectPath || !existsSync(projectPath)) {
    log({ outcome: "skipped", reason: `project-path-missing:${projectPath}` });
    return { entry, skipped: true, reason: "project-path-missing" };
  }
  const canaryCommand = Array.isArray(project.canary_command) ? project.canary_command : null;
  if (!canaryCommand || canaryCommand.length === 0) {
    log({ outcome: "skipped", reason: "canary-command-missing" });
    return { entry, skipped: true, reason: "canary-command-missing" };
  }
  const timeoutMs = Number.isFinite(project.canary_timeout_ms) ? project.canary_timeout_ms : DEFAULT_CANARY_TIMEOUT_MS;

  // Lazy-fetch merge_commit_sha if absent.
  let mergeSha = entry.merge_commit_sha ?? null;
  if (!mergeSha) {
    try {
      const view = gh.viewPr(entry.repo, entry.pr_number);
      if (view?.state !== "MERGED") {
        // Not yet merged from GitHub's perspective. Defer to next tick.
        log({ outcome: "deferred", reason: `pr-not-yet-merged:${view?.state ?? "?"}` });
        return { entry, skipped: false, deferred: true };
      }
      mergeSha = view?.mergeCommit?.oid ?? null;
      if (!mergeSha) {
        log({ outcome: "deferred", reason: "no-merge-commit-sha-from-gh" });
        return { entry, skipped: false, deferred: true };
      }
    } catch (e) {
      log({ outcome: "deferred", reason: `gh-pr-view-failed`, error: _trail(e?.message ?? e) });
      return { entry, skipped: false, deferred: true };
    }
  }

  // Replay: fetch + checkout in tmpdir + run canary + cleanup.
  let tmpDir;
  try {
    tmpDir = mkdtemp(join(tmpdir(), "pmm-"));
  } catch (e) {
    log({ outcome: "deferred", reason: `mkdtemp-failed`, error: _trail(e?.message ?? e) });
    return { entry, skipped: false, deferred: true };
  }
  let canaryOutcome;
  try {
    try { git.fetch(projectPath, mergeSha); } catch (e) {
      log({ outcome: "deferred", reason: `git-fetch-failed`, error: _trail(e?.message ?? e) });
      return { entry, skipped: false, deferred: true };
    }
    try { git.addWorktree(projectPath, tmpDir, mergeSha); } catch (e) {
      log({ outcome: "deferred", reason: `git-worktree-add-failed`, error: _trail(e?.message ?? e) });
      return { entry, skipped: false, deferred: true };
    }
    const runResult = await runner(tmpDir)(canaryCommand, { timeoutMs });
    canaryOutcome = evaluateCanaryResult(runResult);
  } finally {
    try { git.removeWorktree(projectPath, tmpDir); } catch { /* best-effort cleanup */ }
  }

  const replaysDoneAfter = (Number.isFinite(entry.replays_done) ? entry.replays_done : 0) + 1;
  const replayNum = replaysDoneAfter; // 1-indexed for log clarity

  if (canaryOutcome.pass) {
    const next = nextDeadline(entry.replay_schedule_ms, replaysDoneAfter, entry.merged_at_ms ?? now);
    const updated = { ...entry, merge_commit_sha: mergeSha, replays_done: replaysDoneAfter, last_replay_ts_ms: now };
    if (next === null) {
      updated.completed = true;
      updated.outcome = "replays-clean";
      updated.next_deadline_ms = null;
      log({ outcome: "replays-clean", replay_num: replayNum, exit_code: canaryOutcome.exit_code, duration_ms: canaryOutcome.duration_ms });
    } else {
      updated.next_deadline_ms = next;
      log({ outcome: "replay-success", replay_num: replayNum, exit_code: canaryOutcome.exit_code, duration_ms: canaryOutcome.duration_ms, next_deadline_ms: next });
    }
    return { entry: updated, skipped: false };
  }

  // FAILURE -> auto-suspend.
  const suspendResult = mutateLocalJsonAtomic({
    localJsonPath,
    projectSlug: entry.project_slug,
    autoPushTarget: false,
  });
  // Idempotency: if already suspended (e.g. retry of stale entry), do NOT
  // re-fire ntfy. Just mark entry completed so it stops cycling.
  let ntfyFired = false;
  if (suspendResult.changed && ntfyEnabled && ntfyTopic) {
    try {
      ntfyFired = await sendNtfy(
        ntfyTopic,
        `Auto-suspended: ${entry.project_slug}`,
        [
          `Project: ${entry.project_slug}`,
          `Repo: ${entry.repo} #${entry.pr_number}`,
          `Merge commit: ${mergeSha}`,
          `Failure: ${canaryOutcome.failure_mode} (exit=${canaryOutcome.exit_code}, ${canaryOutcome.duration_ms}ms)`,
          `Replay #${replayNum} of ${entry.replay_schedule_ms?.length ?? "?"}`,
          `--- stdout (tail) ---`,
          canaryOutcome.stdout_tail || "(empty)",
          `--- stderr (tail) ---`,
          canaryOutcome.stderr_tail || "(empty)",
          ``,
          `auto_push:false flipped in local.json. Manual reset required.`,
        ].join("\n"),
        5,
      );
    } catch { ntfyFired = false; }
  }

  const updated = {
    ...entry,
    merge_commit_sha: mergeSha,
    replays_done: replaysDoneAfter,
    last_replay_ts_ms: now,
    completed: true,
    outcome: "auto-suspended",
    failure_mode: canaryOutcome.failure_mode,
    exit_code: canaryOutcome.exit_code,
    stdout_tail: canaryOutcome.stdout_tail,
    stderr_tail: canaryOutcome.stderr_tail,
    next_deadline_ms: null,
  };
  log({
    outcome: "auto-suspended",
    replay_num: replayNum,
    failure_mode: canaryOutcome.failure_mode,
    exit_code: canaryOutcome.exit_code,
    duration_ms: canaryOutcome.duration_ms,
    stdout_tail: canaryOutcome.stdout_tail,
    stderr_tail: canaryOutcome.stderr_tail,
    suspend_changed: suspendResult.changed,
    suspend_already: suspendResult.alreadySuspended === true,
    ntfy_fired: ntfyFired,
  });
  return { entry: updated, skipped: false };
}

/**
 * Top-level orchestrator. Reads pending-merges.json from the gist, processes
 * any due entries on this host, and PATCHes the gist back with updated
 * state. Never throws -- fail-soft on every IO error so dispatch.mjs Phase 0
 * never aborts the rest of the dispatch run.
 *
 * @param {object} args
 * @param {string} args.gistId
 * @param {string} args.gistToken
 * @param {string} args.localJsonPath - usually config/local.json
 * @param {Array<{slug:string,path:string,canary_command?:string[],canary_timeout_ms?:number}>} args.projectsInRotation
 * @param {string|null} args.ntfyTopic
 * @param {boolean} args.ntfyEnabled
 * @param {object} [args.gistFns] - { read, write }; defaults to gist.mjs lib
 * @param {object} [args.gh] - { viewPr } gh CLI client
 * @param {object} [args.git] - { fetch, addWorktree, removeWorktree }
 * @param {Function} [args.runner] - canary runner factory (workdir) => (cmd, opts) => Promise
 * @param {Function} [args.appender] - JSONL appender
 * @param {Function} [args.now] - () => epoch ms
 * @param {Function} [args.mkdtemp] - (prefix) => string (sync mkdtemp)
 * @returns {Promise<object>} summary { processed, deferred, skipped, completed, suspended, gist_outcome }
 */
export async function runPostMergeMonitor(args) {
  const {
    gistId, gistToken, localJsonPath = DEFAULT_LOCAL_JSON_PATH,
    projectsInRotation = [],
    ntfyTopic = null, ntfyEnabled = false,
    gistFns,
    gh = createDefaultGhPrClient(),
    git = createDefaultGitClient(),
    runner = _defaultCanaryRunner,
    appender = appendLog,
    now = Date.now,
    mkdtemp = (prefix) => mkdtempSync(prefix),
  } = args;

  const baseLog = { phase: "post-merge-canary", engine: "post-merge-monitor.mjs", machine: hostname() };
  const log = (extra) => { try { appender({ ...baseLog, ...extra }); } catch { /* never throw */ } };

  if (!gistId) {
    log({ outcome: "skipped", reason: "no-gist-id" });
    return { processed: 0, deferred: 0, skipped: 0, completed: 0, suspended: 0, gist_outcome: { ok: false, reason: "no-gist-id" } };
  }

  // Read pending-merges.json (with ETag).
  const read = gistFns?.read ?? readGistFile;
  const write = gistFns?.write ?? writeGistFile;
  let pending;
  try {
    pending = await read(gistId, PENDING_MERGES_GIST_FILE, { token: gistToken });
  } catch (e) {
    log({ outcome: "skipped", reason: `gist-read-failed`, error: _trail(e?.message ?? e) });
    return { processed: 0, deferred: 0, skipped: 0, completed: 0, suspended: 0, gist_outcome: { ok: false, status: 0, reason: "gist-read-failed" } };
  }
  if (pending?.malformed) {
    log({ outcome: "skipped", reason: "gist-malformed" });
    return { processed: 0, deferred: 0, skipped: 0, completed: 0, suspended: 0, gist_outcome: { ok: false, status: 0, reason: "gist-malformed" } };
  }
  const data = pending?.data;
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    return { processed: 0, deferred: 0, skipped: 0, completed: 0, suspended: 0, gist_outcome: { ok: true, status: 200, reason: "no-entries" } };
  }
  // PAL focus 4: forward-compat. If gist schema is newer than ours, fail-soft.
  const gistVer = Number.isFinite(data.schema_version) ? data.schema_version : PENDING_MERGES_SCHEMA_VERSION;
  if (gistVer > PENDING_MERGES_SCHEMA_VERSION) {
    log({ outcome: "skipped", reason: `gist-schema-version-newer:remote=${gistVer}-local=${PENDING_MERGES_SCHEMA_VERSION}` });
    return { processed: 0, deferred: 0, skipped: 0, completed: 0, suspended: 0, gist_outcome: { ok: false, reason: "gist-schema-version-newer" } };
  }

  const nowMs = now();
  // Pipeline merge correlation (Phase A): for any pending-merges entry
  // whose `branch` matches a pipeline step recorded in a project's
  // ai/pipeline-state.json with no merged_ts yet, stamp merged_ts. Lets
  // the next pipeline step's depends_on check unblock within ~15 min of
  // the GitHub merge event (the post-merge-monitor's first replay
  // deadline). Idempotent — re-runs are no-ops once the field is set.
  // Failures here must never block the canary replay processing below.
  try {
    const merges = recordPipelineMerges({ entries: data.entries, projects: projectsInRotation });
    if (merges.updates > 0) {
      log({ outcome: "pipeline-merge-stamped", updates: merges.updates });
    }
  } catch (e) {
    log({ outcome: "skipped", reason: "pipeline-stamp-failed", error: _trail(e?.message ?? e) });
  }
  const { dueNow, notYetDue, completedToGc } = categorizeEntries({ entries: data.entries, now: nowMs });

  let processed = 0;
  let deferred = 0;
  let skipped = 0;
  let completed = 0;
  let suspended = 0;

  // Process due entries; non-due and non-GC-eligible completed entries pass
  // through unchanged.
  const updatedDueNow = [];
  for (const entry of dueNow) {
    const out = await processOneEntry({
      entry, projectsInRotation, localJsonPath,
      ntfyTopic, ntfyEnabled,
      gh, git, runner: runner ?? _defaultCanaryRunner, appender, now: nowMs, mkdtemp,
    });
    if (out.skipped) {
      skipped++;
      updatedDueNow.push(out.entry);
      continue;
    }
    if (out.deferred) {
      deferred++;
      updatedDueNow.push(out.entry);
      continue;
    }
    processed++;
    if (out.entry?.completed) {
      completed++;
      if (out.entry.outcome === "auto-suspended") suspended++;
    }
    updatedDueNow.push(out.entry);
  }

  // Carry over the not-yet-due entries unchanged. Drop the GC-eligible
  // completed entries.
  const finalEntries = [...notYetDue, ...updatedDueNow];
  const gcDropped = completedToGc.length;

  const newPayload = {
    schema_version: PENDING_MERGES_SCHEMA_VERSION,
    entries: finalEntries,
    updated_at_ms: nowMs,
  };

  // Only write if anything changed (avoid noise in gist version history).
  const wroteAnything = processed > 0 || deferred > 0 || gcDropped > 0;
  let gistWriteOutcome = { ok: true, status: 200, reason: wroteAnything ? "wrote" : "nothing-to-write" };
  if (wroteAnything) {
    try {
      // No If-Match: GitHub gists API rejects conditional PATCH headers (Bug E,
      // 2026-04-27). Concurrency is safe via deadline-driven idempotency:
      // categorizeEntries treats already-completed entries as GC'd, so a
      // concurrent writer's stale view appending a duplicate would dedupe
      // on the next tick when the entry is re-categorized as completed.
      const w = await write(gistId, PENDING_MERGES_GIST_FILE, newPayload, { token: gistToken });
      if (!w.ok) {
        gistWriteOutcome = { ok: false, status: w.status, reason: "write-failed" };
        log({ outcome: "gist-write-failed", status: w.status });
      } else {
        gistWriteOutcome = { ok: true, status: w.status };
      }
    } catch (e) {
      gistWriteOutcome = { ok: false, status: 0, reason: "gist-write-exception", error: _trail(e?.message ?? e) };
      log({ outcome: "gist-write-failed", error: _trail(e?.message ?? e) });
    }
  }

  return { processed, deferred, skipped, completed, suspended, gc_dropped: gcDropped, gist_outcome: gistWriteOutcome };
}

// ---------------------------------------------------------------------------
// CLI entrypoint -- only when invoked as `node scripts/post-merge-monitor.mjs`.
// Reads config/budget.json (materialized) for status_gist_id, alerting topic,
// projects_in_rotation. Reads env: GITHUB_TOKEN | GIST_AUTH_TOKEN. Always
// exits 0; failures are logged but never crash the host.
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfgPath = resolve(REPO_ROOT, "config", "budget.json");
  if (!existsSync(cfgPath)) {
    console.error("[post-merge-monitor] config/budget.json missing");
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const gistId = cfg.status_gist_id ?? "";
  const gistToken = process.env.GIST_AUTH_TOKEN || process.env.GITHUB_TOKEN || "";
  const ntfyEnabled = cfg.alerting?.enabled === true;
  const ntfyTopic = cfg.alerting?.topic ?? null;
  const projectsInRotation = Array.isArray(cfg.projects_in_rotation) ? cfg.projects_in_rotation : [];

  const summary = await runPostMergeMonitor({
    gistId, gistToken,
    localJsonPath: resolve(REPO_ROOT, "config", "local.json"),
    projectsInRotation, ntfyTopic, ntfyEnabled,
  });
  console.log(`[post-merge-monitor] processed=${summary.processed} deferred=${summary.deferred} skipped=${summary.skipped} completed=${summary.completed} suspended=${summary.suspended} gc=${summary.gc_dropped ?? 0} gist=${summary.gist_outcome?.ok ? "ok" : "fail"}`);
  process.exit(0);
}

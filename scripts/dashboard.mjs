#!/usr/bin/env node
// Budget Dispatcher Dashboard -- localhost web UI for engine switching & monitoring.
// Zero external dependencies. Uses Node built-in http module.
// Start: node scripts/dashboard.mjs [--port 7380]

import { createServer } from "node:http";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn, exec, execFileSync } from "node:child_process";

import { resolveModel } from "./lib/router.mjs";
import { computeHealth } from "./lib/health.mjs";
import { createCachedFn } from "./lib/cache.mjs";
import { getSafeTestEnv } from "./lib/worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const CONFIG_PATH = join(REPO_ROOT, "config", "budget.json");
const SNAPSHOT_PATH = join(REPO_ROOT, "status", "usage-estimate.json");
const LAST_RUN_PATH = join(REPO_ROOT, "status", "budget-dispatch-last-run.json");
const LOG_PATH = join(REPO_ROOT, "status", "budget-dispatch-log.jsonl");
const RUNS_DIR = join(REPO_ROOT, "status", "dispatcher-runs");
const PAUSE_PATH = join(REPO_ROOT, "config", "PAUSED");

const PORT = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 && process.argv[idx + 1] ? parseInt(process.argv[idx + 1], 10) : 7380;
})();
const NO_OPEN = process.argv.includes("--no-open");

// ---- Helpers ----

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readLogLines() {
  try {
    return readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  } catch { return []; }
}

function parseLogLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function countTodayRuns() {
  const lines = readLogLines();
  const todayPrefix = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseLogLine(lines[i]);
    if (!obj?.ts?.startsWith(todayPrefix)) break;
    if (obj.outcome !== "skipped" && obj.outcome !== "wrapper-success") count++;
  }
  return count;
}

function esc(s) {
  if (typeof s !== "string") return String(s ?? "");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Activity Info (transcript mtime scan) ----

function getActivityInfo() {
  const config = readJson(CONFIG_PATH);
  const idleRequired = (config?.activity_gate?.idle_minutes_required ?? 20) * 60; // seconds
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return { last_activity_ms: null, idle_seconds: null, idle_required_seconds: idleRequired, is_idle: false };

  let latestMtime = 0;
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.endsWith(".jsonl")) {
          const mt = statSync(full).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        }
      } catch { /* skip */ }
    }
  }
  walk(root);

  if (latestMtime === 0) return { last_activity_ms: null, idle_seconds: null, idle_required_seconds: idleRequired, is_idle: false };
  const idleSec = Math.floor((Date.now() - latestMtime) / 1000);
  return {
    last_activity_ms: latestMtime,
    idle_seconds: idleSec,
    idle_required_seconds: idleRequired,
    is_idle: idleSec >= idleRequired,
  };
}

// ---- Auto Branches (origin/auto/* across rotation projects) ----

function getAutoBranches() {
  const config = readJson(CONFIG_PATH);
  if (!config) return [];
  const projects = config.projects_in_rotation ?? [];
  const branches = [];

  for (const proj of projects) {
    if (!proj.path || !existsSync(proj.path)) continue;
    try {
      const raw = execFileSync("git", [
        "branch", "-r", "--list", "origin/auto/*",
        "--sort=-committerdate",
        "--format=%(refname:short)|%(committerdate:iso-strict)|%(subject)",
      ], { cwd: proj.path, timeout: 5000, encoding: "utf8", env: getSafeTestEnv() }).trim();
      if (!raw) continue;
      for (const line of raw.split(/\r?\n/).slice(0, 5)) {
        const [branch, dateIso, ...subjectParts] = line.split("|");
        if (!branch) continue;
        branches.push({
          branch: branch.replace("origin/", ""),
          project: proj.slug,
          date: dateIso,
          subject: subjectParts.join("|"),
        });
      }
    } catch { /* git not available or no remotes */ }
  }

  // Sort all by date desc, cap at 10
  branches.sort((a, b) => new Date(b.date) - new Date(a.date));
  return branches.slice(0, 10);
}

// ---- Scheduled Task Health (cached) ----
let _taskCache = null;
let _taskCacheTime = 0;
const TASK_CACHE_TTL = 60_000;

// ---- Dispatcher Health (cached, reads JSONL log) ----
let _healthCache = null;
let _healthCacheTime = 0;
const HEALTH_CACHE_TTL = 60_000;

function getCachedHealth() {
  const now = Date.now();
  if (_healthCache && now - _healthCacheTime < HEALTH_CACHE_TTL) return _healthCache;
  _healthCache = computeHealth(LOG_PATH);
  _healthCacheTime = now;
  return _healthCache;
}

function getScheduledTaskInfo() {
  const now = Date.now();
  if (_taskCache && now - _taskCacheTime < TASK_CACHE_TTL) return _taskCache;
  try {
    const raw = execFileSync("powershell", [
      "-NoProfile", "-Command",
      "$t=Get-ScheduledTask BudgetDispatcher-Node -EA Stop;" +
      "$i=Get-ScheduledTaskInfo BudgetDispatcher-Node -EA Stop;" +
      "$t.State;" +
      "if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{'none'};" +
      "if($i.LastRunTime.Year -gt 1999){$i.LastRunTime.ToString('o')}else{'none'};" +
      "$i.LastTaskResult",
    ], { timeout: 5000, encoding: "utf8", env: getSafeTestEnv() }).trim();
    const [state, next, last, result] = raw.split(/\r?\n/);
    const parsedResult = parseInt(result, 10);
    _taskCache = {
      state: state || "Unknown",
      next_run: next === "none" ? null : next,
      last_run: last === "none" ? null : last,
      last_result: isNaN(parsedResult) ? null : parsedResult,
    };
  } catch {
    _taskCache = { state: "NotFound", next_run: null, last_run: null, last_result: null };
  }
  _taskCacheTime = now;
  return _taskCache;
}

// ---- API: State ----

function getState() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config/budget.json not found or invalid" };

  const snapshot = readJson(SNAPSHOT_PATH);
  const lastRun = readJson(LAST_RUN_PATH);

  const override = config.engine_override ?? null;
  let nextEngine;
  if (override && override !== "auto") {
    nextEngine = override;
  } else {
    nextEngine = snapshot?.dispatch_authorized ? "claude" : "node";
  }

  // Recent logs (10)
  const allLines = readLogLines();
  const recentLogs = allLines.slice(-10).reverse().map(parseLogLine).filter(Boolean);

  return {
    engine_override: override,
    next_engine: nextEngine,
    paused: config.paused ?? false,
    pause_file_exists: existsSync(PAUSE_PATH),
    dry_run: config.dry_run ?? false,
    budget: snapshot ?? null,
    last_run: lastRun,
    recent_logs: recentLogs,
    projects: (config.projects_in_rotation ?? []).map((p) => p.slug),
    max_runs_per_day: snapshot?.weekly?.effective_max_runs_per_day ?? config.max_runs_per_day ?? 8,
    today_runs: cachedTodayRuns.get(),
    activity_gate: config.activity_gate ?? {},
    activity_info: cachedActivityInfo.get(),
    scheduled_task: getScheduledTaskInfo(),
    health: getCachedHealth(),
  };
}

// ---- API: Predict ----

function predict() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config not found" };

  const projects = config.projects_in_rotation ?? [];
  if (projects.length === 0) return { prediction: null, reason: "no projects in rotation" };

  const allLines = readLogLines();

  // Per-project: find last dispatch time and recent outcomes
  const projectData = projects.map((proj) => {
    let lastTs = null;
    let recentOutcomes = [];
    for (let i = allLines.length - 1; i >= 0; i--) {
      const obj = parseLogLine(allLines[i]);
      if (!obj || obj.project !== proj.slug) continue;
      if (!lastTs && obj.outcome !== "skipped") lastTs = obj.ts;
      if (recentOutcomes.length < 5) recentOutcomes.push(obj);
      if (recentOutcomes.length >= 5 && lastTs) break;
    }
    return { ...proj, last_dispatched: lastTs, recent_outcomes: recentOutcomes };
  });

  // Sort: never-dispatched first, then oldest
  projectData.sort((a, b) => {
    if (!a.last_dispatched && !b.last_dispatched) return 0;
    if (!a.last_dispatched) return -1;
    if (!b.last_dispatched) return 1;
    return new Date(a.last_dispatched) - new Date(b.last_dispatched);
  });

  const top = projectData[0];
  const tasks = top.opportunistic_tasks ?? [];
  if (tasks.length === 0) return { prediction: null, reason: "no tasks for top project" };

  // Pick first viable task (skip recently-failed ones)
  const failedTasks = new Set(
    (top.recent_outcomes || [])
      .filter((o) => o.outcome === "error")
      .slice(0, 2)
      .map((o) => o.task)
  );
  const task = tasks.find((t) => !failedTasks.has(t)) || tasks[0];
  const route = resolveModel(task, config.free_model_roster ?? {});

  return {
    prediction: {
      project: top.slug,
      task,
      model: route.model,
      delegate_to: route.delegate_to,
      taskClass: route.taskClass,
      last_dispatched: top.last_dispatched,
    },
  };
}

// ---- API: Projects ----

function getProjects() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config not found" };

  const allLines = readLogLines();
  const projects = (config.projects_in_rotation ?? []).map((proj) => {
    const history = [];
    for (let i = allLines.length - 1; i >= 0; i--) {
      const obj = parseLogLine(allLines[i]);
      if (!obj || obj.project !== proj.slug) continue;
      history.push(obj);
      if (history.length >= 10) break;
    }
    return { ...proj, history };
  });

  // Model routing table
  const roster = config.free_model_roster ?? {};
  const routing = {
    classes: roster.classes ?? {},
    claude_only: roster.claude_only ?? [],
    forbidden_models: roster.forbidden_models ?? [],
    fallback_chain: roster.fallback_chain ?? [],
  };

  return { projects, routing };
}

// ---- API: Paginated Logs ----

function getLogs(offset = 0, limit = 20, filters = {}) {
  const allLines = readLogLines();
  // Reverse for newest-first
  const reversed = allLines.slice().reverse();
  let filtered = reversed.map(parseLogLine).filter(Boolean);

  if (filters.outcome) filtered = filtered.filter((l) => l.outcome === filters.outcome);
  if (filters.project) filtered = filtered.filter((l) => l.project === filters.project);

  const total = filtered.length;
  const entries = filtered.slice(offset, offset + limit);
  return { entries, total, has_more: offset + limit < total };
}

// ---- API: Run Log ----

const RUN_LOG_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{8}\.log$/;

function getRunLog(file) {
  if (!file || !RUN_LOG_PATTERN.test(file)) return { error: "invalid file name" };
  const filePath = join(RUNS_DIR, file);
  if (!existsSync(filePath)) return { error: "file not found" };
  try { return { content: readFileSync(filePath, "utf8") }; } catch { return { error: "read error" }; }
}

// ---- API: Analytics ----

function getAnalytics() {
  const allLines = readLogLines();
  const entries = allLines.map(parseLogLine).filter(Boolean);

  // -- Outcome totals --
  const outcomes = {};
  for (const e of entries) {
    outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1;
  }

  // -- Skip reason breakdown --
  const skipReasons = {};
  for (const e of entries) {
    if (e.outcome === "skipped" && e.reason) {
      skipReasons[e.reason] = (skipReasons[e.reason] || 0) + 1;
    }
  }

  // -- 14-day daily breakdown (outcomes stacked) --
  const now = new Date();
  const daily = [];
  for (let d = 13; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const prefix = date.toISOString().slice(0, 10);
    const day = { date: prefix, success: 0, error: 0, skipped: 0, "dry-run": 0, other: 0 };
    for (const e of entries) {
      if (!e.ts?.startsWith(prefix)) continue;
      if (day[e.outcome] !== undefined) day[e.outcome]++;
      else day.other++;
    }
    daily.push(day);
  }

  // -- Hourly heatmap (0-23h, all time) --
  const hourly = new Array(24).fill(0);
  const hourlySkips = new Array(24).fill(0);
  for (const e of entries) {
    if (!e.ts) continue;
    const h = new Date(e.ts).getHours();
    if (e.outcome === "skipped") hourlySkips[h]++;
    else hourly[h]++;
  }

  // -- Per-project stats --
  const projectStats = {};
  for (const e of entries) {
    if (!e.project) continue;
    if (!projectStats[e.project]) projectStats[e.project] = { total: 0, success: 0, error: 0, skipped: 0, tasks: {} };
    const ps = projectStats[e.project];
    ps.total++;
    if (e.outcome === "success") ps.success++;
    else if (e.outcome === "error") ps.error++;
    else if (e.outcome === "skipped") ps.skipped++;
    if (e.task) ps.tasks[e.task] = (ps.tasks[e.task] || 0) + 1;
  }

  // -- Per-model stats (which models were used) --
  const modelStats = {};
  for (const e of entries) {
    const model = e.modelUsed || e.delegate_to;
    if (!model) continue;
    if (!modelStats[model]) modelStats[model] = { total: 0, success: 0, error: 0 };
    modelStats[model].total++;
    if (e.outcome === "success") modelStats[model].success++;
    else if (e.outcome === "error") modelStats[model].error++;
  }

  return {
    total_entries: entries.length,
    first_entry: entries[0]?.ts || null,
    last_entry: entries[entries.length - 1]?.ts || null,
    outcomes,
    skip_reasons: skipReasons,
    daily,
    hourly: hourly.map((dispatches, h) => ({ hour: h, dispatches, skips: hourlySkips[h] })),
    project_stats: projectStats,
    model_stats: modelStats,
  };
}

// C1.1: Cached wrappers to avoid re-reading the entire JSONL log on every poll.
const cachedAnalytics = createCachedFn(getAnalytics, 60_000);       // 1 min
const cachedPredict = createCachedFn(predict, 30_000);               // 30s
const cachedTodayRuns = createCachedFn(countTodayRuns, 30_000);      // 30s
const cachedBudgetDetail = createCachedFn(getBudgetDetail, 30_000);  // 30s
const cachedProjects = createCachedFn(getProjects, 30_000);          // 30s
const cachedActivityInfo = createCachedFn(getActivityInfo, 15_000);  // 15s (activity is time-sensitive)
const cachedAutoBranches = createCachedFn(getAutoBranches, 120_000); // 2 min (git ops are slow)

// ---- API: Budget Detail ----

function getBudgetDetail() {
  const snapshot = readJson(SNAPSHOT_PATH);
  const config = readJson(CONFIG_PATH);
  if (!snapshot) return { error: "no snapshot" };

  // 7-day daily histogram from JSONL
  const allLines = readLogLines();
  const now = new Date();
  const days = [];
  for (let d = 6; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const prefix = date.toISOString().slice(0, 10);
    let dispatches = 0;
    let errors = 0;
    let skips = 0;
    for (const line of allLines) {
      const obj = parseLogLine(line);
      if (!obj?.ts?.startsWith(prefix)) continue;
      if (obj.outcome === "success" || obj.outcome === "dry-run") dispatches++;
      else if (obj.outcome === "error") errors++;
      else if (obj.outcome === "skipped") skips++;
    }
    days.push({ date: prefix, dispatches, errors, skips });
  }

  return {
    snapshot,
    daily_histogram: days,
    monthly: config?.monthly ?? {},
    weekly_config: config?.weekly ?? {},
    token_weights: config?.token_weights ?? {},
    today_runs: cachedTodayRuns.get(),
    max_runs_per_day: snapshot?.weekly?.effective_max_runs_per_day ?? config?.max_runs_per_day ?? 8,
  };
}

// ---- API: Project Docs (About tab) ----

function getProjectDocs() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config not found" };

  const projects = (config.projects_in_rotation ?? []).map((proj) => {
    const docs = {};
    const tryRead = (name, ...paths) => {
      for (const p of paths) {
        const full = join(proj.path, p);
        if (existsSync(full)) {
          try { docs[name] = readFileSync(full, "utf8"); return; } catch { /* skip */ }
        }
      }
    };
    tryRead("claude_md", "CLAUDE.md");
    tryRead("dispatch_md", "DISPATCH.md");
    tryRead("state_md", "ai/STATE.md");
    tryRead("roadmap_md", "ai/ROADMAP.md");
    tryRead("decisions_md", "ai/DECISIONS.md");

    return {
      slug: proj.slug,
      path: proj.path,
      sandbox: proj.sandbox || false,
      canary: proj.canary || false,
      clinical_gate: proj.clinical_gate || false,
      docs,
    };
  });

  return { projects };
}

// ---- Fleet: Roadmap Parser ----

function parseRoadmap(md) {
  const phases = [];
  const sections = md.split(/^## /m).slice(1);

  for (const section of sections) {
    const nlIdx = section.indexOf("\n");
    const name = (nlIdx === -1 ? section : section.slice(0, nlIdx)).trim();
    const body = nlIdx === -1 ? "" : section.slice(nlIdx);

    // Skip "Done" sections with nothing in them
    if (/^done$/i.test(name) && /nothing yet/i.test(body)) continue;

    let total = 0, done = 0;

    // Strategy 1: Checkboxes (Format A — greenfield projects)
    const checked = (body.match(/^- \[x\]/gmi) || []).length;
    const unchecked = (body.match(/^- \[ \]/gm) || []).length;

    if (checked + unchecked > 0) {
      total = checked + unchecked;
      done = checked;
    }
    // Strategy 2: Goal-based status lines (Format C — workflow-enhancement)
    else if (/\*\*Status:\*\*/m.test(body)) {
      const goals = body.split(/^### /m).slice(1);
      total = goals.length;
      for (const g of goals) {
        if (/\*\*Status:\*\*\s*DONE/i.test(g)) done++;
      }
    }
    // Strategy 3: Freeform bullets with done markers (Format B — combo)
    else {
      const bullets = (body.match(/^- .+$/gm) || []);
      total = bullets.length;
      done = bullets.filter((b) => /\*\(done/i.test(b) || /\*\(configured\)/i.test(b)).length;
    }

    if (total === 0) continue;

    const status = done >= total ? "complete" : done > 0 ? "in-progress" : "not-started";
    phases.push({ name, total, done, status });
  }
  return phases;
}

// ---- Fleet: Data Aggregator ----

function getFleetData() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config not found" };

  const allLines = readLogLines();
  const projects = (config.projects_in_rotation ?? []).map((proj) => {
    // Try ROADMAP.md (root), then ai/ROADMAP.md
    let roadmapMd = null;
    let roadmapSource = null;
    for (const rel of ["ROADMAP.md", "ai/ROADMAP.md"]) {
      const full = join(proj.path, rel);
      if (existsSync(full)) {
        try { roadmapMd = readFileSync(full, "utf8"); roadmapSource = rel; break; } catch { /* skip */ }
      }
    }

    const phases = roadmapMd ? parseRoadmap(roadmapMd) : null;

    // Scan log for this project
    let lastDispatch = null, totalDispatches = 0, lastTask = null;
    for (let i = allLines.length - 1; i >= 0; i--) {
      const obj = parseLogLine(allLines[i]);
      if (!obj || obj.project !== proj.slug) continue;
      if (obj.outcome === "skipped") continue;
      totalDispatches++;
      if (!lastDispatch) {
        lastDispatch = obj.ts;
        lastTask = obj.task || null;
      }
    }

    return {
      slug: proj.slug,
      sandbox: proj.sandbox || false,
      canary: proj.canary || false,
      roadmap_source: roadmapSource,
      phases,
      last_dispatch: lastDispatch,
      total_dispatches: totalDispatches,
      last_task: lastTask,
    };
  });

  return { projects };
}

// ---- Fleet Remote: Gist-based cross-machine view ----

let _gistCache = { data: null, ts: 0 };
const GIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getGistFleetData() {
  const config = readJson(CONFIG_PATH);
  const gistId = config?.status_gist_id;
  if (!gistId) return { machines: [], error: "no status_gist_id in config" };

  // Return cached if fresh
  if (_gistCache.data && Date.now() - _gistCache.ts < GIST_CACHE_TTL_MS) {
    return _gistCache.data;
  }

  try {
    const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "budget-dispatcher-dashboard" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return { machines: [], error: `gist fetch failed: ${resp.status}` };
    }
    const gist = await resp.json();
    const machines = [];
    let health = null;
    let lastRun = null;

    for (const [filename, file] of Object.entries(gist.files)) {
      try {
        const parsed = JSON.parse(file.content);
        if (filename.startsWith("fleet-") && filename.endsWith(".json")) {
          machines.push(parsed);
        } else if (filename === "health.json") {
          health = parsed;
        } else if (filename === "budget-dispatch-last-run.json") {
          lastRun = parsed;
        }
      } catch { /* skip unparseable files */ }
    }

    const result = { machines, health, lastRun, fetched_at: new Date().toISOString() };
    _gistCache = { data: result, ts: Date.now() };
    return result;
  } catch (e) {
    return { machines: [], error: e.message };
  }
}

// ---- Mutations ----

function setEngineOverride(engine) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };
  const valid = ["auto", "node", "claude"];
  if (!valid.includes(engine)) return { ok: false, error: `invalid engine: ${engine}` };
  config.engine_override = engine === "auto" ? null : engine;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, engine_override: config.engine_override };
}

function togglePause(paused) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };
  config.paused = !!paused;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, paused: config.paused };
}

function setDryRun(dryRun) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };
  config.dry_run = !!dryRun;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, dry_run: config.dry_run };
}

function reorderProject(slug, direction) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };
  const arr = config.projects_in_rotation ?? [];
  const idx = arr.findIndex((p) => p.slug === slug);
  if (idx === -1) return { ok: false, error: "project not found" };
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= arr.length) return { ok: false, error: "already at edge" };
  [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true };
}

function updateProjectTasks(slug, tasks) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };
  const proj = (config.projects_in_rotation ?? []).find((p) => p.slug === slug);
  if (!proj) return { ok: false, error: "project not found" };
  if (!Array.isArray(tasks)) return { ok: false, error: "tasks must be array" };
  proj.opportunistic_tasks = tasks;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true };
}

function triggerDispatch(dryRun = true) {
  const args = ["scripts/dispatch.mjs", "--force"];
  if (dryRun) args.push("--dry-run");
  // A2.1: Forward only safe env + the API keys dispatch.mjs actually needs.
  const dispatchEnv = getSafeTestEnv();
  for (const k of ["GEMINI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"]) {
    if (process.env[k]) dispatchEnv[k] = process.env[k];
  }
  const child = spawn("node", args, {
    cwd: REPO_ROOT, stdio: "ignore", detached: true, env: dispatchEnv,
  });
  child.unref();
  return { ok: true, pid: child.pid, dry_run: dryRun };
}

// ---- HTTP Server ----

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// A5.1: Host-header allowlist blocks DNS-rebinding attacks on mutation endpoints.
// Port-qualified only — browsers always include port for non-standard ports.
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
]);
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`,
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // A5.1: Reject non-GET requests with unrecognized Host or Origin headers.
  if (req.method !== "GET") {
    const host = req.headers.host;
    if (!host || !ALLOWED_HOSTS.has(host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid Host header");
      return;
    }
    // Origin is only sent by browsers on cross-origin requests. Absent Origin
    // means same-origin browser request or non-browser client (curl, scripts) —
    // both are acceptable for a localhost-only service.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid Origin header");
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") { json(res, getState()); return; }
  if (req.method === "GET" && url.pathname === "/api/predict") { json(res, cachedPredict.get()); return; }
  if (req.method === "GET" && url.pathname === "/api/budget-detail") { json(res, cachedBudgetDetail.get()); return; }
  if (req.method === "GET" && url.pathname === "/api/analytics") { json(res, cachedAnalytics.get()); return; }
  if (req.method === "GET" && url.pathname === "/api/projects") { json(res, cachedProjects.get()); return; }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const outcome = url.searchParams.get("outcome") || "";
    const project = url.searchParams.get("project") || "";
    json(res, getLogs(offset, Math.min(limit, 100), { outcome: outcome || undefined, project: project || undefined }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/project-docs") { json(res, getProjectDocs()); return; }
  if (req.method === "GET" && url.pathname === "/api/fleet") { json(res, getFleetData()); return; }
  if (req.method === "GET" && url.pathname === "/api/fleet-remote") {
    try { json(res, await getGistFleetData()); } catch (e) { json(res, { machines: [], error: e.message }); }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/auto-branches") { json(res, cachedAutoBranches.get()); return; }
  if (req.method === "GET" && url.pathname === "/api/run-log") {
    const file = url.searchParams.get("file") || "";
    json(res, getRunLog(file));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/engine") { json(res, setEngineOverride((await parseBody(req)).engine)); return; }
  if (req.method === "POST" && url.pathname === "/api/pause") { json(res, togglePause((await parseBody(req)).paused)); return; }
  if (req.method === "POST" && url.pathname === "/api/dry-run") { json(res, setDryRun((await parseBody(req)).dry_run)); return; }
  if (req.method === "POST" && url.pathname === "/api/dispatch") { json(res, triggerDispatch((await parseBody(req)).dry_run !== false)); return; }
  if (req.method === "POST" && url.pathname === "/api/projects/reorder") {
    const b = await parseBody(req); json(res, reorderProject(b.slug, b.direction)); return;
  }
  if (req.method === "POST" && url.pathname === "/api/projects/tasks") {
    const b = await parseBody(req); json(res, updateProjectTasks(b.slug, b.tasks)); return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Budget Dispatcher Dashboard running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (!NO_OPEN) exec(`start chrome ${url}`);
});

// ---- HTML Page ----

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Budget Dispatcher</title>
<style>
  :root {
    --bg: #1a1b26; --surface: #24283b; --surface2: #292e42; --border: #414868;
    --text: #c0caf5; --text-dim: #565f89; --accent: #7aa2f7;
    --green: #9ece6a; --red: #f7768e; --yellow: #e0af68; --cyan: #7dcfff;
    --magenta: #bb9af7;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    background: var(--bg); color: var(--text);
    max-width: 960px; margin: 0 auto; padding: 16px;
    font-size: 13px;
  }
  h1 { font-size: 16px; color: var(--accent); margin-bottom: 12px; }

  /* Tabs */
  .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--border); }
  .tabs button {
    padding: 8px 16px; background: transparent; border: none;
    color: var(--text-dim); font-family: inherit; font-size: 13px;
    cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px;
    transition: color .15s, border-color .15s;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .view { display: none; }
  .view.active { display: block; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .card h2 { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; font-weight: 600; }

  /* Health Beacon */
  /* Health banner -- only shown when dispatcher is in "down" state */
  .health-banner { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 8px; margin-bottom: 12px; background: var(--red); color: #000; font-weight: 600; box-shadow: 0 0 0 2px var(--red); }
  .health-banner-icon { width: 32px; height: 32px; border-radius: 50%; background: #000; color: var(--red); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 900; flex-shrink: 0; }
  .health-banner-text { flex: 1; }
  .health-banner-title { font-weight: 800; font-size: 15px; letter-spacing: 0.5px; }
  .health-banner-sub { font-weight: 500; font-size: 12px; margin-top: 2px; opacity: 0.85; }

  .beacon { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; border-left: 6px solid var(--green); background: rgba(158,206,106,0.06); }
  .beacon.warn { border-left-color: var(--yellow); background: rgba(224,175,104,0.06); }
  .beacon.error { border-left-color: var(--red); background: rgba(247,118,142,0.06); }
  .beacon-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
  .beacon.warn .beacon-dot { background: var(--yellow); }
  .beacon.error .beacon-dot { background: var(--red); }
  .beacon-text { flex: 1; }
  .beacon-title { font-weight: 700; font-size: 14px; }
  .beacon-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

  /* Metrics */
  .metric { display: flex; justify-content: space-between; padding: 3px 0; }
  .metric .label { color: var(--text-dim); }
  .metric .value { font-weight: 600; }
  .yes { color: var(--green); } .no { color: var(--red); } .warn-c { color: var(--yellow); }

  /* Engine buttons */
  .engine-btns { display: flex; gap: 8px; margin-bottom: 8px; }
  .engine-btns button {
    flex: 1; padding: 8px 0; border: 2px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text); cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 600; transition: all .15s;
  }
  .engine-btns button:hover { border-color: var(--accent); color: var(--accent); }
  .engine-btns button.active { border-color: var(--accent); background: rgba(122,162,247,0.12); color: var(--accent); }

  /* Actions */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button {
    flex: 1; min-width: 100px; padding: 8px 0; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); cursor: pointer;
    font-family: inherit; font-size: 12px; transition: all .15s;
  }
  .actions button:hover { border-color: var(--accent); }
  .actions button.on { border-color: var(--yellow); color: var(--yellow); }

  /* Budget bars */
  .bar-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .bar-label { width: 28px; color: var(--text-dim); font-size: 11px; flex-shrink: 0; }
  .bar-track { flex: 1; height: 18px; background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; position: relative; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }
  .bar-fill.ok { background: var(--green); } .bar-fill.over { background: var(--red); } .bar-fill.mid { background: var(--yellow); }
  .bar-marker { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); opacity: .7; }
  .bar-value { width: 110px; text-align: right; font-size: 11px; flex-shrink: 0; }

  /* Grid row */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }

  /* Prediction */
  .pred-row { display: flex; gap: 8px; padding: 2px 0; }
  .pred-label { color: var(--text-dim); width: 70px; flex-shrink: 0; }
  .pred-value { color: var(--text); }
  .pred-value.model { color: var(--cyan); }

  /* Log entries */
  .log-entry { font-size: 11px; padding: 5px 0; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: baseline; }
  .log-entry:last-child { border-bottom: none; }
  .log-entry .ts { color: var(--text-dim); white-space: nowrap; width: 110px; flex-shrink: 0; }
  .log-entry .outcome { font-weight: 600; width: 80px; flex-shrink: 0; }
  .log-entry .outcome.success, .log-entry .outcome.wrapper-success { color: var(--green); }
  .log-entry .outcome.skipped, .log-entry .outcome.dry-run { color: var(--text-dim); }
  .log-entry .outcome.error { color: var(--red); }
  .log-entry .info { color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-entry .expand-btn { color: var(--accent); cursor: pointer; font-size: 11px; background: none; border: none; font-family: inherit; padding: 0 4px; }
  .log-entry .expand-btn:hover { color: var(--cyan); }
  .run-log-detail { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin: 6px 0; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }

  /* Projects */
  .proj-header { display: flex; align-items: center; gap: 8px; padding: 10px 0; cursor: pointer; border-bottom: 1px solid var(--border); }
  .proj-header:hover { color: var(--accent); }
  .proj-header .arrow { transition: transform .2s; font-size: 10px; }
  .proj-header .arrow.open { transform: rotate(90deg); }
  .proj-slug { font-weight: 700; flex: 1; }
  .proj-last { font-size: 11px; color: var(--text-dim); }
  .proj-body { padding: 10px 0 10px 18px; display: none; }
  .proj-body.open { display: block; }
  .proj-meta { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; }
  .proj-tasks { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .proj-tasks label { font-size: 11px; display: flex; align-items: center; gap: 3px; cursor: pointer; }
  .proj-tasks input { accent-color: var(--accent); }
  .proj-btns { display: flex; gap: 6px; margin-top: 8px; }
  .proj-btns button { font-size: 11px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); cursor: pointer; font-family: inherit; }
  .proj-btns button:hover { border-color: var(--accent); }

  /* Routing table */
  .route-table { width: 100%; font-size: 11px; border-collapse: collapse; }
  .route-table th { text-align: left; color: var(--text-dim); padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .route-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .route-table td.model { color: var(--cyan); }

  /* Config display */
  .cfg-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  .cfg-label { color: var(--text-dim); }
  .cfg-value { font-weight: 600; }

  /* Sparkline */
  .sparkline { display: flex; align-items: flex-end; gap: 2px; height: 40px; padding: 4px 0; }
  .sparkline .bar { flex: 1; border-radius: 2px 2px 0 0; min-height: 2px; transition: height .3s; background: var(--accent); }
  .sparkline .bar.today { background: var(--cyan); }
  .sparkline .bar.err { background: var(--red); }
  .spark-labels { display: flex; gap: 2px; font-size: 9px; color: var(--text-dim); }
  .spark-labels span { flex: 1; text-align: center; }

  /* Analytics */
  .ana-big { font-size: 28px; font-weight: 800; line-height: 1.1; }
  .ana-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .ana-bar-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .ana-bar-label { width: 200px; font-size: 11px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
  .ana-bar-track { flex: 1; height: 16px; background: var(--surface2); border-radius: 3px; overflow: hidden; display: flex; }
  .ana-bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }
  .ana-bar-count { width: 80px; text-align: right; font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
  .ana-stacked { display: flex; gap: 3px; align-items: flex-end; padding: 4px 0; }
  .ana-stack-col { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .ana-stack-bars { display: flex; flex-direction: column-reverse; gap: 1px; width: 100%; }
  .ana-stack-label { font-size: 9px; color: var(--text-dim); margin-top: 4px; }
  .ana-stack-label.today { color: var(--cyan); font-weight: 700; }
  .ana-stack-count { font-size: 9px; color: var(--text-dim); }
  .ana-legend { display: flex; gap: 16px; font-size: 10px; color: var(--text-dim); margin-top: 8px; flex-wrap: wrap; }
  .ana-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .ana-heatmap { display: grid; grid-template-columns: repeat(12, 1fr); gap: 3px; }
  @media (max-width: 700px) { .ana-heatmap { grid-template-columns: repeat(8, 1fr); } }
  .ana-heat-cell { border-radius: 4px; padding: 6px 2px; text-align: center; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .ana-heat-hour { font-size: 10px; color: var(--text-dim); font-weight: 600; }
  .ana-heat-count { font-size: 12px; font-weight: 700; }
  .ana-proj-tasks { display: flex; gap: 6px; flex-wrap: wrap; padding: 2px 0 6px 208px; }
  .ana-task-tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--surface2); color: var(--text-dim); }
  .ana-task-tag b { color: var(--text); }

  /* Filters */
  .filters { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
  .filters select { background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 11px; }
  .filters .count { font-size: 11px; color: var(--text-dim); margin-left: auto; }
  .load-more { width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--accent); cursor: pointer; font-family: inherit; font-size: 12px; margin-top: 8px; }
  .load-more:hover { border-color: var(--accent); }

  .status-bar { font-size: 11px; color: var(--text-dim); text-align: center; margin-top: 8px; }
  .dim { color: var(--text-dim); }
  a { color: var(--accent); }

  /* About tab */
  .about-project { margin-bottom: 20px; }
  .about-project h3 { font-size: 15px; color: var(--accent); margin-bottom: 4px; }
  .about-project .about-sub { font-size: 11px; color: var(--text-dim); margin-bottom: 12px; }
  .about-section { margin-bottom: 12px; }
  .about-section-header {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; font-size: 12px; font-weight: 600; color: var(--text);
    transition: border-color .15s;
  }
  .about-section-header:hover { border-color: var(--accent); }
  .about-section-header .arrow { font-size: 10px; transition: transform .2s; }
  .about-section-header .arrow.open { transform: rotate(90deg); }
  .about-section-header .tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 400; }
  .about-section-header .tag.charter { background: rgba(122,162,247,.15); color: var(--accent); }
  .about-section-header .tag.tasks { background: rgba(158,206,106,.15); color: var(--green); }
  .about-section-header .tag.state { background: rgba(224,175,104,.15); color: var(--yellow); }
  .about-section-header .tag.roadmap { background: rgba(187,154,247,.15); color: var(--magenta); }
  .about-doc {
    display: none; padding: 12px; margin-top: 4px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    max-height: 500px; overflow-y: auto;
  }
  .about-doc.open { display: block; }
  .about-doc h4 { color: var(--accent); margin: 10px 0 4px 0; font-size: 12px; }
  .about-doc .md-h1 { color: var(--accent); font-size: 14px; font-weight: 700; margin: 8px 0 4px; display: block; }
  .about-doc .md-h2 { color: var(--cyan); font-size: 13px; font-weight: 700; margin: 8px 0 4px; display: block; }
  .about-doc .md-h3 { color: var(--magenta); font-size: 12px; font-weight: 600; margin: 6px 0 2px; display: block; }
  .about-doc .md-bold { font-weight: 700; }
  .about-doc .md-done { color: var(--green); }
  .about-doc .md-todo { color: var(--text-dim); }
  .about-doc .md-table { border-collapse: collapse; margin: 6px 0; font-size: 11px; }
  .about-doc .md-table th { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); color: var(--text-dim); }
  .about-doc .md-table td { padding: 3px 8px; border-bottom: 1px solid var(--border); }

  /* Fleet tab */
  .fleet-legend { display: flex; gap: 16px; margin-bottom: 16px; font-size: 11px; color: var(--text-dim); align-items: center; }
  .fleet-legend-item { display: flex; align-items: center; gap: 4px; }
  .fleet-legend-swatch { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
  .fleet-legend-swatch.complete { background: rgba(158,206,106,0.25); border-left: 3px solid var(--green); }
  .fleet-legend-swatch.in-progress { background: rgba(224,175,104,0.25); border-left: 3px solid var(--yellow); }
  .fleet-legend-swatch.not-started { background: var(--surface2); border-left: 3px solid var(--border); }
  .fleet-row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .fleet-row:last-child { border-bottom: none; }
  .fleet-label { min-width: 160px; max-width: 200px; flex-shrink: 0; }
  .fleet-slug { font-weight: 700; color: var(--accent); font-size: 13px; cursor: default; }
  .fleet-slug .tag { font-weight: 400; font-size: 10px; color: var(--text-dim); margin-left: 4px; }
  .fleet-meta { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .fleet-phases { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .fleet-cell { display: inline-flex; flex-direction: column; justify-content: center; padding: 4px 8px; border-radius: 4px; min-width: 90px; max-width: 180px; height: 36px; font-size: 10px; line-height: 1.3; overflow: hidden; }
  .fleet-cell.complete { background: rgba(158,206,106,0.18); border-left: 3px solid var(--green); color: var(--green); }
  .fleet-cell.in-progress { background: rgba(224,175,104,0.18); border-left: 3px solid var(--yellow); color: var(--yellow); }
  .fleet-cell.not-started { background: var(--surface2); border-left: 3px solid var(--border); color: var(--text-dim); }
  .fleet-cell.no-roadmap { background: var(--surface2); border: 1px dashed var(--border); color: var(--text-dim); min-width: 120px; text-align: center; }
  .fleet-cell-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .fleet-cell-count { font-size: 9px; opacity: 0.8; }
  .fleet-summary { margin-top: 12px; font-size: 11px; color: var(--text-dim); display: flex; gap: 16px; }
  .fleet-summary .val { font-weight: 700; }
</style>
</head>
<body>

<h1>Budget Dispatcher</h1>

<div class="tabs">
  <button class="active" onclick="setTab('status')">Status</button>
  <button onclick="setTab('analytics')">Analytics</button>
  <button onclick="setTab('budget')">Budget</button>
  <button onclick="setTab('projects')">Projects</button>
  <button onclick="setTab('logs')">Logs</button>
  <button onclick="setTab('config')">Config</button>
  <button onclick="setTab('fleet')">Fleet</button>
  <button onclick="setTab('about')">About</button>
</div>

<!-- ============ STATUS TAB ============ -->
<div id="view-status" class="view active">
  <div id="health-banner" class="health-banner" style="display:none">
    <div class="health-banner-icon">!</div>
    <div class="health-banner-text">
      <div class="health-banner-title">DISPATCHER DOWN</div>
      <div class="health-banner-sub" id="health-banner-sub"></div>
    </div>
  </div>

  <div class="beacon" id="beacon">
    <div class="beacon-dot"></div>
    <div class="beacon-text">
      <div class="beacon-title" id="beacon-title">Loading...</div>
      <div class="beacon-sub" id="beacon-sub"></div>
    </div>
  </div>

  <div class="card" id="prediction-card">
    <h2>Next Dispatch (predicted)</h2>
    <div id="prediction-body">Loading...</div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Engine Mode</h2>
      <div class="engine-btns">
        <button id="btn-auto" onclick="setEngine('auto')">Auto</button>
        <button id="btn-node" onclick="setEngine('node')">Free Only</button>
        <button id="btn-claude" onclick="setEngine('claude')">Claude</button>
      </div>
      <div class="dim">Next: <span id="next-engine" style="font-weight:700">--</span></div>
    </div>
    <div class="card">
      <h2>Actions</h2>
      <div class="actions">
        <button id="btn-pause" onclick="togglePause()">Pause</button>
        <button onclick="dispatchNow(true)">Dry Run</button>
        <button onclick="dispatchNow(false)">Dispatch</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Budget</h2>
    <div id="budget-bars"></div>
    <div style="margin-top:6px">
      <div class="metric"><span class="label">Authorized</span><span class="value" id="s-auth">--</span></div>
      <div class="metric"><span class="label">Reason</span><span class="value dim" id="s-reason" style="font-size:11px;max-width:600px">--</span></div>
      <div class="metric"><span class="label">Activity</span><span class="value" id="s-activity" style="font-size:11px">--</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Last Run</h2>
    <div class="metric"><span class="label">Status</span><span class="value" id="lr-status">--</span></div>
    <div class="metric"><span class="label">Reason</span><span class="value dim" id="lr-reason">--</span></div>
    <div class="metric"><span class="label">Duration</span><span class="value" id="lr-dur">--</span></div>
    <div class="metric"><span class="label">Time</span><span class="value" id="lr-time">--</span></div>
  </div>

  <div class="card">
    <h2>Scheduled Task</h2>
    <div class="metric"><span class="label">Status</span><span class="value" id="st-state">--</span></div>
    <div class="metric"><span class="label">Next Run</span><span class="value" id="st-next">--</span></div>
    <div class="metric"><span class="label">Last Run</span><span class="value dim" id="st-last">--</span></div>
    <div class="metric"><span class="label">Last Result</span><span class="value dim" id="st-result">--</span></div>
  </div>

  <div class="card">
    <h2>Recent Runs</h2>
    <div id="recent-logs">Loading...</div>
    <div style="margin-top:8px;text-align:right"><a href="#" onclick="setTab('logs');return false" style="font-size:11px">View all &rarr;</a></div>
  </div>
</div>

<!-- ============ ANALYTICS TAB ============ -->
<div id="view-analytics" class="view">
  <div id="analytics-content">Loading...</div>
</div>

<!-- ============ BUDGET TAB ============ -->
<div id="view-budget" class="view">
  <div id="budget-detail">Loading...</div>
</div>

<!-- ============ PROJECTS TAB ============ -->
<div id="view-projects" class="view">
  <div id="projects-list">Loading...</div>
</div>

<!-- ============ LOGS TAB ============ -->
<div id="view-logs" class="view">
  <div class="card">
    <h2>Dispatch Log</h2>
    <div class="filters">
      <select id="f-outcome" onchange="resetLogs()">
        <option value="">All outcomes</option>
        <option value="success">success</option>
        <option value="dry-run">dry-run</option>
        <option value="skipped">skipped</option>
        <option value="error">error</option>
        <option value="wrapper-success">wrapper-success</option>
      </select>
      <select id="f-project" onchange="resetLogs()"><option value="">All projects</option></select>
      <span class="count" id="log-count"></span>
    </div>
    <div id="log-entries"></div>
    <button class="load-more" id="load-more-btn" onclick="loadMoreLogs()" style="display:none">Load more</button>
  </div>
</div>

<!-- ============ CONFIG TAB ============ -->
<div id="view-config" class="view">
  <div class="card">
    <h2>Engine &amp; Dispatch Control</h2>
    <div class="engine-btns" style="margin-bottom:10px">
      <button id="cfg-btn-auto" onclick="setEngine('auto')">Auto</button>
      <button id="cfg-btn-node" onclick="setEngine('node')">Free Only</button>
      <button id="cfg-btn-claude" onclick="setEngine('claude')">Claude</button>
    </div>
    <div class="actions">
      <button id="cfg-btn-pause" onclick="togglePause()">Pause</button>
      <button id="cfg-btn-dry" onclick="toggleDryRun()">Dry Run: --</button>
    </div>
  </div>
  <div class="card" id="cfg-params">Loading...</div>
</div>

<!-- ============ FLEET TAB ============ -->
<div id="view-fleet" class="view">
  <div id="fleet-content">Loading...</div>
</div>

<!-- ============ ABOUT TAB ============ -->
<div id="view-about" class="view">
  <div id="about-content">Loading...</div>
</div>

<div class="status-bar" id="status-bar">Connecting...</div>

<script>
// ---- State ----
let state = null, prediction = null, budgetDetail = null, projectsData = null, aboutData = null, fleetData = null, fleetRemote = null, fleetBranches = null, analyticsData = null;
let logEntries = [], logOffset = 0, logTotal = 0;
let currentTab = localStorage.getItem('dash-tab') || 'status';
let refreshTimer = null;
let expandedRunLog = null;

// ---- Tab switching ----
function setTab(name) {
  currentTab = name;
  localStorage.setItem('dash-tab', name);
  document.querySelectorAll('.tabs button').forEach((b, i) => {
    const tabs = ['status','analytics','budget','projects','logs','config','fleet','about'];
    b.classList.toggle('active', tabs[i] === name);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');

  clearInterval(refreshTimer);
  if (name === 'status') { fetchStatus(); refreshTimer = setInterval(fetchStatus, 30000); }
  else if (name === 'analytics') { fetchAnalytics(); }
  else if (name === 'budget') { fetchBudgetDetail(); refreshTimer = setInterval(fetchBudgetDetail, 60000); }
  else if (name === 'projects') { fetchProjects(); }
  else if (name === 'logs') { if (logEntries.length === 0) resetLogs(); }
  else if (name === 'config') { fetchStatus(); }
  else if (name === 'fleet') { fetchFleet(); refreshTimer = setInterval(fetchFleet, 60000); }
  else if (name === 'about') { fetchAbout(); }
}

// ---- Fetchers ----
async function fetchStatus() {
  try {
    const [sr, pr] = await Promise.all([fetch('/api/state'), fetch('/api/predict')]);
    state = await sr.json();
    prediction = await pr.json();
    renderStatus();
    document.getElementById('status-bar').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) { document.getElementById('status-bar').textContent = 'Error: ' + e.message; }
}

async function fetchBudgetDetail() {
  try {
    budgetDetail = await (await fetch('/api/budget-detail')).json();
    renderBudget();
  } catch (e) { document.getElementById('budget-detail').textContent = 'Error: ' + e.message; }
}

async function fetchProjects() {
  try {
    projectsData = await (await fetch('/api/projects')).json();
    renderProjects();
  } catch (e) { document.getElementById('projects-list').textContent = 'Error: ' + e.message; }
}

async function fetchAbout() {
  if (aboutData) { renderAbout(); return; } // cache -- docs don't change at runtime
  try {
    aboutData = await (await fetch('/api/project-docs')).json();
    renderAbout();
  } catch (e) { document.getElementById('about-content').textContent = 'Error: ' + e.message; }
}

async function fetchFleet() {
  try {
    const [local, remote, branches] = await Promise.all([
      fetch('/api/fleet').then(r => r.json()),
      fetch('/api/fleet-remote').then(r => r.json()).catch(() => ({ machines: [], error: 'fetch failed' })),
      fetch('/api/auto-branches').then(r => r.json()).catch(() => []),
    ]);
    fleetData = local;
    fleetRemote = remote;
    fleetBranches = branches;
    renderFleet();
  } catch (e) { document.getElementById('fleet-content').textContent = 'Error: ' + e.message; }
}

async function resetLogs() {
  logOffset = 0; logEntries = [];
  await loadMoreLogs();
}

async function loadMoreLogs() {
  const outcome = document.getElementById('f-outcome').value;
  const project = document.getElementById('f-project').value;
  try {
    const r = await fetch('/api/logs?offset=' + logOffset + '&limit=20&outcome=' + outcome + '&project=' + project);
    const data = await r.json();
    logEntries = logEntries.concat(data.entries);
    logTotal = data.total;
    logOffset += data.entries.length;
    renderLogs(data.has_more);
  } catch (e) { document.getElementById('log-entries').textContent = 'Error: ' + e.message; }
}

// ---- Skip Reason Explainer ----
function explainSkipReason(reason, budget, activityInfo) {
  if (!reason) return null;
  switch (reason) {
    case 'user-active': {
      if (activityInfo?.idle_seconds != null) {
        const idleM = Math.floor(activityInfo.idle_seconds / 60);
        const idleS = activityInfo.idle_seconds % 60;
        const needM = Math.floor(activityInfo.idle_required_seconds / 60);
        const remainSec = activityInfo.idle_required_seconds - activityInfo.idle_seconds;
        const remM = Math.floor(remainSec / 60);
        const remS = remainSec % 60;
        return 'User active — idle ' + idleM + 'm ' + idleS + 's / need ' + needM + 'm. Can dispatch in ' + remM + 'm ' + remS + 's';
      }
      return 'User active — transcript mtime within idle threshold';
    }
    case 'weekly-reserve-floor-threatened': {
      const wk = budget?.weekly;
      if (wk) {
        const used = (100 - (wk.headroom_pct || 0)).toFixed(1);
        const floor = wk.effective_reserve_floor_pct ?? 20;
        const deficit = (floor - (wk.headroom_pct || 0)).toFixed(1);
        return 'Weekly reserve at ' + used + '% used — floor is ' + floor + '%, need ' + deficit + '% more headroom';
      }
      return 'Weekly reserve floor threatened';
    }
    case 'trailing30-headroom-below-trigger': {
      const t = budget?.trailing30;
      if (t) return '30-day headroom ' + (t.headroom_pct?.toFixed(1) || '?') + '% is below trigger threshold';
      return '30-day headroom below trigger';
    }
    case 'daily-quota-reached':
      return 'Daily quota reached — no more runs allowed today';
    case 'insufficient-history-span':
      return 'Not enough history — need 7+ days of transcript data';
    case 'estimator-no-snapshot':
      return 'No usage snapshot — run estimator first';
    case 'estimator-parse-error':
      return 'Estimator failed to parse transcripts';
    default:
      return reason;
  }
}

// ---- Activity Countdown Formatter ----
function renderActivityCountdown(activityInfo) {
  if (!activityInfo || activityInfo.idle_seconds == null) return '<span class="dim">No transcript data</span>';
  const idleM = Math.floor(activityInfo.idle_seconds / 60);
  const idleS = activityInfo.idle_seconds % 60;
  const needM = Math.floor(activityInfo.idle_required_seconds / 60);
  if (activityInfo.is_idle) {
    return '<span class="yes">Idle ' + idleM + 'm ' + idleS + 's — ready to dispatch</span>';
  }
  const remainSec = Math.max(0, activityInfo.idle_required_seconds - activityInfo.idle_seconds);
  const remM = Math.floor(remainSec / 60);
  const remS = remainSec % 60;
  return '<span class="warn-c">Idle ' + idleM + 'm ' + idleS + 's / need ' + needM + 'm — can dispatch in ' + remM + 'm ' + remS + 's</span>';
}

// ---- Render: Status ----
function renderStatus() {
  if (!state || state.error) return;

  // Health banner (shown only when dispatcher is "down", not "idle")
  const banner = document.getElementById('health-banner');
  const bannerSub = document.getElementById('health-banner-sub');
  if (state.health?.state === 'down') {
    banner.style.display = 'flex';
    bannerSub.textContent = state.health.reason || 'dispatcher not producing successful commits';
  } else {
    banner.style.display = 'none';
  }

  // Health beacon
  const beacon = document.getElementById('beacon');
  const bTitle = document.getElementById('beacon-title');
  const bSub = document.getElementById('beacon-sub');
  const recentErrors = (state.recent_logs || []).slice(0, 3).filter(l => l.outcome === 'error').length;
  const isPaused = state.paused || state.pause_file_exists;
  const healthDown = state.health?.state === 'down';
  const healthIdle = state.health?.state === 'idle';
  let level = 'ok';
  let title = 'Healthy';
  let sub = '';

  if (healthDown) { level = 'error'; title = 'Dispatcher down'; sub = state.health.reason; }
  else if (healthIdle) { level = 'warn'; title = 'Idle'; sub = state.health.reason; }
  else if (recentErrors >= 2) { level = 'error'; title = 'Errors detected'; sub = recentErrors + ' errors in last 3 runs'; }
  else if (isPaused) { level = 'warn'; title = 'Paused'; sub = 'Dispatcher is paused'; }
  else if (state.budget && !state.budget.dispatch_authorized) { level = 'warn'; title = 'Budget gate blocking'; sub = state.budget.skip_reason || 'over pace'; }
  else if (state.budget?.dispatch_authorized) { sub = 'Claude authorized, dispatching when idle'; }
  else { sub = 'Free models active, dispatching when idle'; }

  const runsInfo = 'Today: ' + state.today_runs + '/' + state.max_runs_per_day + ' runs';
  bSub.textContent = sub + '  |  ' + runsInfo;
  bTitle.textContent = title;
  beacon.className = 'beacon' + (level === 'warn' ? ' warn' : level === 'error' ? ' error' : '');

  // Prediction
  const pBody = document.getElementById('prediction-body');
  if (prediction?.prediction) {
    const p = prediction.prediction;
    pBody.innerHTML =
      '<div class="pred-row"><span class="pred-label">Project</span><span class="pred-value">' + esc(p.project) + '</span></div>' +
      '<div class="pred-row"><span class="pred-label">Task</span><span class="pred-value">' + esc(p.task) + '</span></div>' +
      '<div class="pred-row"><span class="pred-label">Model</span><span class="pred-value model">' + esc(p.model || p.delegate_to) + '</span> <span class="dim">(' + esc(p.taskClass) + ')</span></div>' +
      '<div class="pred-row"><span class="pred-label">Last run</span><span class="pred-value dim">' + (p.last_dispatched ? timeAgo(new Date(p.last_dispatched)) : 'never') + '</span></div>';
  } else {
    pBody.textContent = prediction?.reason || 'No prediction available';
  }

  // Engine buttons
  const active = state.engine_override || 'auto';
  ['auto','node','claude'].forEach(e => {
    document.getElementById('btn-' + e).classList.toggle('active', active === e);
    const cfg = document.getElementById('cfg-btn-' + e);
    if (cfg) cfg.classList.toggle('active', active === e);
  });
  const ne = document.getElementById('next-engine');
  ne.textContent = state.next_engine.toUpperCase();
  ne.style.color = state.next_engine === 'claude' ? 'var(--yellow)' : 'var(--green)';

  // Budget bars
  const b = state.budget;
  const barsDiv = document.getElementById('budget-bars');
  if (b?.trailing30) {
    const t = b.trailing30;
    const w = b.weekly || {};
    barsDiv.innerHTML = budgetBar('30d', t.actual_pct, t.expected_pct_at_pace) + budgetBar('7d', Math.min(w.actual_pct || 0, 500), 100);
  } else { barsDiv.innerHTML = '<span class="dim">No snapshot</span>'; }

  const authEl = document.getElementById('s-auth');
  authEl.textContent = b?.dispatch_authorized ? 'YES' : 'NO';
  authEl.className = 'value ' + (b?.dispatch_authorized ? 'yes' : 'no');
  // "Why blocked?" explainer
  const skipExplained = explainSkipReason(b?.skip_reason, b, state.activity_info);
  document.getElementById('s-reason').textContent = skipExplained || '--';

  // Activity countdown
  const actEl = document.getElementById('s-activity');
  if (actEl) actEl.innerHTML = renderActivityCountdown(state.activity_info);

  // Last run
  const lr = state.last_run;
  if (lr) {
    const sEl = document.getElementById('lr-status');
    sEl.textContent = lr.status || '--';
    sEl.className = 'value ' + statusColor(lr.status);
    const lrReason = lr.error || lr.reason || '--';
    document.getElementById('lr-reason').textContent = lr.status === 'skipped' ? (explainSkipReason(lr.error, state.budget, state.activity_info) || lrReason) : lrReason;
    document.getElementById('lr-dur').textContent = lr.duration_ms != null ? lr.duration_ms + 'ms' : '--';
    document.getElementById('lr-time').textContent = lr.timestamp ? new Date(lr.timestamp).toLocaleString() : '--';
  }

  // Pause button
  const pauseBtn = document.getElementById('btn-pause');
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('on', isPaused);
  const cfgPause = document.getElementById('cfg-btn-pause');
  if (cfgPause) { cfgPause.textContent = isPaused ? 'Resume' : 'Pause'; cfgPause.classList.toggle('on', isPaused); }
  const cfgDry = document.getElementById('cfg-btn-dry');
  if (cfgDry) { cfgDry.textContent = 'Dry Run: ' + (state.dry_run ? 'ON' : 'OFF'); cfgDry.classList.toggle('on', state.dry_run); }

  // Scheduled task health
  const st = state.scheduled_task;
  if (st) {
    const stState = document.getElementById('st-state');
    stState.textContent = st.state;
    stState.className = 'value ' + (st.state === 'Ready' ? 'yes' : st.state === 'Running' ? 'warn-c' : 'no');
    document.getElementById('st-next').textContent = st.next_run ? new Date(st.next_run).toLocaleString() : '--';
    document.getElementById('st-last').textContent = st.last_run ? timeAgo(new Date(st.last_run)) : 'never';
    const rEl = document.getElementById('st-result');
    const code = st.last_result;
    rEl.textContent = code === 0 ? 'Success (0)' : code != null ? 'Code ' + code : '--';
    rEl.className = 'value ' + (code === 0 ? 'yes' : code != null ? 'no' : 'dim');
  }

  // Recent logs
  const logDiv = document.getElementById('recent-logs');
  const logs = (state.recent_logs || []).slice(0, 8);
  logDiv.innerHTML = logs.length === 0 ? '<span class="dim">No logs yet</span>' :
    logs.map(l => logEntryHtml(l, false)).join('');

  // Config tab
  renderConfig();
}

function budgetBar(label, actual, expected) {
  const pct = Math.min(actual || 0, 100);
  const cls = actual > 100 ? 'over' : actual > 80 ? 'mid' : 'ok';
  const markerLeft = Math.min(expected || 0, 100);
  return '<div class="bar-row">' +
    '<span class="bar-label">' + label + '</span>' +
    '<div class="bar-track">' +
      '<div class="bar-fill ' + cls + '" style="width:' + pct + '%"></div>' +
      '<div class="bar-marker" style="left:' + markerLeft + '%"></div>' +
    '</div>' +
    '<span class="bar-value">' + (actual != null ? actual.toFixed(1) : '?') + '% / ' + (expected != null ? expected.toFixed(1) : '?') + '%</span>' +
  '</div>';
}

// ---- Render: Budget ----
function renderBudget() {
  const d = budgetDetail;
  if (!d || d.error) { document.getElementById('budget-detail').textContent = d?.error || 'Loading...'; return; }

  const s = d.snapshot;
  const t30 = s.trailing30 || {};
  const wk = s.weekly || {};

  let html = '<div class="card"><h2>Trailing 30-Day Period</h2>';
  html += '<div class="cfg-row"><span class="cfg-label">Period</span><span class="cfg-value">' + fmtDate(t30.period_start) + ' (day ' + (t30.days_elapsed?.toFixed(0) || '?') + ' of ' + (t30.days_in_period || '?') + ')</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Actual</span><span class="cfg-value">' + (t30.actual_pct?.toFixed(1) || '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Expected</span><span class="cfg-value">' + (t30.expected_pct_at_pace?.toFixed(1) || '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Headroom</span><span class="cfg-value ' + (t30.headroom_pct >= 0 ? 'yes' : 'no') + '">' + (t30.headroom_pct?.toFixed(1) || '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Reserve floor</span><span class="cfg-value">' + (d.monthly.reserve_floor_pct ?? '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Gate</span><span class="cfg-value ' + (t30.gate_passes ? 'yes' : 'no') + '">' + (t30.gate_passes ? 'PASSING' : 'BLOCKED') + '</span></div>';
  html += budgetBar('30d', t30.actual_pct, t30.expected_pct_at_pace);
  html += '</div>';

  html += '<div class="card"><h2>Weekly Rolling (' + (wk.rolling_days || 7) + ' days)</h2>';
  html += '<div class="cfg-row"><span class="cfg-label">Actual</span><span class="cfg-value">' + (wk.actual_pct?.toFixed(1) || '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Headroom</span><span class="cfg-value ' + (wk.headroom_pct >= 0 ? 'yes' : 'no') + '">' + (wk.headroom_pct?.toFixed(1) || '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Reserve floor</span><span class="cfg-value">' + (wk.effective_reserve_floor_pct ?? d.weekly_config.reserve_floor_pct ?? '?') + '%</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Gate</span><span class="cfg-value ' + (wk.gate_passes ? 'yes' : 'no') + '">' + (wk.gate_passes ? 'PASSING' : 'BLOCKED') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Urgency</span><span class="cfg-value">' + (wk.urgency_mode || 'normal') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Effective max/day</span><span class="cfg-value">' + (wk.effective_max_runs_per_day ?? '?') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Effective max%/run</span><span class="cfg-value">' + (wk.effective_max_pct_per_run ?? '?') + '</span></div>';
  html += '</div>';

  // Budget forecast
  const dailyBurn = wk.actual_pct > 0 && wk.rolling_days > 0 ? wk.actual_pct / wk.rolling_days : 0;
  const usableHeadroom = (wk.headroom_pct || 0) - (wk.effective_reserve_floor_pct || 20);
  html += '<div class="card"><h2>Forecast</h2>';
  if (dailyBurn <= 0) {
    html += '<div class="cfg-row"><span class="cfg-label">Projection</span><span class="cfg-value yes">No burn detected — floor not threatened</span></div>';
  } else if (usableHeadroom <= 0) {
    html += '<div class="cfg-row"><span class="cfg-label">Projection</span><span class="cfg-value no">Reserve floor already reached</span></div>';
  } else {
    const daysLeft = (usableHeadroom / dailyBurn).toFixed(1);
    const color = daysLeft > 7 ? 'yes' : daysLeft > 3 ? 'warn-c' : 'no';
    html += '<div class="cfg-row"><span class="cfg-label">Projection</span><span class="cfg-value ' + color + '">Reserve floor in ~' + daysLeft + ' days at current pace</span></div>';
  }
  html += '<div class="cfg-row"><span class="cfg-label">Daily burn rate</span><span class="cfg-value">' + dailyBurn.toFixed(2) + '%/day</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Usable headroom</span><span class="cfg-value">' + usableHeadroom.toFixed(1) + '% above floor</span></div>';
  html += '</div>';

  // 7-day sparkline
  const hist = d.daily_histogram || [];
  const maxVal = Math.max(1, ...hist.map(h => h.dispatches + h.errors));
  html += '<div class="card"><h2>7-Day Activity</h2>';
  html += '<div class="cfg-row"><span class="cfg-label">Today</span><span class="cfg-value">' + d.today_runs + ' / ' + d.max_runs_per_day + ' dispatches</span></div>';
  html += '<div class="sparkline">';
  hist.forEach((h, i) => {
    const total = h.dispatches + h.errors;
    const pct = (total / maxVal * 100).toFixed(0);
    const cls = i === hist.length - 1 ? 'today' : h.errors > h.dispatches ? 'err' : '';
    html += '<div class="bar ' + cls + '" style="height:' + Math.max(pct, 4) + '%" title="' + esc(h.date) + ': ' + h.dispatches + ' ok, ' + h.errors + ' err, ' + h.skips + ' skip"></div>';
  });
  html += '</div>';
  html += '<div class="spark-labels">' + hist.map(h => '<span>' + h.date.slice(5) + '</span>').join('') + '</div>';
  html += '</div>';

  // Bootstrap
  const bs = s.bootstrap || {};
  html += '<div class="card"><h2>Bootstrap Parameters</h2>';
  html += '<div class="cfg-row"><span class="cfg-label">Method</span><span class="cfg-value dim">' + esc(bs.method || '?') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">30d cost (WCU)</span><span class="cfg-value">' + (bs.trailing_30day_cost?.toLocaleString() || '?') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Cost per % point</span><span class="cfg-value">' + (bs.cost_per_pct_point?.toLocaleString() || '?') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Target burn/day</span><span class="cfg-value">' + (d.monthly.target_burn_pct_per_day ?? '?') + '%</span></div>';
  html += '</div>';

  document.getElementById('budget-detail').innerHTML = html;
}

// ---- Render: Projects ----
function renderProjects() {
  if (!projectsData || projectsData.error) { document.getElementById('projects-list').textContent = projectsData?.error || 'Loading...'; return; }

  const allTasks = ['test','typecheck','lint','audit','self-audit','explore','research','proposal','roadmap-review','tests-gen','add-tests','refactor','clean','docs-gen','jsdoc','session-log','coverage'];

  let html = '<div class="card"><h2>Project Roster</h2>';
  projectsData.projects.forEach((proj, idx) => {
    const tasks = proj.opportunistic_tasks || [];
    const lastH = proj.history.find(h => h.outcome !== 'skipped');
    const lastStr = lastH ? timeAgo(new Date(lastH.ts)) + ' (' + esc(lastH.task || lastH.outcome) + ')' : 'never';
    const flags = [proj.sandbox && 'sandbox', proj.canary && 'canary', proj.clinical_gate && 'clinical'].filter(Boolean).join(', ');

    html += '<div class="proj-header" onclick="toggleProject(' + idx + ')">';
    html += '<span class="arrow" id="arrow-' + idx + '">&#9654;</span>';
    html += '<span class="proj-slug">' + esc(proj.slug) + '</span>';
    html += '<span class="proj-last">' + lastStr + '</span>';
    html += '</div>';
    html += '<div class="proj-body" id="proj-' + idx + '">';
    html += '<div class="proj-meta">Path: ' + esc(proj.path) + '</div>';
    if (flags) html += '<div class="proj-meta">Flags: ' + esc(flags) + '</div>';

    html += '<div style="font-size:11px;color:var(--text-dim);margin-top:8px">Tasks:</div>';
    html += '<div class="proj-tasks" id="tasks-' + idx + '">';
    allTasks.forEach(t => {
      const checked = tasks.includes(t) ? ' checked' : '';
      html += '<label><input type="checkbox" value="' + esc(t) + '"' + checked + '>' + esc(t) + '</label>';
    });
    html += '</div>';

    html += '<div class="proj-btns">';
    html += '<button onclick="saveTasks(' + idx + ',\\'' + esc(proj.slug) + '\\')">Save tasks</button>';
    html += '<button onclick="reorderProject(\\'' + esc(proj.slug) + '\\',\\'up\\')">Move up</button>';
    html += '<button onclick="reorderProject(\\'' + esc(proj.slug) + '\\',\\'down\\')">Move down</button>';
    html += '</div>';

    if (proj.history.length > 0) {
      html += '<div style="font-size:11px;color:var(--text-dim);margin-top:10px">Recent history:</div>';
      proj.history.slice(0, 5).forEach(h => {
        const ts = h.ts ? new Date(h.ts).toLocaleDateString(undefined, {month:'short',day:'numeric'}) : '?';
        html += '<div class="log-entry"><span class="ts">' + ts + '</span><span class="outcome ' + esc(h.outcome) + '">' + esc(h.outcome) + '</span><span class="info">' + esc(h.task || h.reason || '') + '</span></div>';
      });
    }
    html += '</div>';
  });
  html += '</div>';

  // Routing table
  const r = projectsData.routing;
  html += '<div class="card"><h2>Model Routing</h2>';
  html += '<table class="route-table"><tr><th>Task Class</th><th>Primary Model</th></tr>';
  for (const [cls, model] of Object.entries(r.classes)) {
    html += '<tr><td>' + esc(cls) + '</td><td class="model">' + esc(model) + '</td></tr>';
  }
  html += '</table>';
  if (r.claude_only.length) html += '<div style="margin-top:8px;font-size:11px"><span class="dim">Claude-only:</span> ' + r.claude_only.map(esc).join(', ') + '</div>';
  if (r.forbidden_models.length) html += '<div style="font-size:11px"><span class="dim">Forbidden:</span> <span class="no">' + r.forbidden_models.map(esc).join(', ') + '</span></div>';
  if (r.fallback_chain.length) html += '<div style="font-size:11px"><span class="dim">Fallback chain:</span> ' + r.fallback_chain.map(esc).join(' > ') + '</div>';
  html += '</div>';

  document.getElementById('projects-list').innerHTML = html;
}

function toggleProject(idx) {
  const body = document.getElementById('proj-' + idx);
  const arrow = document.getElementById('arrow-' + idx);
  if (body) { body.classList.toggle('open'); arrow.classList.toggle('open'); }
}

async function saveTasks(idx, slug) {
  const container = document.getElementById('tasks-' + idx);
  const checks = container.querySelectorAll('input:checked');
  const tasks = Array.from(checks).map(c => c.value);
  if (!confirm('Update tasks for ' + slug + '? (' + tasks.length + ' selected)')) return;
  await fetch('/api/projects/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({slug, tasks}) });
  fetchProjects();
}

async function reorderProject(slug, direction) {
  await fetch('/api/projects/reorder', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({slug, direction}) });
  fetchProjects();
}

// ---- Render: Logs ----
function renderLogs(hasMore) {
  const div = document.getElementById('log-entries');
  div.innerHTML = logEntries.length === 0 ? '<span class="dim">No entries</span>' :
    logEntries.map((l, i) => logEntryHtml(l, true, i)).join('');
  document.getElementById('log-count').textContent = logEntries.length + ' / ' + logTotal + ' entries';
  document.getElementById('load-more-btn').style.display = hasMore ? '' : 'none';

  // Populate project filter
  const sel = document.getElementById('f-project');
  if (sel.options.length <= 1 && state?.projects) {
    state.projects.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
  }
}

function logEntryHtml(l, expandable, idx) {
  const ts = l.ts ? new Date(l.ts).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '?';
  const outcome = l.outcome || '?';
  const info = [l.project, l.task, l.reason, l.error].filter(Boolean).join(' / ');
  const hasLog = expandable && (l.log_file || l.run_id);
  const expandBtn = hasLog ? ' <button class="expand-btn" onclick="toggleRunLog(' + idx + ',this)">[+]</button>' : '';
  return '<div>' +
    '<div class="log-entry">' +
      '<span class="ts">' + esc(ts) + '</span>' +
      '<span class="outcome ' + esc(outcome) + '">' + esc(outcome) + '</span>' +
      '<span class="info">' + esc(info) + '</span>' +
      expandBtn +
    '</div>' +
    '<div id="runlog-' + idx + '"></div>' +
  '</div>';
}

async function toggleRunLog(idx, btn) {
  const container = document.getElementById('runlog-' + idx);
  if (container.innerHTML) { container.innerHTML = ''; btn.textContent = '[+]'; return; }

  const entry = logEntries[idx];
  let file = null;
  if (entry.log_file) file = entry.log_file.split(/[\\\\/]/).pop();
  if (!file && entry.run_id) {
    // Try to find by run_id pattern in the log_file field or construct it
    const tsStr = entry.ts ? new Date(entry.ts).toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\\d{8})(\\d{6})/, '$1-$2') : null;
    if (tsStr) file = tsStr + '-' + entry.run_id + '.log';
  }
  if (!file) { container.innerHTML = '<div class="run-log-detail">No log file available</div>'; btn.textContent = '[-]'; return; }

  try {
    const r = await fetch('/api/run-log?file=' + encodeURIComponent(file));
    const data = await r.json();
    container.innerHTML = '<div class="run-log-detail">' + esc(data.content || data.error || 'Empty') + '</div>';
  } catch (e) {
    container.innerHTML = '<div class="run-log-detail">Error: ' + esc(e.message) + '</div>';
  }
  btn.textContent = '[-]';
}

// ---- Render: Config ----
function renderConfig() {
  if (!state) return;
  const b = state.budget;
  let html = '<h2>Effective Configuration</h2>';
  html += '<div class="cfg-row"><span class="cfg-label">Activity gate idle</span><span class="cfg-value">' + (state.activity_gate?.idle_minutes_required ?? 20) + ' min</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">No fixed hours</span><span class="cfg-value">' + (state.activity_gate?.no_fixed_hours ? 'yes' : 'no') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Max runs/day</span><span class="cfg-value">' + state.max_runs_per_day + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Today runs</span><span class="cfg-value">' + state.today_runs + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Dry run</span><span class="cfg-value ' + (state.dry_run ? 'warn-c' : '') + '">' + (state.dry_run ? 'ON' : 'OFF') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Paused (config)</span><span class="cfg-value ' + (state.paused ? 'warn-c' : '') + '">' + (state.paused ? 'YES' : 'no') + '</span></div>';
  html += '<div class="cfg-row"><span class="cfg-label">Paused (file)</span><span class="cfg-value ' + (state.pause_file_exists ? 'warn-c' : '') + '">' + (state.pause_file_exists ? 'EXISTS' : 'no') + '</span></div>';
  if (b?.generated_at) html += '<div class="cfg-row"><span class="cfg-label">Snapshot age</span><span class="cfg-value">' + timeAgo(new Date(b.generated_at)) + '</span></div>';
  document.getElementById('cfg-params').innerHTML = html;
}

// ---- Render: Fleet ----
function renderFleet() {
  if (!fleetData || fleetData.error) {
    document.getElementById('fleet-content').textContent = fleetData?.error || 'Loading...';
    return;
  }

  let html = '';

  // ---- Machines card (from gist) ----
  html += renderMachinesCard();

  // ---- Auto branches card ----
  html += '<div class="card"><h2>Auto Branches</h2>';
  if (!fleetBranches || fleetBranches.length === 0) {
    html += '<div class="dim">No auto/* branches on any remote</div>';
  } else {
    fleetBranches.forEach(b => {
      const age = b.date ? timeAgo(new Date(b.date)) : '?';
      html += '<div class="log-entry">';
      html += '<span class="ts" style="width:80px;color:var(--cyan)">' + esc(b.project) + '</span>';
      html += '<span class="outcome" style="width:auto;color:var(--accent);font-weight:400">' + esc(b.branch) + '</span>';
      html += '<span class="info">' + esc(b.subject) + ' · ' + age + '</span>';
      html += '</div>';
    });
  }
  html += '</div>';

  html += '<div class="card">';
  html += '<h2>Fleet Progress</h2>';

  // Legend
  html += '<div class="fleet-legend">';
  html += '<div class="fleet-legend-item"><div class="fleet-legend-swatch complete"></div>Complete</div>';
  html += '<div class="fleet-legend-item"><div class="fleet-legend-swatch in-progress"></div>In Progress</div>';
  html += '<div class="fleet-legend-item"><div class="fleet-legend-swatch not-started"></div>Not Started</div>';
  html += '</div>';

  // Aggregate counters
  let totalComplete = 0, totalInProgress = 0, totalNotStarted = 0, totalNoRoadmap = 0;

  fleetData.projects.forEach((proj) => {
    html += '<div class="fleet-row">';

    // Label column
    html += '<div class="fleet-label">';
    html += '<div class="fleet-slug">' + esc(proj.slug);
    if (proj.sandbox) html += '<span class="tag">sandbox</span>';
    if (proj.canary) html += '<span class="tag">canary</span>';
    html += '</div>';
    const dispStr = proj.total_dispatches > 0
      ? proj.total_dispatches + ' dispatch' + (proj.total_dispatches !== 1 ? 'es' : '') + ', last ' + timeAgo(new Date(proj.last_dispatch))
      : 'never dispatched';
    html += '<div class="fleet-meta">' + esc(dispStr) + '</div>';
    if (proj.last_task) html += '<div class="fleet-meta">last: ' + esc(proj.last_task) + '</div>';
    html += '</div>';

    // Phase cells
    html += '<div class="fleet-phases">';
    if (!proj.phases || proj.phases.length === 0) {
      html += '<div class="fleet-cell no-roadmap">No roadmap</div>';
      totalNoRoadmap++;
    } else {
      proj.phases.forEach((ph) => {
        if (ph.status === 'complete') totalComplete++;
        else if (ph.status === 'in-progress') totalInProgress++;
        else totalNotStarted++;

        html += '<div class="fleet-cell ' + esc(ph.status) + '" title="' + esc(ph.name) + ' (' + ph.done + '/' + ph.total + ')">';
        html += '<div class="fleet-cell-name">' + esc(ph.name) + '</div>';
        html += '<div class="fleet-cell-count">' + ph.done + '/' + ph.total + '</div>';
        html += '</div>';
      });
    }
    html += '</div>';

    html += '</div>'; // fleet-row
  });

  // Summary footer
  const totalPhases = totalComplete + totalInProgress + totalNotStarted;
  html += '<div class="fleet-summary">';
  html += '<div><span class="val" style="color:var(--green)">' + totalComplete + '</span> complete</div>';
  html += '<div><span class="val" style="color:var(--yellow)">' + totalInProgress + '</span> in progress</div>';
  html += '<div><span class="val">' + totalNotStarted + '</span> not started</div>';
  html += '<div><span class="val">' + totalPhases + '</span> total phases</div>';
  if (totalNoRoadmap > 0) html += '<div><span class="val">' + totalNoRoadmap + '</span> no roadmap</div>';
  html += '</div>';

  html += '</div>'; // card

  document.getElementById('fleet-content').innerHTML = html;
}

// ---- Render: About ----
function renderAbout() {
  if (!aboutData || aboutData.error) { document.getElementById('about-content').textContent = aboutData?.error || 'Loading...'; return; }

  let html = '';
  aboutData.projects.forEach((proj, pi) => {
    const flags = [proj.sandbox && 'sandbox', proj.canary && 'canary', proj.clinical_gate && 'clinical'].filter(Boolean);
    html += '<div class="about-project">';
    html += '<h3>' + esc(proj.slug) + '</h3>';
    html += '<div class="about-sub">' + esc(proj.path) + (flags.length ? '  &middot;  ' + flags.join(', ') : '') + '</div>';

    const sections = [
      { key: 'claude_md', label: 'Charter (CLAUDE.md)', tag: 'charter' },
      { key: 'dispatch_md', label: 'Tasks (DISPATCH.md)', tag: 'tasks' },
      { key: 'state_md', label: 'Current State (ai/STATE.md)', tag: 'state' },
      { key: 'roadmap_md', label: 'Roadmap (ai/ROADMAP.md)', tag: 'roadmap' },
      { key: 'decisions_md', label: 'Decisions (ai/DECISIONS.md)', tag: 'state' },
    ];

    sections.forEach((sec, si) => {
      if (!proj.docs[sec.key]) return;
      const id = 'about-' + pi + '-' + si;
      html += '<div class="about-section">';
      html += '<div class="about-section-header" onclick="toggleAboutDoc(\\'' + id + '\\')">';
      html += '<span class="arrow" id="arrow-' + id + '">&#9654;</span>';
      html += '<span>' + esc(sec.label) + '</span>';
      html += '<span class="tag ' + sec.tag + '">' + sec.tag + '</span>';
      html += '</div>';
      html += '<div class="about-doc" id="' + id + '">' + renderMd(proj.docs[sec.key]) + '</div>';
      html += '</div>';
    });

    html += '</div>';
  });

  document.getElementById('about-content').innerHTML = html;
}

function toggleAboutDoc(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById('arrow-' + id);
  if (el) { el.classList.toggle('open'); }
  if (arrow) { arrow.classList.toggle('open'); }
}

function renderMd(raw) {
  // Lightweight markdown-to-HTML for display (no dependency)
  let text = esc(raw.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n'));

  // Headers
  text = text.replace(/^### (.+)$/gm, '<span class="md-h3">$1</span>');
  text = text.replace(/^## (.+)$/gm, '<span class="md-h2">$1</span>');
  text = text.replace(/^# (.+)$/gm, '<span class="md-h1">$1</span>');

  // Bold
  text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<span class="md-bold">$1</span>');

  // Checkboxes
  text = text.replace(/^- \\[x\\] (.+)$/gm, '<span class="md-done">  &#10003; $1</span>');
  text = text.replace(/^- \\[ \\] (.+)$/gm, '<span class="md-todo">  &#9744; $1</span>');

  // Tables (simple: detect lines starting with |)
  const lines = text.split('\\n');
  let inTable = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('|')) {
      // Skip separator rows (|---|---|)
      if (/^\\s*\\|[\\s-|]+\\|\\s*$/.test(line)) continue;
      const cells = line.split('|').filter(Boolean).map(c => c.trim());
      if (!inTable) { out.push('<table class="md-table">'); inTable = true; out.push('<tr>' + cells.map(c => '<th>' + c + '</th>').join('') + '</tr>'); }
      else { out.push('<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>'); }
    } else {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(line);
    }
  }
  if (inTable) out.push('</table>');

  return out.join('\\n');
}

// ---- Fetch & Render: Analytics ----
async function fetchAnalytics() {
  try {
    analyticsData = await (await fetch('/api/analytics')).json();
    renderAnalytics();
  } catch (e) { document.getElementById('analytics-content').textContent = 'Error: ' + e.message; }
}

function renderAnalytics() {
  const a = analyticsData;
  if (!a) { document.getElementById('analytics-content').textContent = 'Loading...'; return; }
  let html = '';

  // ---- Summary strip ----
  const totalNonSkip = a.total_entries - (a.outcomes.skipped || 0);
  html += '<div class="card"><h2>Summary</h2>';
  html += '<div style="display:flex;gap:24px;flex-wrap:wrap">';
  html += '<div><div class="ana-big">' + a.total_entries + '</div><div class="ana-label">total entries</div></div>';
  html += '<div><div class="ana-big" style="color:var(--green)">' + (a.outcomes.success || 0) + '</div><div class="ana-label">successes</div></div>';
  html += '<div><div class="ana-big" style="color:var(--red)">' + (a.outcomes.error || 0) + '</div><div class="ana-label">errors</div></div>';
  html += '<div><div class="ana-big" style="color:var(--text-dim)">' + (a.outcomes.skipped || 0) + '</div><div class="ana-label">skipped</div></div>';
  html += '<div><div class="ana-big" style="color:var(--yellow)">' + (a.outcomes['dry-run'] || 0) + '</div><div class="ana-label">dry runs</div></div>';
  html += '</div>';
  if (a.first_entry) html += '<div style="margin-top:8px;font-size:11px" class="dim">Tracking since ' + fmtDate(a.first_entry) + '</div>';
  html += '</div>';

  // ---- Skip Reason Breakdown (horizontal bars) ----
  const reasons = Object.entries(a.skip_reasons).sort((x, y) => y[1] - x[1]);
  const maxReason = reasons.length > 0 ? reasons[0][1] : 1;
  html += '<div class="card"><h2>Skip Reasons</h2>';
  if (reasons.length === 0) {
    html += '<div class="dim">No skips recorded</div>';
  } else {
    reasons.forEach(([reason, count]) => {
      const pct = (count / maxReason * 100).toFixed(0);
      const color = reason.includes('reserve') ? 'var(--yellow)' : reason.includes('active') ? 'var(--cyan)' : 'var(--text-dim)';
      html += '<div class="ana-bar-row">';
      html += '<span class="ana-bar-label">' + esc(reason) + '</span>';
      html += '<div class="ana-bar-track"><div class="ana-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      html += '<span class="ana-bar-count">' + count + '</span>';
      html += '</div>';
    });
  }
  html += '</div>';

  // ---- 14-Day Activity (stacked bars) ----
  html += '<div class="card"><h2>14-Day Activity</h2>';
  const maxDay = Math.max(1, ...a.daily.map(d => d.success + d.error + d.skipped + d['dry-run'] + d.other));
  html += '<div class="ana-stacked">';
  a.daily.forEach((d, i) => {
    const total = d.success + d.error + d.skipped + d['dry-run'] + d.other;
    const h = total > 0 ? (total / maxDay * 120) : 2;
    const segments = [];
    if (d.success > 0) segments.push({ h: d.success / total * h, color: 'var(--green)' });
    if (d.error > 0) segments.push({ h: d.error / total * h, color: 'var(--red)' });
    if (d['dry-run'] > 0) segments.push({ h: d['dry-run'] / total * h, color: 'var(--yellow)' });
    if (d.skipped > 0) segments.push({ h: d.skipped / total * h, color: 'var(--border)' });
    if (d.other > 0) segments.push({ h: d.other / total * h, color: 'var(--magenta)' });
    const isToday = i === a.daily.length - 1;
    const title = d.date + ': ' + d.success + ' ok, ' + d.error + ' err, ' + d.skipped + ' skip, ' + d['dry-run'] + ' dry';
    html += '<div class="ana-stack-col" title="' + esc(title) + '">';
    html += '<div class="ana-stack-bars" style="height:120px">';
    segments.forEach(seg => {
      html += '<div style="height:' + Math.max(seg.h, 1).toFixed(0) + 'px;background:' + seg.color + ';width:100%;border-radius:2px"></div>';
    });
    html += '</div>';
    html += '<div class="ana-stack-label' + (isToday ? ' today' : '') + '">' + d.date.slice(5) + '</div>';
    if (total > 0) html += '<div class="ana-stack-count">' + total + '</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div class="ana-legend">';
  html += '<span><span class="ana-dot" style="background:var(--green)"></span>success</span>';
  html += '<span><span class="ana-dot" style="background:var(--red)"></span>error</span>';
  html += '<span><span class="ana-dot" style="background:var(--yellow)"></span>dry-run</span>';
  html += '<span><span class="ana-dot" style="background:var(--border)"></span>skipped</span>';
  html += '</div>';
  html += '</div>';

  // ---- Hourly Heatmap ----
  html += '<div class="card"><h2>Activity by Hour (local time)</h2>';
  const maxHour = Math.max(1, ...a.hourly.map(h => h.dispatches + h.skips));
  html += '<div class="ana-heatmap">';
  a.hourly.forEach(h => {
    const total = h.dispatches + h.skips;
    const intensity = total / maxHour;
    const bg = total === 0 ? 'var(--surface2)' :
      h.dispatches > h.skips ? 'rgba(158,206,106,' + (0.15 + intensity * 0.7).toFixed(2) + ')' :
      'rgba(122,162,247,' + (0.15 + intensity * 0.7).toFixed(2) + ')';
    const label = String(h.hour).padStart(2, '0');
    html += '<div class="ana-heat-cell" style="background:' + bg + '" title="' + label + ':00 - ' + h.dispatches + ' dispatches, ' + h.skips + ' skips">';
    html += '<div class="ana-heat-hour">' + label + '</div>';
    html += '<div class="ana-heat-count">' + total + '</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div class="ana-legend" style="margin-top:6px">';
  html += '<span><span class="ana-dot" style="background:rgba(158,206,106,0.7)"></span>dispatches</span>';
  html += '<span><span class="ana-dot" style="background:rgba(122,162,247,0.7)"></span>mostly skips</span>';
  html += '</div>';
  html += '</div>';

  // ---- Per-Project Stats ----
  const projects = Object.entries(a.project_stats).sort((x, y) => y[1].total - x[1].total);
  if (projects.length > 0) {
    const maxProj = projects[0][1].total;
    html += '<div class="card"><h2>Projects</h2>';
    projects.forEach(([slug, stats]) => {
      const pct = (stats.total / maxProj * 100).toFixed(0);
      html += '<div class="ana-bar-row">';
      html += '<span class="ana-bar-label">' + esc(slug) + '</span>';
      html += '<div class="ana-bar-track">';
      // stacked: success green, error red, skip gray
      const sw = stats.total > 0 ? (stats.success / stats.total * parseFloat(pct)).toFixed(0) : 0;
      const ew = stats.total > 0 ? (stats.error / stats.total * parseFloat(pct)).toFixed(0) : 0;
      const skw = Math.max(0, parseFloat(pct) - parseFloat(sw) - parseFloat(ew));
      if (stats.success > 0) html += '<div class="ana-bar-fill" style="width:' + sw + '%;background:var(--green);display:inline-block"></div>';
      if (stats.error > 0) html += '<div class="ana-bar-fill" style="width:' + ew + '%;background:var(--red);display:inline-block"></div>';
      if (stats.skipped > 0) html += '<div class="ana-bar-fill" style="width:' + skw + '%;background:var(--border);display:inline-block"></div>';
      html += '</div>';
      html += '<span class="ana-bar-count">' + stats.success + '/' + stats.error + '/' + stats.skipped + '</span>';
      html += '</div>';
      // Show top tasks
      const topTasks = Object.entries(stats.tasks).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (topTasks.length > 0) {
        html += '<div class="ana-proj-tasks">';
        topTasks.forEach(([task, count]) => { html += '<span class="ana-task-tag">' + esc(task) + ' <b>' + count + '</b></span>'; });
        html += '</div>';
      }
    });
    html += '</div>';
  }

  // ---- Model Usage ----
  const models = Object.entries(a.model_stats).sort((x, y) => y[1].total - x[1].total);
  if (models.length > 0) {
    const maxModel = models[0][1].total;
    html += '<div class="card"><h2>Models Used</h2>';
    models.forEach(([model, stats]) => {
      const pct = (stats.total / maxModel * 100).toFixed(0);
      const successRate = stats.total > 0 ? (stats.success / stats.total * 100).toFixed(0) : 0;
      html += '<div class="ana-bar-row">';
      html += '<span class="ana-bar-label" style="color:var(--cyan)">' + esc(model) + '</span>';
      html += '<div class="ana-bar-track"><div class="ana-bar-fill" style="width:' + pct + '%;background:var(--cyan)"></div></div>';
      html += '<span class="ana-bar-count">' + stats.total + ' (' + successRate + '% ok)</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  document.getElementById('analytics-content').innerHTML = html;
}

// ---- Actions ----
async function setEngine(engine) {
  await fetch('/api/engine', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({engine}) });
  await fetchStatus();
}

async function togglePause() {
  const isPaused = state?.paused || state?.pause_file_exists;
  await fetch('/api/pause', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({paused: !isPaused}) });
  await fetchStatus();
}

async function toggleDryRun() {
  await fetch('/api/dry-run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({dry_run: !state?.dry_run}) });
  await fetchStatus();
}

async function dispatchNow(dryRun) {
  if (!dryRun && !confirm('Run a real dispatch now? This will create a worktree and call a model.')) return;
  const r = await fetch('/api/dispatch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({dry_run: dryRun}) });
  const result = await r.json();
  document.getElementById('status-bar').textContent = (dryRun ? 'Dry run' : 'Dispatch') + ' triggered (PID ' + (result.pid || '?') + ')';
  setTimeout(fetchStatus, 5000);
}

// ---- Render: Machines Card ----
function renderMachinesCard() {
  if (!fleetRemote || !fleetRemote.machines || fleetRemote.machines.length === 0) {
    if (fleetRemote?.error) {
      return '<div class="card"><h2>Machines</h2><div class="dim">' + esc(fleetRemote.error) + '</div></div>';
    }
    return '';
  }

  let html = '<div class="card"><h2>Machines</h2>';

  fleetRemote.machines.forEach((m) => {
    // Determine status: green < 1h, yellow < 4h, red > 4h
    const lastTs = m.last_run_ts ? new Date(m.last_run_ts) : null;
    const secAgo = lastTs ? Math.floor((Date.now() - lastTs.getTime()) / 1000) : Infinity;
    const statusClass = secAgo < 3600 ? '' : secAgo < 14400 ? 'warn' : 'error';

    html += '<div class="beacon ' + statusClass + '" style="margin-bottom:8px">';
    html += '<div class="beacon-dot"></div>';
    html += '<div class="beacon-text">';
    html += '<div class="beacon-title">' + esc(m.machine || 'unknown') + '</div>';

    // Last wrapper run
    const runInfo = [];
    if (lastTs) runInfo.push('checked in ' + timeAgo(lastTs));
    if (m.last_run_outcome) runInfo.push(m.last_run_outcome);
    if (m.last_engine) runInfo.push(m.last_engine);
    if (m.wrapper_duration_sec != null) runInfo.push(m.wrapper_duration_sec.toFixed(1) + 's');
    html += '<div class="beacon-sub">' + esc(runInfo.join(' · ')) + '</div>';

    // Last successful dispatch
    if (m.last_dispatch_ts) {
      const dispTs = new Date(m.last_dispatch_ts);
      const dispInfo = [];
      if (m.last_project) dispInfo.push(m.last_project);
      if (m.last_task) dispInfo.push(m.last_task);
      dispInfo.push(timeAgo(dispTs));
      html += '<div class="beacon-sub">last dispatch: ' + esc(dispInfo.join(' · ')) + '</div>';
    } else {
      html += '<div class="beacon-sub dim">no dispatches yet</div>';
    }

    html += '</div></div>';
  });

  // Gist health summary
  if (fleetRemote.health) {
    const h = fleetRemote.health;
    const hColor = h.state === 'healthy' ? 'var(--green)' : h.state === 'idle' ? 'var(--yellow)' : 'var(--red)';
    html += '<div class="metric"><span class="label">Gist health</span><span class="value" style="color:' + hColor + '">' + esc(h.state) + '</span></div>';
    if (h.reason && h.reason !== 'ok') html += '<div class="metric"><span class="label">Reason</span><span class="value dim">' + esc(h.reason) + '</span></div>';
  }

  if (fleetRemote.fetched_at) {
    html += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim)">gist data cached at ' + new Date(fleetRemote.fetched_at).toLocaleTimeString() + '</div>';
  }

  html += '</div>';
  return html;
}

// ---- Helpers ----
function esc(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

function fmtDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
}

function statusColor(s) {
  if (s === 'success' || s === 'wrapper-success') return 'yes';
  if (s === 'error') return 'no';
  return 'warn-c';
}

// ---- Init ----
setTab(currentTab);
</script>
</body>
</html>`;

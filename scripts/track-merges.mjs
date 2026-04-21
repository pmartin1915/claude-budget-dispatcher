#!/usr/bin/env node
// track-merges.mjs — Track fate of auto/* branches across rotation projects.
// Writes status/merge-tracker.json with per-branch status and aggregate merge
// rates by (project, taskClass). Zero npm deps beyond Node built-ins.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, materializeConfig } from "./lib/config.mjs";
import { TASK_TO_CLASS } from "./lib/router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "status", "merge-tracker.json");
const STALE_DAYS = 7;
const MAX_BRANCHES_PER_PROJECT = 50;

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse an auto-branch name into { task, taskClass, timestamp }.
 * Branch format: auto/{slug}-{task}-{YYYYMMDDHHMMSS}
 * Since slugs can contain hyphens, we match against a known slug prefix.
 * @param {string} branch - e.g. "origin/auto/burn-wizard-audit-20260420120000"
 * @param {string} slug - Known project slug
 * @returns {{ task: string, taskClass: string, timestamp: string }|null}
 */
export function parseBranchName(branch, slug) {
  // Strip "origin/" prefix if present
  const name = branch.replace(/^origin\//, "");
  const prefix = `auto/${slug}-`;
  if (!name.startsWith(prefix)) return null;

  const suffix = name.slice(prefix.length);
  // Last 14 chars are YYYYMMDDHHMMSS timestamp
  if (suffix.length < 15) return null; // at least 1 char task + dash + 14 timestamp
  const timestamp = suffix.slice(-14);
  if (!/^\d{14}$/.test(timestamp)) return null;

  // Everything between slug- and -timestamp is the task keyword
  const task = suffix.slice(0, suffix.length - 15); // -15 = dash + 14 digits
  if (!task) return null;

  const taskClass = TASK_TO_CLASS[task] ?? "unknown";
  return { task, taskClass, timestamp };
}

/**
 * Classify a branch based on PR data and age.
 * @param {{ state: string, mergedAt?: string }|null} prData - From gh pr list
 * @param {number} ageDays - Branch age in days
 * @param {number} [staleDays=7]
 * @returns {"merged"|"closed"|"open"|"no-pr"|"stale"}
 */
export function classifyBranch(prData, ageDays, staleDays = STALE_DAYS) {
  if (prData) {
    if (prData.state === "MERGED") return "merged";
    if (prData.state === "CLOSED") return "closed";
    if (prData.state === "OPEN") return "open";
  }
  return ageDays > staleDays ? "stale" : "no-pr";
}

/**
 * Compute aggregate merge rates from classified branches.
 * @param {Array<{ project: string, taskClass: string, status: string }>} branches
 * @returns {{ byProject: object, byTaskClass: object, byProjectAndClass: object }}
 */
export function computeAggregates(branches) {
  const byProject = {};
  const byTaskClass = {};
  const byProjectAndClass = {};

  for (const b of branches) {
    const buckets = [
      [byProject, b.project],
      [byTaskClass, b.taskClass],
      [byProjectAndClass, `${b.project}|${b.taskClass}`],
    ];
    for (const [map, key] of buckets) {
      if (!map[key]) map[key] = { total: 0, merged: 0, closed: 0, open: 0, stale: 0, noPr: 0 };
      map[key].total++;
      if (b.status === "merged") map[key].merged++;
      else if (b.status === "closed") map[key].closed++;
      else if (b.status === "open") map[key].open++;
      else if (b.status === "stale") map[key].stale++;
      else map[key].noPr++;
    }
  }

  // Compute rates
  for (const map of [byProject, byTaskClass, byProjectAndClass]) {
    for (const entry of Object.values(map)) {
      entry.rate = entry.total > 0 ? Math.round((entry.merged / entry.total) * 100) / 100 : 0;
    }
  }

  return { byProject, byTaskClass, byProjectAndClass };
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function checkGhCli() {
  try {
    execFileSync("gh", ["--version"], { timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function listAutoBranches(projectPath) {
  try {
    const raw = execFileSync(
      "git",
      ["branch", "-r", "--list", "origin/auto/*", "--sort=-committerdate",
       "--format=%(refname:short)|%(committerdate:iso-strict)"],
      { cwd: projectPath, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (!raw) return [];
    return raw.split("\n").slice(0, MAX_BRANCHES_PER_PROJECT).map((line) => {
      const [branch, date] = line.split("|");
      return { branch, date };
    });
  } catch {
    return [];
  }
}

function getPrStatus(branch, projectPath) {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--head", branch.replace(/^origin\//, ""), "--state", "all",
       "--json", "state,mergedAt", "--limit", "1"],
      { cwd: projectPath, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const prs = JSON.parse(raw);
    if (prs.length === 0) return null;
    return { state: prs[0].state, mergedAt: prs[0].mergedAt || null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function trackMerges() {
  materializeConfig();
  const config = loadConfig();
  if (!config) {
    console.error("[track-merges] no config found");
    process.exit(1);
  }

  const projects = config.projects_in_rotation ?? [];
  if (projects.length === 0) {
    console.error("[track-merges] no projects in rotation");
    process.exit(1);
  }

  const ghAvailable = checkGhCli();
  if (!ghAvailable) {
    console.warn("[track-merges] gh CLI not available — all branches will be classified as no-pr");
  }

  const allBranches = [];

  for (const project of projects) {
    if (!existsSync(project.path)) {
      console.warn(`[track-merges] skipping ${project.slug}: path not found (${project.path})`);
      continue;
    }

    // Fetch latest remote refs
    try {
      execFileSync("git", ["fetch", "origin", "--prune"], {
        cwd: project.path, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      console.warn(`[track-merges] fetch failed for ${project.slug}, using cached refs`);
    }

    const branches = listAutoBranches(project.path);
    console.log(`[track-merges] ${project.slug}: ${branches.length} auto/* branches`);

    for (const { branch, date } of branches) {
      const parsed = parseBranchName(branch, project.slug);
      if (!parsed) continue;

      const ageDays = (Date.now() - new Date(date).getTime()) / 86_400_000;
      const prData = ghAvailable ? getPrStatus(branch, project.path) : null;
      const status = classifyBranch(prData, ageDays);

      allBranches.push({
        branch,
        project: project.slug,
        task: parsed.task,
        taskClass: parsed.taskClass,
        date,
        status,
        prState: prData?.state ?? null,
        mergedAt: prData?.mergedAt ?? null,
      });
    }
  }

  const aggregates = computeAggregates(allBranches);

  const result = {
    lastRun: new Date().toISOString(),
    branchCount: allBranches.length,
    branches: allBranches,
    aggregates,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + "\n");
  console.log(`[track-merges] wrote ${OUTPUT_PATH} (${allBranches.length} branches)`);

  // Summary
  for (const [slug, data] of Object.entries(aggregates.byProject)) {
    console.log(`  ${slug}: ${data.merged}/${data.total} merged (${Math.round(data.rate * 100)}%)`);
  }
}

trackMerges().catch((err) => {
  console.error(`[track-merges] fatal: ${err.message}`);
  process.exit(1);
});

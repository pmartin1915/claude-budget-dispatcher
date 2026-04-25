#!/usr/bin/env node
// setup-labels.mjs — Idempotently create dispatcher labels on every GitHub
// repo referenced by config/budget.json projects_in_rotation.
//
// Usage:
//   node scripts/setup-labels.mjs              # all rotation repos
//   node scripts/setup-labels.mjs --dry-run    # list what would happen
//
// Reads each project's local git remote (remote.origin.url) to derive
// owner/repo. Skips projects whose paths don't exist, aren't git repos,
// or don't have a GitHub origin. `gh label create` is idempotent-friendly:
// existing labels return a "already exists" error we swallow.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "budget.json");

const DRY_RUN = process.argv.includes("--dry-run");

/** Canonical label set applied to every dispatcher-managed repo. */
const LABELS = [
  { name: "dispatcher:auto",          color: "0E8A16", desc: "Auto-created by budget-dispatcher" },
  { name: "task:explore",             color: "1D76DB", desc: "explore task class" },
  { name: "task:research",            color: "1D76DB", desc: "research task class" },
  { name: "task:audit",               color: "5319E7", desc: "audit task class" },
  { name: "task:tests_gen",           color: "0052CC", desc: "tests-gen task class" },
  { name: "task:refactor",            color: "C5DEF5", desc: "refactor task class" },
  { name: "task:docs_gen",            color: "BFD4F2", desc: "docs-gen task class" },
  { name: "task:slot_fill",           color: "006B75", desc: "slot_fill task class" },
  { name: "model:gemini-2.5-pro",     color: "FBCA04", desc: "Gemini 2.5 Pro" },
  { name: "model:gemini-2.5-flash",   color: "FEF2C0", desc: "Gemini 2.5 Flash" },
  { name: "model:mistral-large-latest", color: "D93F0B", desc: "Mistral Large" },
  { name: "model:codestral-latest",   color: "D93F0B", desc: "Codestral" },
  // Pillar 1 step 3 -- gate 5 (Overseer, read-only).
  { name: "overseer:approved",        color: "0E8A16", desc: "Overseer cross-family review approved" },
  { name: "overseer:rejected",        color: "B60205", desc: "Overseer cross-family review rejected" },
  { name: "overseer:abstain",         color: "FBCA04", desc: "Overseer abstained (low confidence, ambiguous family, or quota-exhausted)" },
  // Pillar 1 step 4 -- gate 6 (cooling-off + ready-flip + merge) sentinels.
  { name: "overseer:ready-flipped",   color: "1F8FFF", desc: "Bot flipped the PR ready after cooling-off; auto-merge is queued for the next tick" },
  { name: "overseer:merged",          color: "5319E7", desc: "Bot merged the PR; gate 7 owns the post-merge canary replay" },
];

function loadRotation() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("[setup-labels] config/budget.json not found");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return cfg.projects_in_rotation ?? [];
}

/** Extract owner/repo from a GitHub URL (HTTPS or SSH). Returns null if not GitHub. */
function parseGitHubSlug(url) {
  if (!url) return null;
  const https = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

function getRemoteSlug(projectPath) {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitHubSlug(url);
  } catch {
    return null;
  }
}

function createLabel(slug, label) {
  if (DRY_RUN) {
    console.log(`  [dry-run] gh label create ${label.name} --repo ${slug}`);
    return "would-create";
  }
  try {
    execFileSync(
      "gh",
      ["label", "create", label.name,
        "--repo", slug,
        "--color", label.color,
        "--description", label.desc],
      { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return "created";
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? "");
    if (msg.includes("already exists")) return "exists";
    return `error: ${msg.trim().split("\n")[0].slice(0, 120)}`;
  }
}

function main() {
  const rotation = loadRotation();
  if (rotation.length === 0) {
    console.error("[setup-labels] projects_in_rotation is empty");
    process.exit(1);
  }

  console.log(`[setup-labels] ${DRY_RUN ? "[DRY RUN] " : ""}processing ${rotation.length} rotation entries`);
  console.log("");

  const summary = { createdRepos: 0, skippedRepos: 0, created: 0, existed: 0, errors: 0 };
  const seenSlugs = new Set();

  for (const project of rotation) {
    const slug = project.slug ?? "(unnamed)";
    const path = project.path;

    if (!path || !existsSync(path)) {
      console.log(`  [skip] ${slug}: path missing (${path ?? "no path"})`);
      summary.skippedRepos += 1;
      continue;
    }
    const ghSlug = getRemoteSlug(path);
    if (!ghSlug) {
      console.log(`  [skip] ${slug}: no github remote at ${path}`);
      summary.skippedRepos += 1;
      continue;
    }
    if (seenSlugs.has(ghSlug)) {
      console.log(`  [skip] ${slug}: ${ghSlug} already processed this run`);
      continue;
    }
    seenSlugs.add(ghSlug);

    console.log(`=== ${slug}  ->  ${ghSlug} ===`);
    const counts = { created: 0, exists: 0, error: 0 };
    for (const label of LABELS) {
      const result = createLabel(ghSlug, label);
      if (result === "created" || result === "would-create") counts.created += 1;
      else if (result === "exists") counts.exists += 1;
      else {
        counts.error += 1;
        console.log(`  [err]  ${label.name}: ${result}`);
      }
    }
    console.log(`  created=${counts.created} existing=${counts.exists} errors=${counts.error}`);
    summary.createdRepos += 1;
    summary.created += counts.created;
    summary.existed += counts.exists;
    summary.errors += counts.error;
  }

  console.log("");
  console.log("=== summary ===");
  console.log(`  repos processed: ${summary.createdRepos}`);
  console.log(`  repos skipped:   ${summary.skippedRepos}`);
  console.log(`  labels created:  ${summary.created}${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(`  labels existed:  ${summary.existed}`);
  console.log(`  errors:          ${summary.errors}`);

  if (summary.errors > 0) process.exit(1);
}

main();

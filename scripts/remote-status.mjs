#!/usr/bin/env node
// remote-status.mjs — Laptop-side dispatch monitor.
// Fetches the status gist and renders a terminal-friendly summary.
// Zero deps beyond Node built-ins + gh CLI.
//
// Usage:  node scripts/remote-status.mjs [--watch [interval_sec]]
//         npm run remote-status
//         npm run remote-status -- --watch 60

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "budget.json");

function loadGistId() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("[remote-status] config/budget.json not found");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const id = cfg.status_gist_id;
  if (!id) {
    console.error("[remote-status] status_gist_id not set in budget.json");
    process.exit(2);
  }
  return id;
}

function fetchGist(gistId) {
  try {
    const raw = execFileSync("gh", ["api", `gists/${gistId}`], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[remote-status] failed to fetch gist: ${e.message}`);
    return null;
  }
}

function parseGistFiles(gist) {
  const result = {};
  for (const [name, file] of Object.entries(gist.files || {})) {
    try {
      result[name] = JSON.parse(file.content);
    } catch {
      result[name] = file.content;
    }
  }
  return result;
}

function relativeTime(isoStr) {
  if (!isoStr) return "never";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function statusIcon(state) {
  if (state === "healthy") return "[OK]";
  if (state === "idle") return "[--]";
  if (state === "down") return "[!!]";
  return "[??]";
}

function outcomeIcon(outcome) {
  if (outcome === "success" || outcome === "wrapper-success") return "[OK]";
  if (outcome === "skipped") return "[--]";
  if (outcome === "error") return "[!!]";
  return "[??]";
}

function renderStatus(files) {
  const health = files["health.json"] || {};
  const lastRun = files["budget-dispatch-last-run.json"] || {};
  const budgetStatus = files["budget-dispatch-status.json"] || {};

  // Collect fleet machines
  const machines = [];
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith("fleet-") && name.endsWith(".json")) {
      machines.push({ name: name.replace("fleet-", "").replace(".json", ""), ...data });
    }
  }

  const now = new Date().toISOString().slice(0, 19) + "Z";
  const sep = "=".repeat(58);
  const thin = "-".repeat(58);

  console.log("");
  console.log(sep);
  console.log("  DISPATCH MONITOR");
  console.log(`  ${now}  (fetched from GitHub gist)`);
  console.log(sep);

  // Overall health
  console.log("");
  console.log(`  Health:  ${statusIcon(health.state)}  ${(health.state || "unknown").toUpperCase()}`);
  if (health.reason) console.log(`           ${health.reason}`);
  if (health.last_success_ts) {
    console.log(`           Last success: ${relativeTime(health.last_success_ts)}`);
  }

  // Last run
  console.log("");
  console.log(thin);
  console.log("  LAST RUN");
  console.log(thin);
  console.log(`  Status:  ${lastRun.status || "?"}`);
  if (lastRun.error) console.log(`  Reason:  ${lastRun.error}`);
  console.log(`  Engine:  ${lastRun.engine || "?"}`);
  console.log(`  When:    ${relativeTime(lastRun.timestamp)}`);
  if (lastRun.duration_ms) console.log(`  Duration: ${(lastRun.duration_ms / 1000).toFixed(1)}s`);

  // Machines
  console.log("");
  console.log(thin);
  console.log("  MACHINES");
  console.log(thin);

  for (const m of machines) {
    console.log("");
    console.log(`  ${m.name}`);
    console.log(`    Last check-in:  ${relativeTime(m.computed_at)} ${outcomeIcon(m.last_run_outcome)}`);
    console.log(`    Engine:         ${m.last_engine || "?"}`);
    if (m.last_project) {
      console.log(`    Last dispatch:  ${m.last_project}/${m.last_task} ${outcomeIcon(m.last_dispatch_outcome)}`);
      console.log(`                    ${relativeTime(m.last_dispatch_ts)}`);
    } else {
      console.log(`    Last dispatch:  none`);
    }
    if (m.last_error_reason) {
      console.log(`    Last error:     ${m.last_error_reason} (${m.last_error_phase})`);
      console.log(`                    ${relativeTime(m.last_error_ts)}`);
    }
  }

  // Budget status (if available and not too stale)
  if (budgetStatus.state) {
    console.log("");
    console.log(thin);
    console.log("  BUDGET");
    console.log(thin);
    console.log(`  Gate:    ${budgetStatus.state}`);
    if (budgetStatus.reason) console.log(`  Reason:  ${budgetStatus.reason}`);
    console.log(`  Updated: ${relativeTime(budgetStatus.computed_at)}`);
  }

  console.log("");
  console.log(sep);
  console.log("");
}

// --- Main ---

const args = process.argv.slice(2);
const watchMode = args.includes("--watch");
const watchIndex = args.indexOf("--watch");
const intervalSec = watchMode && args[watchIndex + 1]
  ? Number(args[watchIndex + 1])
  : 120;

const gistId = loadGistId();

function run() {
  const gist = fetchGist(gistId);
  if (!gist) return;
  const files = parseGistFiles(gist);

  if (watchMode) {
    // Clear screen for watch mode
    process.stdout.write("\x1b[2J\x1b[H");
  }

  renderStatus(files);

  if (watchMode) {
    console.log(`  Refreshing every ${intervalSec}s. Ctrl+C to stop.`);
    console.log("");
  }
}

run();

if (watchMode) {
  setInterval(run, intervalSec * 1000);
}

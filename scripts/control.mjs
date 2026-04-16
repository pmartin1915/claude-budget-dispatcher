#!/usr/bin/env node
// Budget Dispatcher Control -- interactive CLI for engine switching & monitoring.
// Usage: node scripts/control.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const CONFIG_PATH = join(REPO_ROOT, "config", "budget.json");
const SNAPSHOT_PATH = join(REPO_ROOT, "status", "usage-estimate.json");
const LAST_RUN_PATH = join(REPO_ROOT, "status", "budget-dispatch-last-run.json");
const PAUSE_PATH = join(REPO_ROOT, "config", "PAUSED");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function showStatus() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config/budget.json not found"); return; }

  const snapshot = readJson(SNAPSHOT_PATH);
  const lastRun = readJson(LAST_RUN_PATH);

  const override = config.engine_override ?? null;
  const nextEngine = override && override !== "auto"
    ? override
    : snapshot?.dispatch_authorized ? "claude" : "node";

  const paused = config.paused || existsSync(PAUSE_PATH);
  const headroom = snapshot?.trailing30?.headroom_pct;

  console.log("\n  Budget Dispatcher Control");
  console.log("  " + "-".repeat(40));
  console.log(`  Engine:    ${override || "auto"} (next: ${nextEngine})`);
  console.log(`  Paused:    ${paused ? "YES" : "no"}`);
  console.log(`  Dry run:   ${config.dry_run ? "YES" : "no"}`);
  if (headroom != null) {
    console.log(`  Headroom:  ${headroom.toFixed(1)}%`);
    console.log(`  Authorized: ${snapshot.dispatch_authorized ? "YES" : "no"}`);
  }
  if (lastRun) {
    const ts = lastRun.timestamp ? new Date(lastRun.timestamp).toLocaleTimeString() : "?";
    console.log(`  Last run:  ${lastRun.status || "?"} (${lastRun.error || lastRun.reason || ""}) at ${ts}`);
  }
  console.log();
}

function setEngine(engine) {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }
  config.engine_override = engine === "auto" ? null : engine;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  Engine override set to: ${engine}`);
}

function togglePause() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }
  config.paused = !config.paused;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  Paused: ${config.paused}`);
}

function dispatchNow() {
  console.log("  Dispatching (--force --dry-run)...");
  const child = spawn("node", ["scripts/dispatch.mjs", "--force", "--dry-run"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("close", (code) => {
    console.log(`  Dispatch exited with code ${code}`);
    showMenu();
  });
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function showMenu() {
  showStatus();
  console.log("  1) Auto    2) Free only    3) Claude");
  console.log("  4) Pause/Resume    5) Dispatch now (dry-run)    q) Quit");
  console.log();
  rl.question("  > ", (answer) => {
    const choice = answer.trim().toLowerCase();
    switch (choice) {
      case "1": setEngine("auto"); showMenu(); break;
      case "2": setEngine("node"); showMenu(); break;
      case "3": setEngine("claude"); showMenu(); break;
      case "4": togglePause(); showMenu(); break;
      case "5": dispatchNow(); break; // showMenu called in callback
      case "q": case "quit": case "exit": rl.close(); process.exit(0);
      default: console.log("  Unknown option"); showMenu();
    }
  });
}

showMenu();

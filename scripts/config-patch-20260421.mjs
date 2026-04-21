#!/usr/bin/env node
// config-patch-20260421.mjs
//
// Patches local budget.json with correct weekly reset time and engine override.
// Run on each machine after git pull:
//   node scripts/config-patch-20260421.mjs
//
// Safe to run multiple times (idempotent).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "config", "budget.json");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
let changed = false;

// Fix 1: engine_override → "node" (always use free models)
if (config.engine_override !== "node") {
  console.log(`[patch] engine_override: ${JSON.stringify(config.engine_override)} → "node"`);
  config.engine_override = "node";
  changed = true;
} else {
  console.log("[patch] engine_override already 'node' ✓");
}

// Fix 2: weekly reset → Thursday 2pm CT (day 4, 19:00 UTC)
const ds = config.weekly?.deadline_scaling;
if (ds) {
  if (ds.resets_on_day_of_week !== 4) {
    console.log(`[patch] resets_on_day_of_week: ${ds.resets_on_day_of_week} → 4 (Thursday)`);
    ds.resets_on_day_of_week = 4;
    changed = true;
  } else {
    console.log("[patch] resets_on_day_of_week already 4 ✓");
  }

  if (ds.resets_at_hour_utc !== 19) {
    console.log(`[patch] resets_at_hour_utc: ${ds.resets_at_hour_utc} → 19 (2pm CT)`);
    ds.resets_at_hour_utc = 19;
    changed = true;
  } else {
    console.log("[patch] resets_at_hour_utc already 19 ✓");
  }
} else {
  console.log("[patch] WARN: no weekly.deadline_scaling block found — skipping reset time fix");
}

if (changed) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log("\n[patch] budget.json updated. Done.");
} else {
  console.log("\n[patch] No changes needed — config already correct.");
}

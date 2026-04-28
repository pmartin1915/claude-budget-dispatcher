#!/usr/bin/env node
// migrate-local-projects.mjs -- One-shot per-machine local.json cleaner.
// Removes projects_in_rotation from config/local.json so the canonical
// fleet-wide list in config/shared.json is what the dispatcher sees.
//
// Run on each coder machine after pulling the dispatcher commit that
// promoted projects_in_rotation to shared.json. Idempotent: no-op on
// machines whose local.json already lacks the key.
//
// If a machine has per-project overrides it actually needs to keep (e.g.
// different path on a non-standard layout), edit the printed diff into a
// fresh local.json projects_in_rotation array AFTER running this -- the
// mergeProjectsBySlug logic in config.mjs will deep-merge them by slug
// into shared.json's list.
//
// See docs/FLEET-OPS.md for the full migration story and rollout
// transition-window semantics.
//
// Usage:  node scripts/migrate-local-projects.mjs [--dry-run]
// Exit:   0 = success or already-migrated, non-zero = failure.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOCAL_PATH = join(REPO_ROOT, "config", "local.json");

const dryRun = process.argv.includes("--dry-run");

function tag(level, msg) {
  const prefix = level === "ok" ? "[migrate] OK" :
    level === "warn" ? "[migrate] WARN" :
    level === "err" ? "[migrate] ERROR" : "[migrate]";
  console.log(`${prefix}: ${msg}`);
}

if (!existsSync(LOCAL_PATH)) {
  tag("ok", "no local.json present; nothing to migrate.");
  process.exit(0);
}

let raw;
try {
  raw = readFileSync(LOCAL_PATH, "utf8");
} catch (e) {
  tag("err", `cannot read local.json: ${e.message}`);
  process.exit(2);
}

let local;
try {
  local = JSON.parse(raw);
} catch (e) {
  tag("err", `local.json is not valid JSON: ${e.message}`);
  process.exit(2);
}

if (!("projects_in_rotation" in local)) {
  tag("ok", "local.json already migrated (no projects_in_rotation key).");
  process.exit(0);
}

const removedCount = Array.isArray(local.projects_in_rotation)
  ? local.projects_in_rotation.length
  : 0;

if (dryRun) {
  tag("ok", `--dry-run: would remove projects_in_rotation (${removedCount} entries) from ${LOCAL_PATH}`);
  process.exit(0);
}

// Back up before mutating. Timestamped so multiple runs are safe.
const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
const backupPath = `${LOCAL_PATH}.bak-${ts}`;
try {
  copyFileSync(LOCAL_PATH, backupPath);
} catch (e) {
  tag("err", `failed to write backup ${backupPath}: ${e.message}`);
  process.exit(2);
}

delete local.projects_in_rotation;

const updated = JSON.stringify(local, null, 2) + "\n";

// Sanity: re-parse what we're about to write.
try {
  JSON.parse(updated);
} catch (e) {
  tag("err", `internal error: serialized local.json failed to re-parse: ${e.message}`);
  process.exit(3);
}

try {
  writeFileSync(LOCAL_PATH, updated, "utf8");
} catch (e) {
  tag("err", `failed to write local.json: ${e.message}`);
  process.exit(2);
}

tag("ok", `removed projects_in_rotation (${removedCount} entries). backup: ${backupPath}`);
tag("ok", "next dispatcher cron tick will use the fleet-wide list from shared.json.");

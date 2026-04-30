// config.mjs — Layered config loader.
// Merges config/shared.json (committed) + config/local.json (gitignored).
// Falls back to legacy config/budget.json if shared.json doesn't exist yet.
//
// P0-2 hardening (2026-04-30): local.json parse errors now throw
// ConfigDriftError instead of being silently swallowed. Callers must
// catch ConfigDriftError and decide whether to die() or degrade.
// New validateConfigCompleteness() checks post-merge config integrity.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thrown when local.json exists but cannot be parsed. Distinct from generic
 * Error so dispatch.mjs can pattern-match and fire a config-drift Gist
 * alert before dying.
 */
export class ConfigDriftError extends Error {
  /**
   * @param {string} message - Human-readable parse error
   * @param {string} configPath - Absolute path to the offending file
   */
  constructor(message, configPath) {
    super(message);
    this.name = "ConfigDriftError";
    this.configPath = configPath;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, "..", "..", "config");

const SHARED_PATH = join(CONFIG_DIR, "shared.json");
const LOCAL_PATH = join(CONFIG_DIR, "local.json");
const LEGACY_PATH = join(CONFIG_DIR, "budget.json");

/**
 * Merge two `projects_in_rotation`-style arrays by `slug`.
 * Override entries with matching slug are deep-merged into the base entry.
 * Override entries with a new slug are appended.
 * Override entries without a slug are skipped (with a warning) — schema
 * normally enforces slug presence; this is defense in depth.
 *
 * @param {Array<object>} base
 * @param {Array<object>} override
 * @returns {Array<object>}
 */
function mergeProjectsBySlug(base, override) {
  // structuredClone (Node 17+) for true deep isolation: callers can mutate
  // the returned merged config without aliasing back into the input arrays.
  const out = base.map((p) => structuredClone(p));
  for (const item of override) {
    if (!item || typeof item.slug !== "string") {
      console.warn(
        "[config] projects_in_rotation override entry missing slug; skipping",
      );
      continue;
    }
    const idx = out.findIndex((x) => x.slug === item.slug);
    if (idx >= 0) {
      // Deep-merge so partial overrides work (e.g. {slug, path} only changes path).
      deepMerge(out[idx], item);
    } else {
      out.push(structuredClone(item));
    }
  }
  return out;
}

/**
 * Deep merge b into a. Arrays from b replace (not concat) arrays in a, EXCEPT
 * the top-level `projects_in_rotation` key which is merged by `slug` so
 * machine-specific local overrides can mutate individual project entries
 * without clobbering the fleet-wide list shipped via shared.json.
 *
 * The by-slug merge is gated on `depth === 0` so that a future schema with a
 * nested key incidentally named `projects_in_rotation` (e.g. inside a
 * `presets` block) keeps the standard array-replace semantics rather than
 * silently inheriting per-slug merging.
 *
 * @param {object} a - base
 * @param {object} b - overrides
 * @param {number} [depth=0] - recursion depth (0 = top-level call)
 * @returns {object} merged (mutates a)
 */
function deepMerge(a, b, depth = 0) {
  for (const key of Object.keys(b)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      depth === 0 &&
      key === "projects_in_rotation" &&
      Array.isArray(a[key]) &&
      Array.isArray(b[key])
    ) {
      a[key] = mergeProjectsBySlug(a[key], b[key]);
    } else if (
      b[key] !== null &&
      typeof b[key] === "object" &&
      !Array.isArray(b[key]) &&
      a[key] !== null &&
      typeof a[key] === "object" &&
      !Array.isArray(a[key])
    ) {
      deepMerge(a[key], b[key], depth + 1);
    } else {
      a[key] = b[key];
    }
  }
  return a;
}

/**
 * Load merged config. Priority: local.json fields override shared.json fields.
 * Falls back to legacy budget.json if shared.json not found (migration path).
 * @returns {object|null}
 */
export function loadConfig() {
  // Legacy path: if shared.json doesn't exist, use budget.json directly
  if (!existsSync(SHARED_PATH)) {
    if (!existsSync(LEGACY_PATH)) return null;
    try {
      return JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
    } catch {
      return null;
    }
  }

  let shared;
  try {
    shared = JSON.parse(readFileSync(SHARED_PATH, "utf8"));
  } catch {
    return null;
  }

  // Apply local overrides if present.
  // P0-2 hardening: a malformed local.json is a configuration drift event.
  // We MUST NOT silently continue with shared-only config because the node
  // would lose its machine-specific routing (project paths, auto_push flags,
  // machine_name). Throw ConfigDriftError so the caller can die() + alert.
  if (existsSync(LOCAL_PATH)) {
    let localRaw;
    try {
      localRaw = readFileSync(LOCAL_PATH, "utf8");
    } catch (e) {
      throw new ConfigDriftError(
        `local.json unreadable: ${e.message}`,
        LOCAL_PATH,
      );
    }
    // Empty file is a specific drift vector: JSON.parse("") throws, but
    // an operator might truncate the file accidentally. Treat as drift.
    if (localRaw.trim().length === 0) {
      throw new ConfigDriftError(
        "local.json is empty (0 bytes after trim)",
        LOCAL_PATH,
      );
    }
    let local;
    try {
      local = JSON.parse(localRaw);
    } catch (e) {
      throw new ConfigDriftError(
        `local.json parse error: ${e.message}`,
        LOCAL_PATH,
      );
    }
    // An empty object {} is technically valid JSON but operationally
    // dangerous: the node inherits shared.json's project paths verbatim
    // (which are hard-coded to the primary machine's filesystem). Warn
    // but do not throw — an operator might intentionally use {} to test
    // with shared-only config.
    if (typeof local === "object" && local !== null && Object.keys(local).length === 0) {
      console.warn("[config] WARNING: local.json is an empty object {}; using shared.json values only");
    }
    deepMerge(shared, local);
  }

  return shared;
}

/**
 * Write back to the effective config file.
 * If layered mode (shared.json exists), writes to local.json.
 * Otherwise writes to legacy budget.json.
 * Only writes the fields that differ from shared.json.
 * @param {object} config - full merged config to persist mutations from
 * @param {string} key - top-level key that changed
 * @param {any} value - new value
 */
export function writeConfigField(key, value) {
  if (existsSync(SHARED_PATH)) {
    // Layered mode: read local, patch field, write back
    let local = {};
    if (existsSync(LOCAL_PATH)) {
      try { local = JSON.parse(readFileSync(LOCAL_PATH, "utf8")); } catch { local = {}; }
    }
    local[key] = value;
    writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2) + "\n", "utf8");
  } else {
    // Legacy mode: read budget.json, patch, write back
    if (!existsSync(LEGACY_PATH)) return;
    try {
      const config = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
      config[key] = value;
      writeFileSync(LEGACY_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    } catch { /* skip */ }
  }
}

/**
 * Returns the path where mutations should be written (for callers that
 * need to do complex multi-field writes).
 */
export function getMutableConfigPath() {
  return existsSync(SHARED_PATH) ? LOCAL_PATH : LEGACY_PATH;
}

/**
 * Returns the config directory path.
 */
export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Materialize merged config to budget.json so legacy code (dashboard, control)
 * continues to work with readJson(CONFIG_PATH). Call once at process startup.
 * No-op if shared.json doesn't exist (legacy mode).
 * @returns {object|null} merged config
 */
export function materializeConfig() {
  const config = loadConfig();
  if (!config) return null;

  // Only write if in layered mode (shared.json exists)
  if (existsSync(SHARED_PATH)) {
    writeFileSync(LEGACY_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  return config;
}

/**
 * Post-merge config completeness check. Pure function — only I/O is
 * existsSync on project paths. Call AFTER loadConfig() + AJV schema
 * validation to catch semantic issues the schema can't express.
 *
 * @param {object} config - Merged config from loadConfig()
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfigCompleteness(config) {
  const errors = [];

  // 1. status_gist_id must be non-empty (heartbeat, lock, watchdog all depend on it).
  if (!config?.status_gist_id || typeof config.status_gist_id !== "string" || config.status_gist_id.trim().length === 0) {
    errors.push("status_gist_id is missing or empty");
  }

  // 2. projects_in_rotation: every entry must have slug + path, and path must exist.
  const projects = config?.projects_in_rotation;
  if (!Array.isArray(projects) || projects.length === 0) {
    errors.push("projects_in_rotation is missing or empty");
  } else {
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      if (!p?.slug || typeof p.slug !== "string") {
        errors.push(`projects_in_rotation[${i}]: missing slug`);
        continue;
      }
      if (!p?.path || typeof p.path !== "string") {
        errors.push(`projects_in_rotation[${i}] (${p.slug}): missing path`);
      } else if (!existsSync(p.path)) {
        errors.push(`projects_in_rotation[${i}] (${p.slug}): path does not exist: ${p.path}`);
      }
    }
  }

  // 3. free_model_roster: at least one provider class must be configured.
  const roster = config?.free_model_roster;
  if (!roster || typeof roster !== "object") {
    errors.push("free_model_roster is missing");
  } else {
    const classes = roster.classes;
    if (!classes || typeof classes !== "object" || Object.keys(classes).length === 0) {
      errors.push("free_model_roster.classes is missing or empty");
    }
  }

  return { valid: errors.length === 0, errors };
}

export {
  SHARED_PATH,
  LOCAL_PATH,
  LEGACY_PATH,
  CONFIG_DIR,
  mergeProjectsBySlug,
  // Exported for test coverage of the depth-0 gate; not part of the
  // dispatcher's public config API.
  deepMerge as _deepMergeForTests,
};

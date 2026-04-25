// context.mjs — File reading, truncation, and project context helpers.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = resolve(__dirname, "..", "..", "status", "merge-tracker.json");
const MAX_STATE_CHARS = 2000;
const MAX_DISPATCH_CHARS = 3000;

// Tasks that require src/ files — gatherFilesForDocs and gatherFilesForCodegen
// both call gatherSrcFiles which returns [] when src/ is missing.
const NEEDS_SRC = new Set([
  "docs-gen", "tests-gen", "session-log", "jsdoc", "add-tests", "refactor", "clean",
]);

/**
 * Read a file with optional character truncation.
 * @param {string} filePath - Absolute path
 * @param {number} [maxChars] - Truncate after this many characters
 * @returns {string|null} File content or null if missing/unreadable
 */
export function readAndTruncate(filePath, maxChars) {
  try {
    const content = readFileSync(filePath, "utf8");
    if (maxChars && content.length > maxChars) {
      return content.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`;
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Extract the "Pre-Approved Tasks" section from DISPATCH.md content.
 * Falls back to truncated full content if the heading isn't found.
 * @param {string} dispatchContent
 * @returns {string}
 */
export function extractPreApprovedSection(dispatchContent) {
  const match = dispatchContent.match(
    /## Pre-Approved Tasks[\s\S]*?(?=\n## |$)/
  );
  return match ? match[0] : dispatchContent.slice(0, MAX_DISPATCH_CHARS);
}

/**
 * Build structured context for a single project for the selector prompt.
 * @param {object} project - Entry from projects_in_rotation
 * @param {string} logPath - Path to budget-dispatch-log.jsonl
 * @returns {object|null} Context object, or null if DISPATCH.md is missing
 */
export function buildProjectContext(project, logPath) {
  const dispatchPath = resolve(project.path, "DISPATCH.md");
  const dispatchContent = readAndTruncate(dispatchPath);
  if (!dispatchContent) return null; // No DISPATCH.md = no authorization

  const statePath = resolve(project.path, "ai", "STATE.md");
  const stateContent = readAndTruncate(statePath, MAX_STATE_CHARS);

  const lastDispatch = getLastDispatchTime(project.slug, logPath);
  const lastAttempt = getLastAttemptTime(project.slug, logPath);
  const recentOutcomes = getRecentOutcomes(project.slug, logPath);

  // Check if src/ exists — tasks like docs-gen, tests-gen, refactor, session-log
  // require source files and will always skip without them. Hard-filter them out
  // so the selector can't pick tasks that would inevitably fail.
  const srcDir = resolve(project.path, "src");
  const hasSrcFiles = existsSync(srcDir);
  const viableTasks = hasSrcFiles
    ? project.opportunistic_tasks
    : project.opportunistic_tasks.filter((t) => !NEEDS_SRC.has(t));

  return {
    slug: project.slug,
    clinical_gate: project.clinical_gate || false,
    opportunistic_tasks: viableTasks,
    has_source_files: hasSrcFiles,
    state_summary: stateContent ?? "(no state file)",
    approved_tasks: extractPreApprovedSection(dispatchContent),
    last_dispatched: lastDispatch ?? "never",
    last_attempted: lastAttempt ?? "never",
    recent_outcomes: recentOutcomes,
    merge_rate: getMergeRateContext(project.slug),
  };
}

/**
 * Scan the JSONL log for the most recent successful dispatch of a project.
 * @param {string} slug - Project slug
 * @param {string} logPath - Path to budget-dispatch-log.jsonl
 * @returns {string|null} ISO timestamp or null
 */
function getLastDispatchTime(slug, logPath) {
  if (!existsSync(logPath)) return null;

  let lines;
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }

  // Walk backwards to find most recent match
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.project === slug && obj.outcome === "success") {
        return obj.ts;
      }
    } catch {
      // skip corrupt line
    }
  }
  return null;
}

/**
 * Scan the JSONL log for the most recent dispatch of any outcome for a project.
 * Unlike getLastDispatchTime (success-only), this advances on skips/reverts too,
 * so the Rule 3 least-recently-attempted tiebreaker actually rotates (Part 19).
 * @param {string} slug - Project slug
 * @param {string} logPath - Path to budget-dispatch-log.jsonl
 * @returns {string|null} ISO timestamp or null
 */
function getLastAttemptTime(slug, logPath) {
  if (!existsSync(logPath)) return null;

  let lines;
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.project === slug && obj.ts) return obj.ts;
    } catch {
      // skip corrupt line
    }
  }
  return null;
}

/**
 * Get recent task outcomes for a project from the JSONL log (I-3).
 * Returns the last N dispatch results with project, task, outcome, and reason.
 * This gives the selector memory of what failed recently so it can avoid
 * repeatedly picking the same failing task.
 * @param {string} slug - Project slug
 * @param {string} logPath - Path to budget-dispatch-log.jsonl
 * @param {number} [maxResults=5] - Maximum results to return
 * @returns {string} Human-readable outcome summary for the selector prompt
 */
export function getRecentOutcomes(slug, logPath, maxResults = 5) {
  if (!existsSync(logPath)) return "(no dispatch history)";

  let lines;
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return "(log unreadable)";
  }

  const results = [];
  for (let i = lines.length - 1; i >= 0 && results.length < maxResults; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.project === slug && obj.task) {
        results.push({
          task: obj.task,
          outcome: obj.outcome,
          reason: obj.reason ?? "",
          ts: obj.ts,
        });
      }
    } catch {
      // skip corrupt line
    }
  }

  if (results.length === 0) return "(no task history)";

  return results
    .map((r) => `- ${r.task}: ${r.outcome}${r.reason ? ` (${r.reason})` : ""} @ ${r.ts}`)
    .join("\n");
}

/**
 * Get the last N dispatched (project, task) pairs from the JSONL log.
 * Used by the selector to structurally exclude recently-used task classes.
 * @param {string} logPath - Path to budget-dispatch-log.jsonl
 * @param {number} [maxResults=6] - How many recent dispatches to return
 * @returns {Array<{ project: string, task: string, ts: string }>}
 */
export function getRecentDispatches(logPath, maxResults = 6) {
  if (!existsSync(logPath)) return [];

  let lines;
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }

  const results = [];
  for (let i = lines.length - 1; i >= 0 && results.length < maxResults; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      // Only count entries that reached the worker (not gate skips)
      if (obj.project && obj.task && obj.phase === "complete") {
        results.push({
          project: obj.project,
          task: obj.task,
          ts: obj.ts,
          selector_fallback: obj.selector_fallback === true,
        });
      }
    } catch {
      // skip corrupt line
    }
  }
  return results;
}

/**
 * Read merge-tracker.json and format merge-rate context for a project.
 * Returns a human-readable summary for the selector prompt.
 * @param {string} slug - Project slug
 * @param {string} [trackerPath] - Override path for testing
 * @returns {string} Formatted merge-rate summary, or "(no merge data yet)"
 */
export function getMergeRateContext(slug, trackerPath) {
  const path = trackerPath ?? TRACKER_PATH;
  if (!existsSync(path)) return "(no merge data yet)";

  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "(merge data unreadable)";
  }

  const agg = data?.aggregates?.byProjectAndClass;
  if (!agg) return "(no merge data yet)";

  const lines = [];
  for (const [key, stats] of Object.entries(agg)) {
    if (!key.startsWith(`${slug}|`)) continue;
    const taskClass = key.split("|")[1];
    lines.push(`- ${taskClass}: ${stats.merged}/${stats.total} merged (${Math.round(stats.rate * 100)}%)`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no auto-branches tracked)";
}

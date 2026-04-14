// context.mjs — File reading, truncation, and project context helpers.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MAX_STATE_CHARS = 2000;
const MAX_DISPATCH_CHARS = 3000;

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

  return {
    slug: project.slug,
    clinical_gate: project.clinical_gate || false,
    opportunistic_tasks: project.opportunistic_tasks,
    state_summary: stateContent ?? "(no state file)",
    approved_tasks: extractPreApprovedSection(dispatchContent),
    last_dispatched: lastDispatch ?? "never",
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

// config-drift-alert.mjs — Push a structured config-drift error payload to
// the status gist so operators and the central dashboard see WHY a node
// refused to boot. Runs in the die() path — best-effort, never throws.
//
// P0-2 of the Architectural Audit and Hardening Roadmap (2026-04-30):
//   "If an auxiliary node fails pre-flight validation, the fail-soft mechanism
//    must be overridden. The node must ... immediately push a structural
//    failure payload to the central GitHub Gist monitor."
//
// Uses writeGistFile from gist.mjs — a single PATCH call. No retries:
// the node is about to die, so best-effort is the appropriate contract.

import { hostname } from "node:os";
import { writeGistFile } from "./gist.mjs";

/**
 * Push a config-drift-<hostname>.json file to the status gist.
 *
 * Payload shape:
 *   {
 *     schema_version: 1,
 *     machine: string,
 *     errors: string[],          // human-readable lines (one per violation)
 *     config_paths_checked: string[],
 *     ts: string,                // ISO-8601
 *     severity: "fatal",
 *   }
 *
 * @param {string} gistId - status_gist_id from config (may be empty if
 *   config itself is the thing that failed to load).
 * @param {string} token - GITHUB_TOKEN / GIST_AUTH_TOKEN.
 * @param {string[]} errors - list of validation error strings.
 * @param {string[]} [configPaths] - paths that were checked / failed.
 * @returns {Promise<void>} resolves on success or silent failure.
 */
export async function pushConfigDriftAlert(gistId, token, errors, configPaths = []) {
  if (!gistId || !token) return;

  const payload = {
    schema_version: 1,
    machine: hostname().toLowerCase(),
    errors: errors.slice(0, 50),  // cap at 50 to avoid gist size issues
    config_paths_checked: configPaths,
    ts: new Date().toISOString(),
    severity: "fatal",
  };

  const filename = `config-drift-${payload.machine}.json`;

  try {
    await writeGistFile(gistId, filename, payload, { token });
  } catch {
    // Best-effort. The node is about to die — don't add more noise.
  }
}

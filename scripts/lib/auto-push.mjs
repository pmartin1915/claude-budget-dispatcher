// auto-push.mjs -- Pillar 1 step 1: path-firewalled auto-push of auto/* branches
// to origin + draft PR creation.
//
// Background. The dispatcher already pushes today (dispatch.mjs Phase 5b/5c).
// Top-level config.auto_push: true + auto_pr: true would push and open a
// non-draft PR after every successful commit, with NO path firewall. Only
// reason no real push has fired is that every dispatch attempt has hit a
// gate-skip. This module hardens that already-armed pipeline before the
// first real push: gate 1 (path firewall) of the seven-gate stack from
// worldbuilder/VEYDRIA-VISION.md Pillar 3, plus draft-PR contract.
//
// Design contract:
//   - NEVER throws. All exceptions caught at the top-level wrapper in
//     maybeAutoPush(); a bug in the matcher returns a structured failed
//     outcome rather than crashing the worker.
//   - NEVER uses --force on git push. Concurrent fleet pushes to the same
//     branch get rejected as non-fast-forward; that's correct, non-destructive.
//   - Pure functions where possible (matchGlob, evaluatePathFirewall, normalize).
//   - I/O via injected gitClient/ghClient/fs/logger so tests are pure.
//   - Two-line JSONL per dispatch (existing summary + push outcome). Each
//     entry independently grepable for the future Overseer (Pillar 1).
//
// Glob grammar (POSIX separators only):
//   **      -> any characters, INCLUDING '/'
//   *       -> any characters EXCLUDING '/'
//   ?       -> single character, NOT '/'
//   literal -> regex metachars escaped
//   Anchored ^...$. Case-sensitive (security boundary; do not lowercase).

import { execFileSync } from "node:child_process";
import {
  writeFileSync as nodeWriteFileSync,
  unlinkSync as nodeUnlinkSync,
} from "node:fs";
import { resolve as nodeResolve } from "node:path";
import { tmpdir } from "node:os";

// Hardcoded fallback. A config typo deleting auto_push_protected_globs cannot
// disable these protections. Defense-in-depth: the in-config list is canonical
// and editable, but its absence/emptiness falls back to this list, NOT to
// "no protection". See worldbuilder/VEYDRIA-VISION.md Pillar 3 for the full
// permanent never-auto-push list (clinical, lore, framework, CI/CD, secrets).
export const FALLBACK_PROTECTED_GLOBS = Object.freeze([
  ".github/**",
  "package.json",
  "package-lock.json",
  "**/secrets/**",
  "**/credentials/**",
  "LICENSE*",
]);

// Replace backslashes with forward slashes. Case-preserving (security boundary
// -- do not lowercase: case-sensitive comparisons keep the firewall tight).
function normalize(p) {
  return String(p).replace(/\\/g, "/");
}

// Compile a glob pattern into an anchored RegExp.
// Tokenized left-to-right so '**' is recognized before '*'.
function compileGlob(pattern) {
  const norm = normalize(pattern);
  let regex = "^";
  let i = 0;
  while (i < norm.length) {
    const c = norm[i];
    if (c === "*" && norm[i + 1] === "*") {
      regex += ".*";
      i += 2;
    } else if (c === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (c === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Test a single path against a single glob pattern.
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchGlob(path, pattern) {
  return compileGlob(pattern).test(normalize(path));
}

/**
 * Pure firewall evaluator. No I/O.
 *
 * Decision order:
 *   1. If allowlist is empty AND there are changed files -> blocked, reason='empty-allowlist'.
 *      (Defensive default: prevents footgun where someone enables auto_push:true
 *      but forgets to populate the allowlist.)
 *   2. For each changed file: if any protectedGlobs match -> blocked, reason='protected-glob'.
 *      (Protected globs ALWAYS win over project allowlists.)
 *   3. For each changed file: if no allowlist pattern matches -> blocked, reason='outside-allowlist'.
 *   4. Otherwise allowed.
 *
 * @param {{ changedFiles: string[], allowlist: string[], protectedGlobs: string[] }} args
 * @returns {{ allowed: boolean, blockedBy: { reason: string, path?: string, pattern?: string } | null }}
 */
export function evaluatePathFirewall({ changedFiles, allowlist, protectedGlobs }) {
  const files = (changedFiles ?? [])
    .map((f) => normalize(f))
    .filter((f) => f.length > 0);
  const allow = allowlist ?? [];
  const protect = protectedGlobs ?? [];

  if (files.length === 0) {
    // No changed files = nothing to push. Caller should rarely hit this
    // (verify-commit returns outcome:'no-changes' without a branch in that
    // case), but if it does, the firewall is a no-op.
    return { allowed: true, blockedBy: null };
  }

  if (allow.length === 0) {
    return {
      allowed: false,
      blockedBy: { reason: "empty-allowlist", path: files[0] },
    };
  }

  // Protected globs win first.
  for (const file of files) {
    for (const pattern of protect) {
      if (matchGlob(file, pattern)) {
        return {
          allowed: false,
          blockedBy: { reason: "protected-glob", path: file, pattern },
        };
      }
    }
  }

  // Every file must match at least one allowlist pattern.
  for (const file of files) {
    let matched = false;
    for (const pattern of allow) {
      if (matchGlob(file, pattern)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return {
        allowed: false,
        blockedBy: { reason: "outside-allowlist", path: file },
      };
    }
  }

  return { allowed: true, blockedBy: null };
}

/**
 * Default execFileSync-backed clients. dispatch.mjs calls this once per dispatch
 * and threads the result into maybeAutoPush. Tests pass plain mock objects.
 *
 * @param {string} workingDir - cwd for git/gh subprocesses (worktree path).
 * @returns {{ gitClient: object, ghClient: object }}
 */
export function createDefaultClients(workingDir) {
  return {
    gitClient: {
      // Never --force. Non-fast-forward rejection is correct, non-destructive.
      push(branch) {
        execFileSync("git", ["push", "origin", branch], {
          cwd: workingDir,
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
      // Returns the changed paths from the most recent commit.
      // -z gives NUL-separated output (safely handles paths with newlines/quotes).
      listChangedFiles() {
        const out = execFileSync(
          "git",
          ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
          {
            cwd: workingDir,
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        return String(out).split("\0").filter((p) => p.length > 0);
      },
    },
    ghClient: {
      createDraftPr({ branch, title, bodyPath }) {
        const out = execFileSync(
          "gh",
          [
            "pr", "create",
            "--draft",
            "--head", branch,
            "--title", title,
            "--body-file", bodyPath,
          ],
          {
            cwd: workingDir,
            encoding: "utf8",
            timeout: 30_000,
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        return String(out).trim();
      },
      addLabels(prUrl, labels) {
        execFileSync("gh", ["pr", "edit", prUrl, "--add-label", labels], {
          cwd: workingDir,
          timeout: 15_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    },
  };
}

/**
 * Orchestrator. NEVER throws. Returns a structured outcome and writes a single
 * structured JSONL log line via injected logger.appendLog.
 *
 * @param {object} args
 * @param {string} args.branch                -- finalResult.branch (auto/<slug>-<task>-<date>)
 * @param {string} args.project               -- selection.project (slug)
 * @param {object} args.projectConfig         -- the matched projects_in_rotation entry
 * @param {object} args.globalConfig          -- the loaded budget.json
 * @param {object} args.finalResult           -- verify-commit result (used for PR title/body)
 * @param {object} args.selection             -- selector output (project, task, reason)
 * @param {object} args.route                 -- router output (taskClass, model, candidates)
 * @param {function} args.buildPrBody         -- (finalResult, selection, route) => markdown
 * @param {string} args.workingDir            -- worktree path (cwd for git/gh)
 * @param {object} args.gitClient             -- { push, listChangedFiles }
 * @param {object} args.ghClient              -- { createDraftPr, addLabels }
 * @param {boolean} [args.dryRun=false]       -- if true, evaluate firewall but skip git/gh
 * @param {object} [args.logger]              -- { appendLog }; missing = no-op logger
 * @param {object} [args.fs]                  -- { writeFileSync, unlinkSync }; default = node:fs
 * @returns {Promise<object>} structured outcome
 */
export async function maybeAutoPush({
  branch,
  project,
  projectConfig,
  globalConfig,
  finalResult,
  selection,
  route,
  buildPrBody,
  workingDir,
  gitClient,
  ghClient,
  dryRun = false,
  logger,
  fs,
}) {
  const fileSystem = fs ?? {
    writeFileSync: nodeWriteFileSync,
    unlinkSync: nodeUnlinkSync,
  };
  const baseEntry = {
    project,
    task: selection?.task,
    branch,
    phase: "auto-push",
    engine: "dispatch.mjs",
  };
  const writeLog = (entry) => {
    if (!logger?.appendLog) return;
    try {
      logger.appendLog({ ...baseEntry, ...entry });
    } catch {
      // Never let log failures crash maybeAutoPush.
    }
  };

  try {
    // 1. Global kill switch.
    if (!globalConfig?.auto_push) {
      const result = { outcome: "auto-push-blocked", reason: "disabled-global" };
      writeLog(result);
      return result;
    }

    // 2. Per-project flag.
    if (!projectConfig?.auto_push) {
      const result = { outcome: "auto-push-blocked", reason: "disabled-project" };
      writeLog(result);
      return result;
    }

    // 3. Discover changed files from the most recent commit.
    let changedFiles;
    try {
      changedFiles = gitClient.listChangedFiles();
    } catch (e) {
      const result = {
        outcome: "auto-push-failed",
        reason: "list-changed-files-failed",
        error: String(e?.message ?? e),
      };
      writeLog(result);
      return result;
    }

    // 4. Path firewall.
    const allowlist = projectConfig.auto_push_allowlist ?? [];
    const protectedGlobs =
      Array.isArray(globalConfig.auto_push_protected_globs) &&
      globalConfig.auto_push_protected_globs.length > 0
        ? globalConfig.auto_push_protected_globs
        : FALLBACK_PROTECTED_GLOBS;
    const decision = evaluatePathFirewall({
      changedFiles,
      allowlist,
      protectedGlobs,
    });

    if (!decision.allowed) {
      const result = {
        outcome: "auto-push-blocked",
        reason: decision.blockedBy.reason,
      };
      if (decision.blockedBy.path) result.blocked_path = decision.blockedBy.path;
      if (decision.blockedBy.pattern) result.matched_pattern = decision.blockedBy.pattern;
      writeLog(result);
      return result;
    }

    // 5. Dry-run short-circuit (after firewall, before any git/gh side effects).
    if (dryRun) {
      const result = {
        outcome: "auto-push-dry-run",
        changed_file_count: changedFiles.length,
      };
      writeLog(result);
      return result;
    }

    // 6. Push.
    try {
      gitClient.push(branch);
    } catch (e) {
      const result = {
        outcome: "auto-push-failed",
        reason: "git-push-failed",
        error: String(e?.message ?? e),
      };
      writeLog(result);
      return result;
    }

    // 7. Build PR body, write to temp file, open as draft.
    // Sanitize newlines from the summary so the title stays single-line; embedded
    // \n in CLI args can break gh's invocation and produce malformed PR titles.
    const summaryForTitle = (finalResult?.summary ?? "auto dispatch")
      .replace(/\r?\n/g, " ")
      .slice(0, 70);
    const title = `[dispatcher] ${selection?.task ?? "auto"}: ${summaryForTitle}`;
    const bodyPath = nodeResolve(tmpdir(), `dispatcher-pr-body-${Date.now()}.md`);
    let prUrl = null;
    let prError = null;
    try {
      fileSystem.writeFileSync(bodyPath, buildPrBody(finalResult, selection, route));
      prUrl = ghClient.createDraftPr({ branch, title, bodyPath });
    } catch (e) {
      prError = String(e?.message ?? e);
    } finally {
      try { fileSystem.unlinkSync(bodyPath); } catch { /* best-effort */ }
    }

    if (prError) {
      const result = {
        outcome: "auto-push-failed",
        reason: "pr-create-failed",
        error: prError,
        pushed: true,
      };
      writeLog(result);
      return result;
    }

    // 8. Best-effort label add. Never affects outcome (PR is the real artifact).
    if (prUrl) {
      try {
        const labels = [
          "dispatcher:auto",
          `task:${route?.taskClass ?? "unknown"}`,
          `model:${finalResult?.modelUsed ?? route?.model ?? "unknown"}`,
        ].join(",");
        ghClient.addLabels(prUrl, labels);
      } catch {
        // Label failure is non-fatal -- PR is open, that's the win.
      }
    }

    const result = { outcome: "auto-push-success", pr_url: prUrl };
    writeLog(result);
    return result;
  } catch (e) {
    // Top-level safety net: any unexpected throw must not crash the dispatcher.
    const result = {
      outcome: "auto-push-failed",
      reason: "internal-error",
      error: String(e?.message ?? e),
    };
    writeLog(result);
    return result;
  }
}

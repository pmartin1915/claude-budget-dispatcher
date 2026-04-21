// verify-commit.mjs — Phase 5: Worktree creation, test verification,
// clinical gate, commit, and origin URL restoration.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { extractJson } from "./extract-json.mjs";
import { throttleFor, withTimeout, API_TIMEOUT_MS } from "./throttle.mjs";
import { runWithTreeKill, getSafeTestEnv } from "./worker.mjs";
import { validateAuditResponse } from "./schemas.mjs";
import { scanFiles } from "./scan.mjs";

// Sentinel pushurl used while H1 ceremony is active. Any `git push` while this
// is set fails with a clear "unable to access 'no_push'" transport error.
const H1_BLOCK_PUSHURL = "no_push";

/**
 * Create a git worktree for isolated work on an auto-branch.
 *
 * Implements H1 ceremony: overrides `remote.origin.pushurl` to a sentinel so
 * `git push` fails, while leaving the fetch URL intact (C-3). Safer than the
 * previous `git remote remove origin` approach because a crash between setup
 * and restore leaves fetch linkage usable and the config is recoverable with
 * a single `git config --unset remote.origin.pushurl`.
 *
 * Note: worktrees share .git/config with the main clone, so this ceremony
 * temporarily blocks pushes from ALL worktrees. The dispatcher holds a PID
 * mutex so concurrent runs shouldn't overlap. Manual pushes from the main
 * clone during a dispatch window will also be blocked — acceptable because
 * dispatches are short and the activity gate only opens when user is idle.
 *
 * @param {string} projectPath - Absolute path to the project repo
 * @param {string} slug - Project slug
 * @param {string} task - Task keyword
 * @returns {{ path: string, branch: string, originalPushUrl: string|null }}
 *   originalPushUrl is the prior value of remote.origin.pushurl, or null if
 *   it was unset (in which case git push defaults to remote.origin.url).
 */
export function createWorktree(projectPath, slug, task) {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14); // YYYYMMDDHHMMSS
  const branchName = `auto/${slug}-${task}-${ts}`;
  const worktreePath = resolve(projectPath, "..", `auto-${slug}-${task}-${ts}`);

  execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName], {
    cwd: projectPath,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // H1 ceremony: set remote.origin.pushurl to sentinel so push fails but fetch works.
  let originalPushUrl = null;
  try {
    try {
      originalPushUrl = execFileSync(
        "git",
        ["config", "--get", "remote.origin.pushurl"],
        {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      ).trim();
    } catch {
      // pushurl unset — that's the common case; push defaults to url
      originalPushUrl = null;
    }
    execFileSync(
      "git",
      ["remote", "set-url", "--push", "origin", H1_BLOCK_PUSHURL],
      {
        cwd: worktreePath,
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch {
    // No origin at all — nothing to block
  }

  return { path: worktreePath, branch: branchName, originalPushUrl };
}

/**
 * Restore remote.origin.pushurl to its prior value (H1 ceremony cleanup).
 * @param {string} worktreePath
 * @param {string|null} originalPushUrl - Value captured by createWorktree.
 *   If null, unsets pushurl so git push falls back to remote.origin.url.
 */
export function restoreOrigin(worktreePath, originalPushUrl) {
  try {
    if (originalPushUrl) {
      execFileSync(
        "git",
        ["remote", "set-url", "--push", "origin", originalPushUrl],
        {
          cwd: worktreePath,
          timeout: 5_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } else {
      // No pushurl was set before — unset to revert to default (push uses url).
      execFileSync(
        "git",
        ["config", "--unset", "remote.origin.pushurl"],
        {
          cwd: worktreePath,
          timeout: 5_000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    }
  } catch {
    // Best effort — already restored, or no origin at all
  }
}

/**
 * Run final verification, clinical gate, and commit on the worktree.
 * @param {object} workResult - Result from worker.mjs executeWork()
 * @param {object} selection - { project, task, projectConfig }
 * @param {object} route - { delegate_to, model, taskClass }
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object }} clients - SDK instances
 * @returns {Promise<object>} Final outcome for logging
 */
export async function verifyAndCommit(workResult, selection, route, config, clients) {
  // Non-success results pass through (skipped, reverted, error)
  if (workResult.outcome !== "success") return workResult;

  // Local tasks (test/typecheck/lint) don't produce commits
  if (route.delegate_to === "local") return workResult;

  const worktreePath = workResult.worktree?.path;
  if (!worktreePath) return workResult;

  // Defense-in-depth: re-run tests in the worktree (if project has a test script).
  //
  // Skip-the-test optimization: if every changed file is documentation-only
  // (*.md, *.mdx, *.txt, *.rst), tests would run against unchanged code and
  // add no verification value. This fix resolves the "node_modules gitignored
  // -> jest not found in worktree -> every audit reverts" failure mode that
  // burned 18+ hours of combo dispatches.
  //
  // The docs-only blocklist is conservative -- any non-docs change (config,
  // code, lockfile, yaml, etc.) still triggers tests. getChangedFiles reads
  // from git, which is authoritative for what's actually in the worktree.
  const pkgPath = resolve(worktreePath, "package.json");
  const hasTests = existsSync(pkgPath) && (() => {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return !!pkg.scripts?.test;
    } catch { return false; }
  })();

  const DOCS_ONLY_RE = /\.(md|mdx|txt|rst)$/i;
  const changed = getChangedFiles(worktreePath);
  // Skip tests when: (a) no files changed (no-op; later check short-circuits anyway),
  // or (b) every changed file is documentation.
  const skipTest =
    changed.length === 0 || changed.every((f) => DOCS_ONLY_RE.test(f));

  if (hasTests && !skipTest) {
    const testResult = await runWithTreeKill("npm", ["test"], {
      cwd: worktreePath,
      env: getSafeTestEnv(),
      timeoutMs: 120_000,
    });
    if (!testResult.pass) {
      // Log stderr tail to per-run log (local, not synced to gist) for diagnosis.
      // Do NOT add stderr to the JSON return -- it flows to budget-dispatch-log.jsonl
      // which could be synced remotely, and test output may contain secrets.
      const tail = (testResult.stderr || "").slice(-1000);
      if (tail) console.error(`[verify] npm test failed. stderr tail:\n${tail}`);
      revertAndReport(worktreePath);
      return {
        ...workResult,
        outcome: "reverted",
        reason: testResult.stderr?.includes("[R-2]")
          ? "final-test-timeout-tree-killed"
          : "final-test-failure",
      };
    }
  } else if (hasTests) {
    const reason = changed.length === 0 ? "no changes" : `docs-only (${changed.length} files)`;
    console.log(`[verify] skipping npm test: ${reason}`);
  }

  // Clinical gate: independent audit of domain/ changes
  const project = selection.projectConfig;
  if (project.clinical_gate) {
    const changed = getChangedFiles(worktreePath);
    const domainFiles = changed.filter(
      (f) => f.includes("domain/") || f.includes("domain\\")
    );
    if (domainFiles.length > 0) {
      const auditResult = await clinicalAudit(
        clients.gemini,
        domainFiles,
        worktreePath
      );
      if (auditResult.hasCritical) {
        revertAndReport(worktreePath);
        return {
          ...workResult,
          outcome: "clinical-gate-revert",
          reason: auditResult.summary,
        };
      }
    }
  }

  // S-7: Deterministic security scan before commit
  const changedFiles = getChangedFiles(worktreePath);
  if (changedFiles.length > 0) {
    const scanResult = scanFiles(changedFiles, worktreePath);
    if (scanResult.critical.length > 0) {
      console.error(`[scan] CRITICAL findings — reverting: ${JSON.stringify(scanResult.critical)}`);
      revertAndReport(worktreePath);
      return {
        ...workResult,
        outcome: "scan-revert",
        reason: `security-scan-critical: ${scanResult.critical.map((f) => f.rule).join(", ")}`,
      };
    }
    if (scanResult.high.length > 0) {
      console.warn(`[scan] HIGH findings (non-blocking): ${JSON.stringify(scanResult.high)}`);
      // HIGH findings are logged but don't block — the LLM audit already reviewed
    }
  }

  // Build commit message
  const modelTag = route.model ? `[${route.model}]` : "";
  const summary = workResult.summary ?? "automated work";
  const msg = `[opportunistic][dispatch.mjs]${modelTag} ${selection.task}: ${summary}`;
  if (changedFiles.length === 0) {
    return { ...workResult, outcome: "no-changes", reason: "nothing-to-commit" };
  }
  execFileSync("git", ["add", "--", ...changedFiles], {
    cwd: worktreePath,
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Check if there's actually anything to commit
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: worktreePath,
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Exit 0 means no staged changes
    return { ...workResult, outcome: "no-changes", reason: "nothing-to-commit" };
  } catch {
    // Exit 1 means there ARE staged changes — proceed to commit
  }

  execFileSync("git", ["commit", "-m", msg], {
    cwd: worktreePath,
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const hash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

  const diffStat = parseDiffStat(worktreePath);

  return {
    outcome: "success",
    project: selection.project,
    task: selection.task,
    branch: workResult.worktree.branch,
    commit_hash: hash,
    files_changed: diffStat.files_changed,
    lines_added: diffStat.lines_added,
    lines_removed: diffStat.lines_removed,
    delegate_to: route.model ?? "local",
    summary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `git diff --numstat HEAD~1` and parse the machine-readable output.
 * Returns { files_changed, lines_added, lines_removed }.
 * Binary files count toward files_changed but not lines.
 * Returns zeros on any error (defense-in-depth).
 */
function parseDiffStat(worktreePath) {
  const empty = { files_changed: 0, lines_added: 0, lines_removed: 0 };
  try {
    const raw = execFileSync("git", ["diff", "--numstat", "HEAD~1"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!raw) return empty;
    let files = 0, added = 0, removed = 0;
    for (const line of raw.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      files++;
      // Binary files show "-\t-\tpath" — count file but not lines
      if (parts[0] !== "-") added += parseInt(parts[0], 10) || 0;
      if (parts[1] !== "-") removed += parseInt(parts[1], 10) || 0;
    }
    return { files_changed: files, lines_added: added, lines_removed: removed };
  } catch {
    return empty;
  }
}

function getChangedFiles(worktreePath) {
  try {
    const tracked = execFileSync("git", ["diff", "--name-only"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
    const all = [tracked, untracked].filter(Boolean).join("\n");
    return all ? all.split("\n") : [];
  } catch {
    return [];
  }
}

function revertAndReport(worktreePath) {
  try {
    execFileSync("git", ["checkout", "--", "."], {
      cwd: worktreePath,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["clean", "-fd"], {
      cwd: worktreePath,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Best effort
  }
}

async function clinicalAudit(gemini, domainFiles, worktreePath) {
  // C-2: audit ALL changed domain/ files, not just the first 3. Previously a
  // malicious changeset could bypass the gate by putting risky code in file #4+.
  // Per-file budget (30K chars) still applies; Gemini 2.5 Pro 1M context can
  // easily absorb 20+ files at that size.
  const fileContents = domainFiles
    .map((relPath) => {
      try {
        const content = readFileSync(resolve(worktreePath, relPath), "utf8");
        return `### ${relPath}\n\`\`\`\n${content.slice(0, 30_000)}\n\`\`\``;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join("\n\n");

  const prompt = `You are a clinical code reviewer. These files are in a healthcare application's domain/ directory.

Review for:
1. Clinical logic errors (wrong formulas, incorrect thresholds, missing safety checks)
2. HIPAA violations (PHI exposure, missing access controls)
3. Medication/fluid safety issues
4. Missing hard stops for dangerous values

${fileContents}

Respond with JSON:
{"hasCritical": true/false, "findings": [{"file": "...", "severity": "CRITICAL|HIGH|MEDIUM|LOW", "issue": "..."}], "summary": "one line"}`;

  try {
    await throttleFor("gemini"); // I-2: free-tier rate limit
    const response = await withTimeout( // I-4
      gemini.models.generateContent({
        model: "gemini-2.5-pro",
        contents: prompt,
        config: { temperature: 0, maxOutputTokens: 2000 },
      }),
      API_TIMEOUT_MS,
      "clinicalAudit(gemini)",
    );
    return validateAuditResponse(extractJson(response.text)); // R-1
  } catch {
    // Fail closed on clinical audit failure
    return { hasCritical: true, summary: "clinical-audit-error-fail-closed" };
  }
}

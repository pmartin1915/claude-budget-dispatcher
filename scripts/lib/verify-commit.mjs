// verify-commit.mjs — Phase 5: Worktree creation, test verification,
// clinical gate, commit, and origin URL restoration.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { extractJson } from "./extract-json.mjs";

/**
 * Create a git worktree for isolated work on an auto-branch.
 * Implements H1 ceremony: removes origin to prevent accidental push.
 * @param {string} projectPath - Absolute path to the project repo
 * @param {string} slug - Project slug
 * @param {string} task - Task keyword
 * @returns {{ path: string, branch: string, originUrl: string }}
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

  // H1 ceremony: detach origin to prevent push
  let originUrl = "";
  try {
    originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    execFileSync("git", ["remote", "remove", "origin"], {
      cwd: worktreePath,
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // No origin to remove — fine
  }

  return { path: worktreePath, branch: branchName, originUrl };
}

/**
 * Restore origin URL on a worktree (H1 ceremony cleanup).
 * @param {string} worktreePath
 * @param {string} originUrl
 */
export function restoreOrigin(worktreePath, originUrl) {
  if (!originUrl) return;
  try {
    execFileSync("git", ["remote", "add", "origin", originUrl], {
      cwd: worktreePath,
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Best effort — origin may already exist if cleanup ran twice
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

  // Defense-in-depth: re-run tests in the worktree (if project has a test script)
  const pkgPath = resolve(worktreePath, "package.json");
  const hasTests = existsSync(pkgPath) && (() => {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return !!pkg.scripts?.test;
    } catch { return false; }
  })();

  if (hasTests) {
    try {
      execFileSync("npm", ["test"], {
        cwd: worktreePath,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      revertAndReport(worktreePath);
      return {
        ...workResult,
        outcome: "reverted",
        reason: `final-test-failure-exit-${e.status}`,
      };
    }
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

  // Build commit message
  const modelTag = route.model ? `[${route.model}]` : "";
  const summary = workResult.summary ?? "automated work";
  const msg = `[opportunistic][dispatch.mjs]${modelTag} ${selection.task}: ${summary}`;

  // Stage and commit
  execFileSync("git", ["add", "-A"], {
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

  return {
    outcome: "success",
    project: selection.project,
    task: selection.task,
    branch: workResult.worktree.branch,
    commit_hash: hash,
    files_changed: workResult.filesChanged?.length ?? 0,
    delegate_to: route.model ?? "local",
    summary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const fileContents = domainFiles
    .slice(0, 3)
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
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-pro",
      contents: prompt,
      config: { temperature: 0, maxOutputTokens: 2000 },
    });
    return extractJson(response.text);
  } catch {
    // Fail closed on clinical audit failure
    return { hasCritical: true, summary: "clinical-audit-error-fail-closed" };
  }
}

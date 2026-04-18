// git-lock.mjs -- R-7: remove stale .git/index.lock files left behind by
// crashed git operations. Safe at dispatcher startup because
// run-dispatcher.ps1's Global\claude-budget-dispatcher mutex (R-3)
// guarantees no other dispatcher instance is mid-git-op when this runs.

import { statSync, unlinkSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSafeTestEnv } from "./worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = resolve(__dirname, "..", "..", "status");
const FSCK_MARKER = resolve(STATUS_DIR, "last-fsck.txt");

const NPM_AUDIT_MARKER = resolve(STATUS_DIR, "last-npm-audit.txt");
const STALE_AGE_MS = 30 * 60 * 1000; // 30 min

/**
 * Check each project's .git/index.lock and remove any whose mtime is older
 * than STALE_AGE_MS. Silent on ENOENT (common case); logs on other errors
 * and continues.
 *
 * @param {string[]} projectPaths - Absolute paths to rotation project clones.
 * @param {number} [now] - Injected clock for tests (defaults to Date.now()).
 * @returns {Array<{ lockPath: string, ageMs: number }>} Removed locks.
 */
export function sweepStaleIndexLocks(projectPaths, now = Date.now()) {
  const removed = [];
  for (const projectPath of projectPaths) {
    const lockPath = resolve(projectPath, ".git", "index.lock");
    try {
      const st = statSync(lockPath);
      const ageMs = now - st.mtimeMs;
      if (ageMs > STALE_AGE_MS) {
        unlinkSync(lockPath);
        removed.push({ lockPath, ageMs });
        console.warn(
          `[git-lock] removed stale ${lockPath} (age=${Math.round(ageMs / 1000)}s)`
        );
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.warn(`[git-lock] check ${lockPath}: ${e.message}`);
      }
    }
  }
  return removed;
}

/**
 * Run `git fsck` on rotation projects weekly (C-4).
 * Detects early signs of object store corruption from concurrent worktree
 * operations. Writes a marker file with the last-run date to avoid running
 * more than once per week.
 * @param {string[]} projectPaths
 * @returns {{ ran: boolean, errors: string[] }}
 */
export function weeklyGitFsck(projectPaths) {
  // Check if we've already run this week
  if (existsSync(FSCK_MARKER)) {
    try {
      const lastRun = readFileSync(FSCK_MARKER, "utf8").trim();
      const daysSince = (Date.now() - new Date(lastRun).getTime()) / 86_400_000;
      if (daysSince < 7) {
        return { ran: false, errors: [] };
      }
    } catch {
      // Corrupt marker — run fsck
    }
  }

  const errors = [];
  for (const projectPath of projectPaths) {
    try {
      execFileSync("git", ["fsck", "--no-dangling", "--no-progress"], {
        cwd: projectPath,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        env: getSafeTestEnv(),
      });
    } catch (e) {
      const stderr = e.stderr?.toString() ?? e.message;
      errors.push(`${projectPath}: ${stderr.slice(0, 500)}`);
      console.error(`[git-fsck] errors in ${projectPath}: ${stderr.slice(0, 200)}`);
    }
  }

  // Write marker
  try {
    writeFileSync(FSCK_MARKER, new Date().toISOString());
  } catch {
    // Non-fatal
  }

  if (errors.length === 0) {
    console.log(`[git-fsck] all ${projectPaths.length} projects clean`);
  }

  return { ran: true, errors };
}

/**
 * Remove stale worktrees on auto/* branches older than maxAgeDays.
 * Dispatches create worktrees for each run; without cleanup they accumulate
 * indefinitely. Only touches branches matching refs/heads/auto/* to avoid
 * disturbing user branches or main.
 *
 * @param {string[]} projectPaths - Absolute paths to rotation project clones.
 * @param {number} [maxAgeDays=7] - Grace period before removal.
 * @returns {Array<{ wtPath: string, branch: string, ageMs: number }>}
 */
export function sweepStaleWorktrees(projectPaths, maxAgeDays = 1) {
  const removed = [];
  const cutoffMs = maxAgeDays * 86_400_000;

  for (const projectPath of projectPaths) {
    let output;
    try {
      output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: projectPath,
        timeout: 30_000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      continue;
    }

    // Porcelain format: blocks separated by blank lines.
    // Each block has: worktree <path>\nHEAD <sha>\nbranch <ref>\n
    for (const block of output.split("\n\n")) {
      const lines = block.trim().split("\n");
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      const brLine = lines.find((l) => l.startsWith("branch "));
      if (!wtLine || !brLine) continue;

      const wtPath = wtLine.slice("worktree ".length);
      const branch = brLine.slice("branch ".length);

      // Only touch auto/* branches
      if (!branch.startsWith("refs/heads/auto/")) continue;

      try {
        const st = statSync(wtPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < cutoffMs) continue;

        execFileSync("git", ["worktree", "remove", wtPath, "--force"], {
          cwd: projectPath,
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Clean up the local branch ref too
        const branchName = branch.replace("refs/heads/", "");
        try {
          execFileSync("git", ["branch", "-D", branchName], {
            cwd: projectPath,
            timeout: 10_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Branch may already be gone if worktree remove cleaned it
        }
        removed.push({ wtPath, branch, ageMs });
        console.log(
          `[worktree] removed stale ${wtPath} (age=${Math.round(ageMs / 86_400_000)}d)`
        );
      } catch (e) {
        if (e.code !== "ENOENT") {
          console.warn(`[worktree] cleanup ${wtPath}: ${e.message}`);
        }
      }
    }
  }

  if (removed.length > 0) {
    console.log(`[worktree] cleaned up ${removed.length} stale worktree(s)`);
  }
  return removed;
}

/**
 * Run `npm audit` weekly to check for known vulnerabilities (S-8).
 * Follows the same marker-file pattern as weeklyGitFsck (C-4).
 * Non-blocking: logs results but never prevents dispatch.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {{ ran: boolean, vulnerabilities: number, summary: string }}
 */
export function weeklyNpmAudit(repoRoot) {
  if (existsSync(NPM_AUDIT_MARKER)) {
    try {
      const lastRun = readFileSync(NPM_AUDIT_MARKER, "utf8").trim();
      const daysSince = (Date.now() - new Date(lastRun).getTime()) / 86_400_000;
      if (daysSince < 7) {
        return { ran: false, vulnerabilities: 0, summary: "skipped-recent" };
      }
    } catch {
      // Corrupt marker — run audit
    }
  }

  let stdout = "";
  try {
    stdout = execSync("npm audit --json --omit=dev", {
      cwd: repoRoot,
      timeout: 60_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: getSafeTestEnv(),
    });
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities are found;
    // the JSON report is still on stdout.
    stdout = e.stdout ?? "";
    if (!stdout && e.stderr) {
      console.warn(`[npm-audit] error: ${e.stderr.slice(0, 200)}`);
    }
  }

  let vulnerabilities = 0;
  let summary = "audit-complete";
  try {
    const parsed = JSON.parse(stdout);
    const meta = parsed?.metadata?.vulnerabilities ?? {};
    vulnerabilities =
      (meta.critical ?? 0) + (meta.high ?? 0) +
      (meta.moderate ?? 0) + (meta.low ?? 0);
    if ((meta.critical ?? 0) > 0 || (meta.high ?? 0) > 0) {
      summary = `ALERT: ${meta.critical ?? 0} critical, ${meta.high ?? 0} high vulnerabilities`;
      console.error(`[npm-audit] ${summary}`);
    } else if (vulnerabilities > 0) {
      summary = `${vulnerabilities} vulnerabilities (none critical/high)`;
      console.log(`[npm-audit] ${summary}`);
    } else {
      summary = "no known vulnerabilities";
      console.log(`[npm-audit] ${summary}`);
    }
  } catch {
    summary = "audit-parse-error";
    console.warn(`[npm-audit] failed to parse audit result`);
  }

  // Write marker
  try {
    writeFileSync(NPM_AUDIT_MARKER, new Date().toISOString());
  } catch {
    // Non-fatal
  }

  return { ran: true, vulnerabilities, summary };
}

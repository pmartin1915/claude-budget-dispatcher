// git-lock.mjs -- R-7: remove stale .git/index.lock files left behind by
// crashed git operations. Safe at dispatcher startup because
// run-dispatcher.ps1's Global\claude-budget-dispatcher mutex (R-3)
// guarantees no other dispatcher instance is mid-git-op when this runs.

import { statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

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

// scaffold.mjs -- Bug A defensive scaffold-verify. Surfaces the silent skip
// in context.mjs:56-59 (projects without DISPATCH.md drop out of selector
// context with no log surface) as a per-project JSONL outcome so dashboards,
// evaluateNoProgress, and morning-briefing can see which rotation projects
// are dormant due to missing scaffolds.
//
// Local-fs check by design (mirrors what context.mjs actually checks). The
// "exists locally, missing on origin/main" failure mode surfaces separately
// in auto-push.mjs at push-attempt time. See docs/SCAFFOLD-CHECK.md.

import { existsSync as defaultExistsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_FS = { existsSync: defaultExistsSync };

/**
 * Pure. Evaluate one project's scaffold completeness. Mirrors
 * evaluatePathFirewall (auto-push.mjs:135) shape: structured verdict.
 *
 * @param {{ project: { slug: string, path: string }, fs?: { existsSync(p: string): boolean } }} args
 * @returns {{ ok: true } | { ok: false, reason: string, path: string }}
 */
export function evaluateProjectScaffold({ project, fs }) {
  const dispatchPath = resolve(project.path, "DISPATCH.md");
  if (!fs.existsSync(dispatchPath)) {
    return { ok: false, reason: "dispatch-md-missing", path: dispatchPath };
  }
  return { ok: true };
}

/**
 * Fleet-level orchestrator. Iterates projects_in_rotation, emits one
 * `outcome: "scaffold-missing"` JSONL entry per project whose DISPATCH.md
 * is absent. Per-project errors (e.g. malformed entries) are caught and
 * logged as `outcome: "scaffold-check-error"` so one bad entry doesn't
 * abort the whole pass.
 *
 * Never throws; never blocks dispatch. Phase 0.5 caller wraps in its own
 * try/catch for further defense in depth.
 *
 * @param {{
 *   projects: Array<{ slug: string, path: string }>,
 *   fs?: { existsSync(p: string): boolean },
 *   appendLog: (entry: object) => void,
 * }} args
 * @returns {{ missing: Array<{ project: string, ok: boolean, reason?: string, path?: string }> }}
 */
export function verifyProjectScaffolds({ projects, fs = DEFAULT_FS, appendLog }) {
  const missing = [];
  for (const project of projects ?? []) {
    let verdict;
    try {
      verdict = evaluateProjectScaffold({ project, fs });
    } catch (err) {
      const slug = project?.slug ?? "(unknown)";
      appendLog({
        engine: "dispatch.mjs",
        phase: "scaffold-check",
        project: slug,
        outcome: "scaffold-check-error",
        reason: (err?.message ?? String(err)).slice(0, 500),
      });
      missing.push({ project: slug, ok: false, reason: "scaffold-check-error" });
      continue;
    }
    if (!verdict.ok) {
      missing.push({ project: project.slug, ...verdict });
      appendLog({
        engine: "dispatch.mjs",
        phase: "scaffold-check",
        project: project.slug,
        outcome: "scaffold-missing",
        reason: verdict.reason,
      });
    }
  }
  return { missing };
}

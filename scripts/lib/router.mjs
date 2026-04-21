// router.mjs — Phase 3: Deterministic task-to-class mapping and model resolution.
// Zero LLM tokens. Pure logic.
//
// Supports per-project model overrides and per-task fallback chains.
// Backward-compatible: if no project_overrides exist, uses the flat classes map.

/** Map task keywords to delegation classes. */
export const TASK_TO_CLASS = {
  // Local tasks (no LLM needed)
  test: "local",
  typecheck: "local",
  lint: "local",
  coverage: "local",

  // Audit class (Gemini)
  audit: "audit",
  "self-audit": "audit",

  // Explore/research class (Gemini)
  explore: "explore",
  research: "research",
  proposal: "research",
  "roadmap-review": "research",

  // Code generation class (Codestral)
  "tests-gen": "tests_gen",
  "add-tests": "tests_gen",
  refactor: "refactor",
  clean: "refactor",

  // Documentation class (Mistral Large)
  "docs-gen": "docs_gen",
  jsdoc: "docs_gen",
  "session-log": "docs_gen",

  // Slot-fill class (Gemini 2.5 Pro) — expand flagged subsections in content files
  slot_fill: "slot_fill",
};

/**
 * Resolve the delegation target for a given task.
 * @param {string} task - Task keyword from selector
 * @param {object} roster - free_model_roster from budget.json
 * @param {string} [projectSlug] - Current project slug (for per-project overrides)
 * @returns {{ delegate_to: string, model: string|null, taskClass: string, auditModel?: string, candidates?: string[], reason?: string }}
 */
export function resolveModel(task, roster, projectSlug) {
  const taskClass = TASK_TO_CLASS[task] ?? "local";

  // Local tasks run without any LLM
  if (taskClass === "local") {
    return { delegate_to: "local", model: null, taskClass, candidates: [] };
  }

  // Claude-only tasks are forbidden in dispatch.mjs (no Claude available)
  if (roster.claude_only?.includes(taskClass)) {
    return {
      delegate_to: "skip",
      model: null,
      taskClass,
      reason: "claude-only-task",
      candidates: [],
    };
  }

  // Resolve per-project override (if any)
  const projectConfig = projectSlug
    ? roster.project_overrides?.[projectSlug]
    : undefined;

  // Get the class entry: per-project first, then global fallback
  const classEntry = projectConfig?.classes?.[taskClass]
    ?? roster.classes?.[taskClass]
    ?? null;

  // Normalize to array (backward compat: string -> [string])
  const perTaskChain = Array.isArray(classEntry)
    ? classEntry
    : (classEntry ? [classEntry] : []);

  // Build candidates: per-task chain first, then global fallback chain
  const candidates = [...perTaskChain];
  for (const m of roster.fallback_chain ?? []) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  // Build the set of allowed models (all listed + fallback chain + project overrides)
  const allowedSet = new Set([
    ...Object.values(roster.classes ?? {}).flatMap((v) => Array.isArray(v) ? v : [v]),
    ...(roster.fallback_chain ?? []),
  ]);

  // Add project override models to allowed set
  if (projectConfig?.classes) {
    for (const v of Object.values(projectConfig.classes)) {
      if (Array.isArray(v)) v.forEach((m) => allowedSet.add(m));
      else if (v) allowedSet.add(v);
    }
  }
  if (projectConfig?.audit_models) {
    for (const v of Object.values(projectConfig.audit_models)) {
      if (v) allowedSet.add(v);
    }
  }

  const forbiddenSet = new Set(roster.forbidden_models ?? []);

  // Walk candidates, collect all viable models for fallback (C-5)
  const viable = [];
  for (const model of candidates) {
    if (roster.allow_only_listed_models && !allowedSet.has(model)) continue;
    if (forbiddenSet.has(model)) continue;
    viable.push(model);
  }

  if (viable.length === 0) {
    return {
      delegate_to: "skip",
      model: null,
      taskClass,
      reason: "no-viable-free-model",
      candidates: [],
    };
  }

  // Resolve audit model (per-project config or null for auto C-1)
  const auditModel = projectConfig?.audit_models?.[taskClass] ?? null;

  return { delegate_to: viable[0], model: viable[0], taskClass, auditModel, candidates: viable };
}

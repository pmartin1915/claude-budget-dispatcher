// router.mjs — Phase 3: Deterministic task-to-class mapping and model resolution.
// Zero LLM tokens. Pure logic.

/** Map task keywords to delegation classes. */
const TASK_TO_CLASS = {
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
};

/**
 * Resolve the delegation target for a given task.
 * @param {string} task - Task keyword from selector
 * @param {object} roster - free_model_roster from budget.json
 * @returns {{ delegate_to: string, model: string|null, taskClass: string, reason?: string }}
 */
export function resolveModel(task, roster) {
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

  // Build candidate list: primary model, then fallback chain
  const primary = roster.classes?.[taskClass] ?? null;
  const candidates = [];
  if (primary) candidates.push(primary);
  for (const m of roster.fallback_chain ?? []) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  // Build the set of allowed models (all listed + fallback chain)
  const allowedSet = new Set([
    ...Object.values(roster.classes ?? {}),
    ...(roster.fallback_chain ?? []),
  ]);

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

  return { delegate_to: viable[0], model: viable[0], taskClass, candidates: viable };
}

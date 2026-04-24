// selector.mjs — Phase 2: Project + task selection via Gemini 2.5 Pro.
// Uses ~2-5K free-tier Gemini tokens per run.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@google/genai";
import { buildProjectContext, getRecentDispatches } from "./context.mjs";
import { extractJson } from "./extract-json.mjs";
import { throttleFor } from "./throttle.mjs";
import { TASK_TO_CLASS } from "./router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "..", "..", "status", "budget-dispatch-log.jsonl");

// I-1 + 2026-04-24 fleet-idle fix: Gemini native structured-output schema.
// When passed as responseSchema with responseMimeType "application/json",
// Gemini guarantees the response is valid JSON matching this shape.
//
// Schema is built dynamically from `projects_in_rotation` so the `project`
// and `task` fields are constrained to the union of valid slugs and task
// names. Prior to this change, `task: STRING` was unconstrained and Gemini
// 2.5 Flash was hallucinating class-name strings (e.g. "tests_gen" instead
// of "tests-gen"), which caused 22h of fleet-wide task_not_allowed skips.
//
// Note: the `task` enum is a union across ALL projects' opportunistic_tasks.
// This prevents Gemini from inventing non-existent task names but does not
// prevent it from picking a task that's valid globally yet not in the
// chosen project's allowlist. Post-call allowlist validation + the
// corrective retry below handle that per-project mismatch.
function buildSelectorSchema(projects) {
  const allTasks = [...new Set(projects.flatMap((p) => p.opportunistic_tasks ?? []))];
  const allSlugs = projects.map((p) => p.slug);
  return {
    type: Type.OBJECT,
    properties: {
      project: { type: Type.STRING, enum: allSlugs },
      task: { type: Type.STRING, enum: allTasks },
      reason: { type: Type.STRING },
    },
    required: ["project", "task", "reason"],
    propertyOrdering: ["project", "task", "reason"],
  };
}

// Normalize hyphen/underscore aliases (e.g. "tests_gen" -> "tests-gen").
// Returns the canonical task string present in `allowedTasks`, or null if
// no match (even after alias substitution).
export function normalizeTaskAlias(task, allowedTasks) {
  if (allowedTasks.includes(task)) return task;
  const withHyphens = task.replaceAll("_", "-");
  if (allowedTasks.includes(withHyphens)) return withHyphens;
  const withUnderscores = task.replaceAll("-", "_");
  if (allowedTasks.includes(withUnderscores)) return withUnderscores;
  return null;
}

// Append a corrective block to the prompt when the first selection picked
// a task not in the chosen project's allowed list. Keeps the original rules
// visible and adds a sharp reminder with the exact valid list.
function buildCorrectivePrompt(originalPrompt, rejected) {
  const valid = rejected.allowed.map((t) => `- \`${t}\``).join("\n");
  return `${originalPrompt}

---

## Previous selection was rejected

Your previous response picked project \`${rejected.project}\` with task \`${rejected.task}\`, but that task is NOT in this project's allowed list.

Valid tasks for \`${rejected.project}\` (pick EXACTLY one of these — case-sensitive, exact hyphenation):
${valid}

Pick a task from the list above, OR pick a different project entirely.`;
}

/**
 * Call Gemini to select one project and one task from the rotation.
 *
 * Returns a plain object with either success fields (project, task, reason,
 * projectConfig) OR an `error` field with structured diagnostics:
 *   { error: { reason: "<short_code>", detail?: string, model?: string,
 *              retries?: number, message?: string, api_status?: number } }
 *
 * Phase 1 of PLAN-smooth-error-handling-and-auto-update.md: today's
 * silent outage happened because failures were logged to console.error
 * and lost. Dispatch.mjs now threads `error` into the JSONL entry.
 *
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object }} clients - SDK instances
 * @returns {Promise<{ project?: string, task?: string, reason?: string,
 *                     projectConfig?: object, error?: object }>}
 */
export async function selectProjectAndTask(config, clients) {
  const projects = config.projects_in_rotation ?? [];
  const contexts = [];

  for (const proj of projects) {
    const ctx = buildProjectContext(proj, LOG_PATH);
    if (!ctx) {
      console.warn(`[selector] skipping ${proj.slug}: no DISPATCH.md`);
      continue;
    }
    contexts.push({ ...ctx, config: proj });
  }

  if (contexts.length === 0) {
    console.warn("[selector] no eligible projects");
    return { error: { reason: "no_eligible_projects", detail: "no project in rotation had a readable DISPATCH.md" } };
  }

  // -----------------------------------------------------------------------
  // Structural diversity enforcement (deterministic, not LLM-dependent)
  // -----------------------------------------------------------------------

  const recentDispatches = getRecentDispatches(LOG_PATH, 8);
  const now = Date.now();
  const cooldownMinutes = config.selector_cooldown_minutes ?? 20;
  const cooldownMs = cooldownMinutes * 60_000;

  // 1. Project cooldown: exclude projects attempted within cooldown window.
  //    Falls back to full set if filter would leave nothing.
  const cooledDown = contexts.filter((ctx) => {
    if (!ctx.last_attempted || ctx.last_attempted === "never") return true;
    const age = now - new Date(ctx.last_attempted).getTime();
    return Number.isFinite(age) && age >= cooldownMs;
  });
  const selectorContexts = cooledDown.length > 0 ? cooledDown : contexts;
  if (selectorContexts.length < contexts.length) {
    const excluded = contexts
      .filter((c) => !selectorContexts.includes(c))
      .map((c) => c.slug)
      .join(", ");
    console.log(`[selector] cooldown excluded (${cooldownMinutes}m): ${excluded}`);
  }

  // 2. Task-class cooldown: count recent task classes across ALL projects.
  //    If a class was used N+ times in the last 8 dispatches, remove those
  //    tasks from every project's allowed list. Falls back if nothing remains.
  const taskClassRepeatLimit = config.task_class_repeat_limit ?? 2;
  const recentClassCounts = {};
  for (const d of recentDispatches) {
    const cls = TASK_TO_CLASS[d.task] ?? "unknown";
    recentClassCounts[cls] = (recentClassCounts[cls] || 0) + 1;
  }
  const overusedClasses = new Set(
    Object.entries(recentClassCounts)
      .filter(([, count]) => count >= taskClassRepeatLimit)
      .map(([cls]) => cls)
  );

  if (overusedClasses.size > 0) {
    let anyFiltered = false;
    for (const ctx of selectorContexts) {
      // Snapshot the already-vetted list (respects NEEDS_SRC filter from
      // buildProjectContext). Fallback must restore this, NOT the raw config
      // list, to avoid re-introducing tasks that would always fail.
      const viableTasks = [...ctx.opportunistic_tasks];
      ctx.opportunistic_tasks = viableTasks.filter(
        (t) => !overusedClasses.has(TASK_TO_CLASS[t] ?? "unknown")
      );
      if (ctx.opportunistic_tasks.length < viableTasks.length) anyFiltered = true;
      // Never leave a project with zero tasks — restore the vetted list
      if (ctx.opportunistic_tasks.length === 0) {
        ctx.opportunistic_tasks = viableTasks;
      }
    }
    if (anyFiltered) {
      console.log(
        `[selector] task-class cooldown: ${[...overusedClasses].join(", ")} ` +
        `hit ${taskClassRepeatLimit}x in last ${recentDispatches.length} dispatches`
      );
    }
  }

  // 3. Build a diversity hint for the prompt showing what was recently dispatched
  //    so the LLM can make informed choices from the remaining options.
  const diversityHint = recentDispatches.length > 0
    ? recentDispatches
        .slice(0, 6)
        .map((d) => `- ${d.project} / ${d.task} @ ${d.ts}`)
        .join("\n")
    : "(no recent dispatches)";

  // Keep the original prompt unmutated so corrective retries rebuild from a
  // clean base. Layering corrective blocks across >1 retry would confuse the
  // model (Gemini 2.5-pro audit, 2026-04-24).
  const initialPrompt = buildSelectorPrompt(selectorContexts, diversityHint);
  let prompt = initialPrompt;
  // Default to gemini-2.5-flash: (1) supports thinkingBudget: 0 (pro does not,
  // rejects with INVALID_ARGUMENT), (2) better free-tier rate limits, (3) less
  // subject to pro's high-demand 503 spikes. Selector task is structured
  // enough that flash is sufficient — the audit value of pro is marginal.
  const model = config.selector_model ?? "gemini-2.5-flash";
  const temperature = config.selector_temperature ?? 0;
  const maxTokens = config.selector_max_tokens ?? 500;
  const isFlash = model.includes("flash");

  // I-1: native structured-output mode. responseMimeType + responseSchema
  // guarantee valid JSON. CRITICAL: on thinking-capable models, reasoning
  // tokens consume the maxOutputTokens budget before the JSON emits — a
  // 500-token cap is too small and causes response.text to be empty or a
  // truncated string. Flash permits thinkingBudget: 0 to disable thinking;
  // pro requires thinking mode, so if user overrides to pro they need to
  // raise selector_max_tokens substantially (2000+) to avoid truncation.
  const genConfig = {
    temperature,
    maxOutputTokens: maxTokens,
    responseMimeType: "application/json",
    responseSchema: buildSelectorSchema(projects),
    ...(isFlash ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };

  // 2026-04-24 fleet-idle fix: wrap selection + validation in a retry loop.
  // On first task_not_allowed, re-prompt with a corrective suffix that shows
  // Gemini the exact valid task list for the project it picked. Limit to 2
  // attempts so a persistently-hallucinating model still fails closed quickly.
  const MAX_ATTEMPTS = 2;
  let lastSelection = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let responseText;
    try {
      responseText = await callGeminiWithRetry(clients.gemini, model, prompt, genConfig);
    } catch (e) {
      console.error(`[selector] Gemini call failed: ${e.message}`);
      // callGeminiWithRetry attaches .selectorDetails with { model, retries,
      // root_cause, api_error_message, api_status } -- pass through verbatim
      // so the caller's JSONL entry carries full diagnostics.
      const d = e.selectorDetails ?? {};
      return {
        error: {
          reason: "gemini_call_failed",
          detail: d.root_cause ?? "unknown",
          model: d.model ?? model,
          retries: d.retries,
          message: d.api_error_message ?? e.message,
          api_status: d.api_status ?? null,
        },
      };
    }

    // Defense-in-depth: if callGeminiWithRetry somehow returned non-string, fail.
    if (typeof responseText !== "string" || responseText.length === 0) {
      console.error("[selector] Gemini returned empty/non-string response");
      return {
        error: { reason: "empty_response", detail: "callGeminiWithRetry returned non-string", model },
      };
    }

    // Native JSON mode output parses directly. Keep extractJson as a last-resort
    // fallback in case the SDK ever delivers fenced / preamble-wrapped text
    // despite the mime-type hint.
    let selection;
    try {
      selection = JSON.parse(responseText);
    } catch {
      try {
        selection = extractJson(responseText);
      } catch (e2) {
        console.error(`[selector] JSON parse failed: ${e2.message}`);
        return {
          error: { reason: "json_parse_failed", detail: e2.message, model, message: responseText.slice(0, 200) },
        };
      }
    }

    // Validate selection against config
    if (!selection.project || !selection.task) {
      console.error("[selector] response missing project or task field");
      return {
        error: { reason: "invalid_response_shape", detail: "missing project or task field", model },
      };
    }

    // S-6: post-call allowlist validation -- project slug + task allowlist.
    const projectConfig = projects.find((p) => p.slug === selection.project);
    if (!projectConfig) {
      console.error(`[selector] unknown project slug: ${selection.project}`);
      return {
        error: { reason: "unknown_project_slug", detail: selection.project, model },
      };
    }

    // Hyphen/underscore alias normalization (belt-and-suspenders with the
    // schema enum). Catches `tests_gen` vs `tests-gen` drift if Gemini ever
    // emits a class-style token past the enum.
    const canonicalTask = normalizeTaskAlias(selection.task, projectConfig.opportunistic_tasks);

    if (canonicalTask) {
      // Post-selection diversity guard: if the LLM picked a (project, task)
      // pair that matches one of the last 3 dispatches, log a warning. The
      // structural task-class filter above should have prevented this, but
      // the LLM may pick a different task keyword in the same class, or the
      // filter may have fallen back. Observability, not a hard block.
      const recentPairs = recentDispatches.slice(0, 3);
      const isRepeat = recentPairs.some(
        (d) => d.project === selection.project && d.task === canonicalTask
      );
      if (isRepeat) {
        console.warn(
          `[selector] WARNING: picked recently-dispatched pair ` +
          `${selection.project}/${canonicalTask} — structural filter may have fallen back`
        );
      }

      return {
        project: selection.project,
        task: canonicalTask,
        reason: selection.reason ?? "",
        projectConfig,
      };
    }

    // task_not_allowed — retry once with corrective feedback before giving up.
    lastSelection = { project: selection.project, task: selection.task, allowed: projectConfig.opportunistic_tasks };
    if (attempt < MAX_ATTEMPTS - 1) {
      console.warn(
        `[selector] task "${selection.task}" not in ${selection.project}'s allowed list — ` +
        `retrying with corrective prompt (attempt ${attempt + 2}/${MAX_ATTEMPTS})`
      );
      prompt = buildCorrectivePrompt(initialPrompt, lastSelection);
      continue;
    }
  }

  // Both attempts failed validation.
  console.error(
    `[selector] task "${lastSelection.task}" not in ${lastSelection.project}'s opportunistic_tasks (after retry)`
  );
  return {
    error: {
      reason: "task_not_allowed",
      detail: `${lastSelection.project}/${lastSelection.task}`,
      model,
      retry_attempted: true,
    },
  };
}

/**
 * Build the constrained selector prompt.
 * @param {object[]} contexts - Project context objects from buildProjectContext
 * @param {string} diversityHint - Recent dispatch history for diversity awareness
 * @returns {string}
 */
function buildSelectorPrompt(contexts, diversityHint) {
  const projectBlocks = contexts
    .map(
      (ctx) => `### ${ctx.slug}
- Clinical gate: ${ctx.clinical_gate}
- Has source files (src/): ${ctx.has_source_files}
- Allowed tasks: ${ctx.opportunistic_tasks.join(", ")}
- Last successful dispatch: ${ctx.last_dispatched}
- Last attempted (any outcome): ${ctx.last_attempted}

**State:**
<data source="STATE.md" project="${ctx.slug}">
${ctx.state_summary}
</data>

**Pre-Approved Tasks:**
<data source="DISPATCH.md" project="${ctx.slug}">
${ctx.approved_tasks}
</data>

**Recent Outcomes (I-3):**
${ctx.recent_outcomes}

**Merge Rate (branch outcomes):**
${ctx.merge_rate}`
    )
    .join("\n\n---\n\n");

  return `You are the project/task selector for an automated budget dispatcher.

Given these projects and their current state, pick ONE project and ONE task.
DIVERSITY IS CRITICAL. The operator reviews output and will reject repetitive work.

## Rules (in priority order)
1. Failing tests or typecheck errors -> highest priority
2. Stale status (oldest last successful dispatch) -> next priority
3. Least-recently-ATTEMPTED (any outcome, not just success) -> tiebreaker. "never" ranks as more stale than any timestamp -- always prefer a never-attempted project when Rule 1/2 are tied.
4. ONLY pick from the intersection of the project's Pre-Approved Tasks and its "Allowed tasks" list
5. Tasks that would touch domain/ on clinical_gate=true projects are FORBIDDEN
6. If has_source_files is false: DO NOT pick docs-gen, tests-gen, session-log, jsdoc, refactor, add-tests, or clean — these tasks need src/ files and will always skip without them. Pick explore, research, audit, self-audit, or roadmap-review instead (these use git history).
7. Avoid tasks that failed or were reverted in the last 2 consecutive attempts -- pick a different task or project instead.
7b. Avoid tasks that were SKIPPED 3+ consecutive times with the SAME reason (e.g. "no-files-to-analyze") -- the outcome is deterministic and will keep skipping. Pick a different task for that project, or a different project entirely.
8. NEVER pick the same task keyword that appears in the "Recent Dispatches" list below. Pick a DIFFERENT task keyword. If every task on a project was recently dispatched, pick a different project.
9. Prefer (project, taskClass) combinations with higher merge rates. A higher merge rate means Perry found that work useful. A 0% rate with many branches means the work is being ignored -- try a different task class. Ignore this rule if no merge data is available yet.
10. If all projects were recently dispatched and have no urgent issues, pick the one with the most impactful available task that was NOT recently dispatched.

## Recent Dispatches (do NOT repeat these task keywords)

${diversityHint}

## Projects

${projectBlocks}

## Response format
Respond with EXACTLY this JSON (no markdown fences, no explanation):
{"project": "<slug>", "task": "<task-keyword>", "reason": "<one line explanation>"}`;
}

/**
 * Call Gemini with simple retry (rate limit / 503 handling).
 *
 * On failure, throws an Error with a `.selectorDetails` property populated
 * with { model, retries, root_cause, api_error_message, api_status } so the
 * caller can pass them through to the dispatch JSONL entry. Phase 1 of
 * PLAN-smooth-error-handling-and-auto-update.md: today's 10h silent outage
 * was invisible because this function's errors were caught by
 * console.error and discarded before the log entry was written.
 *
 * @param {object} gemini - GoogleGenAI instance
 * @param {string} model - Model ID
 * @param {string} prompt - Full prompt text
 * @param {object} genConfig - Generation config (temperature, maxOutputTokens)
 * @returns {Promise<string>} Response text
 */
async function callGeminiWithRetry(gemini, model, prompt, genConfig) {
  const delays = [2000, 4000, 8000];
  let rootCause = "unknown";
  let apiStatus = null;

  const attachAndThrow = (err, attempt) => {
    err.selectorDetails = {
      model,
      retries: attempt,
      root_cause: rootCause,
      api_error_message: err.message,
      api_status: apiStatus,
    };
    throw err;
  };

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await throttleFor("gemini"); // I-2: free-tier rate limit
      const response = await gemini.models.generateContent({
        model,
        contents: prompt,
        config: genConfig,
      });
      // Guard: native JSON mode can return response.text=undefined on
      // schema/safety/token-budget failures. Treat as a retryable empty
      // response instead of silently returning undefined to the caller.
      if (typeof response.text !== "string" || response.text.length === 0) {
        rootCause = "empty_response";
        if (attempt < delays.length) {
          console.warn(
            `[selector] empty Gemini response, retrying in ${delays[attempt]}ms`
          );
          await sleep(delays[attempt]);
          continue;
        }
        // Exhausted retries on empty-response path — this is exactly the
        // signal today's 10h outage needed (pro model + thinkingBudget:0).
        attachAndThrow(new Error("Gemini returned empty response text"), attempt);
      }
      return response.text;
    } catch (e) {
      // If we threw ourselves via attachAndThrow above, .selectorDetails is
      // already set — re-throw untouched.
      if (e.selectorDetails) throw e;
      const status = e.status ?? e.httpStatusCode ?? 0;
      apiStatus = status || null;
      // Always recompute rootCause from the CURRENT error, not a stale value
      // carried over from a prior retry iteration. Without this, an empty-
      // response on attempt 0 followed by a 400 on attempt 1 would be
      // misreported as "empty_response" because the else-if guard wouldn't
      // re-fire.
      if (status === 429) rootCause = "rate_limited";
      else if (status >= 500 && status < 600) rootCause = "server_error";
      else rootCause = "api_error";

      const retryable = rootCause === "rate_limited" || rootCause === "server_error";
      if (retryable && attempt < delays.length) {
        console.warn(
          `[selector] Gemini ${status}, retrying in ${delays[attempt]}ms`
        );
        await sleep(delays[attempt]);
        continue;
      }
      attachAndThrow(e, attempt);
    }
  }
  // Unreachable: the loop always returns on success or throws on failure.
  // Present for static-analysis friendliness and in case the loop bounds change.
  throw new Error("callGeminiWithRetry: unreachable fallthrough");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

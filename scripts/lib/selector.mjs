// selector.mjs — Phase 2: Project + task selection via Gemini 2.5 Pro.
// Uses ~2-5K free-tier Gemini tokens per run.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@google/genai";
import { buildProjectContext } from "./context.mjs";
import { extractJson } from "./extract-json.mjs";
import { throttleFor } from "./throttle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "..", "..", "status", "budget-dispatch-log.jsonl");

// I-1: Gemini native structured-output schema. When passed as responseSchema
// with responseMimeType "application/json", Gemini guarantees the response
// is valid JSON matching this shape — no extractJson / nudge-retry needed.
const SELECTOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    project: { type: Type.STRING },
    task: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["project", "task", "reason"],
  propertyOrdering: ["project", "task", "reason"],
};

/**
 * Call Gemini to select one project and one task from the rotation.
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object }} clients - SDK instances
 * @returns {Promise<{ project: string, task: string, reason: string, projectConfig: object }|null>}
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
    return null;
  }

  // Cooldown filter: prevent the selector LLM from re-picking a project it
  // just attempted. Without this, the LLM can fixate on a project whose
  // STATE.md is richer than peers and fabricate a Rule-2-flavored justification
  // ("oldest last dispatch") while repeatedly picking the most-recent one.
  // Falls back to the full set if the filter would leave nothing eligible.
  const cooldownMinutes = config.selector_cooldown_minutes ?? 20;
  const cooldownMs = cooldownMinutes * 60_000;
  const now = Date.now();
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

  const prompt = buildSelectorPrompt(selectorContexts);
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
    responseSchema: SELECTOR_SCHEMA,
    ...(isFlash ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };

  let responseText;
  try {
    responseText = await callGeminiWithRetry(clients.gemini, model, prompt, genConfig);
  } catch (e) {
    console.error(`[selector] Gemini call failed: ${e.message}`);
    return null;
  }

  // Defense-in-depth: if callGeminiWithRetry somehow returned non-string, fail.
  if (typeof responseText !== "string" || responseText.length === 0) {
    console.error("[selector] Gemini returned empty/non-string response");
    return null;
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
      return null;
    }
  }

  // Validate selection against config
  if (!selection.project || !selection.task) {
    console.error("[selector] response missing project or task field");
    return null;
  }

  // S-6: post-call allowlist validation -- project slug + task allowlist.
  const projectConfig = projects.find((p) => p.slug === selection.project);
  if (!projectConfig) {
    console.error(`[selector] unknown project slug: ${selection.project}`);
    return null;
  }

  if (!projectConfig.opportunistic_tasks.includes(selection.task)) {
    console.error(
      `[selector] task "${selection.task}" not in ${selection.project}'s opportunistic_tasks`
    );
    return null;
  }

  return {
    project: selection.project,
    task: selection.task,
    reason: selection.reason ?? "",
    projectConfig,
  };
}

/**
 * Build the constrained selector prompt.
 * @param {object[]} contexts - Project context objects from buildProjectContext
 * @returns {string}
 */
function buildSelectorPrompt(contexts) {
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
${ctx.recent_outcomes}`
    )
    .join("\n\n---\n\n");

  return `You are the project/task selector for an automated budget dispatcher.

Given these projects and their current state, pick ONE project and ONE task.

## Rules (in priority order)
1. Failing tests or typecheck errors -> highest priority
2. Stale status (oldest last successful dispatch) -> next priority
3. Least-recently-ATTEMPTED (any outcome, not just success) -> tiebreaker. "never" ranks as more stale than any timestamp -- always prefer a never-attempted project when Rule 1/2 are tied.
4. ONLY pick from the intersection of the project's Pre-Approved Tasks and its "Allowed tasks" list
5. Tasks that would touch domain/ on clinical_gate=true projects are FORBIDDEN
6. If has_source_files is false: DO NOT pick docs-gen, tests-gen, session-log, jsdoc, refactor, add-tests, or clean — these tasks need src/ files and will always skip without them. Pick explore, research, audit, self-audit, or roadmap-review instead (these use git history).
7. Avoid tasks that failed or were reverted in the last 2 consecutive attempts -- pick a different task or project instead.
7b. Avoid tasks that were SKIPPED 3+ consecutive times with the SAME reason (e.g. "no-files-to-analyze") -- the outcome is deterministic and will keep skipping. Pick a different task for that project, or a different project entirely.
8. If all projects were recently dispatched and have no urgent issues, pick the one with the most impactful available task

## Projects

${projectBlocks}

## Response format
Respond with EXACTLY this JSON (no markdown fences, no explanation):
{"project": "<slug>", "task": "<task-keyword>", "reason": "<one line explanation>"}`;
}

/**
 * Call Gemini with simple retry (rate limit / 503 handling).
 * @param {object} gemini - GoogleGenAI instance
 * @param {string} model - Model ID
 * @param {string} prompt - Full prompt text
 * @param {object} genConfig - Generation config (temperature, maxOutputTokens)
 * @returns {Promise<string>} Response text
 */
async function callGeminiWithRetry(gemini, model, prompt, genConfig) {
  const delays = [2000, 4000, 8000];
  let lastError;

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
        lastError = new Error("Gemini returned empty response text");
        if (attempt < delays.length) {
          console.warn(
            `[selector] empty Gemini response, retrying in ${delays[attempt]}ms`
          );
          await sleep(delays[attempt]);
          continue;
        }
        throw lastError;
      }
      return response.text;
    } catch (e) {
      lastError = e;
      const status = e.status ?? e.httpStatusCode ?? 0;
      // Only retry on rate limit (429) or server error (5xx)
      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt < delays.length) {
          console.warn(
            `[selector] Gemini ${status}, retrying in ${delays[attempt]}ms`
          );
          await sleep(delays[attempt]);
          continue;
        }
      }
      throw e; // Non-retryable error
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

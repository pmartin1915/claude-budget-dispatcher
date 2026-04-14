// extract-json.mjs — Robust JSON extraction from LLM text output.
// Handles markdown fences, preamble text, and nested objects.

/**
 * Extract a JSON object from LLM text that may contain markdown fences or prose.
 * Uses brace-balanced parsing (first { to its matching }) rather than greedy
 * regex, so trailing prose or multiple objects don't corrupt the result.
 * @param {string} text - Raw LLM response text
 * @returns {object} Parsed JSON object
 * @throws {Error} If no valid JSON object can be found
 */
export function extractJson(text) {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;

  // Find the first { and its balanced closing }
  const firstBrace = candidate.indexOf("{");
  if (firstBrace === -1) throw new Error("No JSON object found in LLM response");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.substring(firstBrace, i + 1));
      }
    }
  }

  throw new Error("No balanced JSON object found in LLM response");
}

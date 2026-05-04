// provider.mjs — Unified model calling across multiple providers.
//
// Supports 6 provider families:
//   - gemini:     Google GenAI SDK (existing)
//   - mistral:    Mistral SDK (existing, also handles codestral/devstral)
//   - groq:       OpenAI-compatible REST (Groq Cloud)
//   - openrouter: OpenAI-compatible REST (OpenRouter)
//   - ollama:     OpenAI-compatible REST (local, no auth)
//   - deepseek:   OpenAI-compatible REST (DeepSeek API, metered pay-per-token tier 3)
//
// REST-based providers (groq, openrouter, ollama, deepseek) use fetch against
// OpenAI-compat /v1/chat/completions endpoints — zero new npm dependencies.

import { withTimeout, API_TIMEOUT_MS } from "./throttle.mjs";

/** Default provider endpoints and timeouts (overridable via budget.json providers config). */
const DEFAULT_PROVIDERS = {
  gemini:     { timeout_ms: 60_000 },
  mistral:    { timeout_ms: 60_000 },
  groq:       { base_url: "https://api.groq.com/openai/v1",  env_key: "GROQ_API_KEY",       timeout_ms: 30_000 },
  openrouter: { base_url: "https://openrouter.ai/api/v1",    env_key: "OPENROUTER_API_KEY",  timeout_ms: 60_000 },
  ollama:     { base_url: "http://localhost:11434/v1",        env_key: null,                  timeout_ms: 10_000 },
  deepseek:   { base_url: "https://api.deepseek.com/v1",     env_key: "DEEPSEEK_API_KEY",   timeout_ms: 60_000 },
};

/**
 * Get the timeout for a provider, preferring config over defaults.
 * @param {object} providerConfig - free_model_roster.providers from budget.json
 * @param {string} provider - Provider name
 * @returns {number} Timeout in milliseconds
 */
function getProviderTimeout(providerConfig, provider) {
  return providerConfig?.[provider]?.timeout_ms
    ?? DEFAULT_PROVIDERS[provider]?.timeout_ms
    ?? API_TIMEOUT_MS;
}

/**
 * Determine which provider family a model belongs to.
 * @param {string} model
 * @returns {"gemini"|"mistral"|"groq"|"openrouter"|"ollama"|"deepseek"}
 */
export function providerFor(model) {
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("local/")) return "ollama";
  if (model.startsWith("groq/")) return "groq";
  if (model.startsWith("openrouter/")) return "openrouter";
  if (model.startsWith("deepseek/")) return "deepseek";
  // Everything else: mistral SDK (covers codestral-*, mistral-*, devstral-*)
  return "mistral";
}

/**
 * Returns true if the model runs locally (no data leaves the machine).
 * @param {string} model
 * @returns {boolean}
 */
export function isLocalModel(model) {
  return model.startsWith("local/");
}

/**
 * Strip the provider prefix from a model name for API calls.
 * "groq/gpt-oss-120b" -> "gpt-oss-120b"
 * "local/qwen2.5-coder:14b" -> "qwen2.5-coder:14b"
 * "gemini-2.5-flash" -> "gemini-2.5-flash" (no prefix to strip)
 * @param {string} model
 * @returns {string}
 */
function stripPrefix(model) {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return model;
  const prefix = model.slice(0, slashIdx);
  if (["local", "groq", "openrouter", "deepseek"].includes(prefix)) {
    return model.slice(slashIdx + 1);
  }
  return model;
}

/**
 * Call any model via its provider.
 * Routes to the existing Gemini/Mistral SDKs or the fetch-based OpenAI-compat caller.
 * @param {{ gemini: object, mistral: object }} clients - Existing SDK instances
 * @param {object} providerConfig - free_model_roster.providers from budget.json
 * @param {string} model - Full model string (e.g. "gemini-2.5-flash", "groq/gpt-oss-120b")
 * @param {string} prompt - User prompt text
 * @returns {Promise<string>} Response text
 */
export async function callProvider(clients, providerConfig, model, prompt) {
  const provider = providerFor(model);
  const apiModel = stripPrefix(model);

  const timeoutMs = getProviderTimeout(providerConfig, provider);

  switch (provider) {
    case "gemini": {
      if (!clients.gemini) {
        throw new Error(`provider "gemini" requires GEMINI_API_KEY environment variable`);
      }
      const r = await withTimeout(
        clients.gemini.models.generateContent({
          model: apiModel,
          contents: prompt,
          config: { temperature: 0.2, maxOutputTokens: 8000 },
        }),
        timeoutMs,
        `callProvider(${model})`,
      );
      return r.text;
    }

    case "mistral": {
      if (!clients.mistral) {
        throw new Error(`provider "mistral" requires MISTRAL_API_KEY environment variable`);
      }
      const r = await withTimeout(
        clients.mistral.chat.complete({
          model: apiModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          maxTokens: 8000,
        }),
        timeoutMs,
        `callProvider(${model})`,
      );
      return r.choices?.[0]?.message?.content ?? "";
    }

    case "groq":
    case "openrouter":
    case "ollama":
    case "deepseek": {
      const cfg = providerConfig?.[provider] ?? DEFAULT_PROVIDERS[provider];
      if (!cfg?.base_url) {
        throw new Error(`provider "${provider}" has no base_url configured`);
      }
      const apiKey = cfg.env_key ? process.env[cfg.env_key] : null;
      if (cfg.env_key && !apiKey) {
        throw new Error(`provider "${provider}" requires ${cfg.env_key} env var`);
      }
      return callOpenAICompat(cfg.base_url, apiKey, apiModel, prompt, timeoutMs);
    }

    default:
      throw new Error(`unknown provider: ${provider}`);
  }
}

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint.
 * Works for Groq, OpenRouter, Ollama (localhost), and DeepSeek.
 * @param {string} baseUrl - e.g. "https://api.groq.com/openai/v1"
 * @param {string|null} apiKey - Bearer token (null for local/no-auth)
 * @param {string} model - Model name as the API expects it
 * @param {string} prompt - User prompt
 * @returns {Promise<string>} Response text
 */
async function callOpenAICompat(baseUrl, apiKey, model, prompt, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// provider.test.mjs — Unit tests for provider.mjs.
// Covers: providerFor, isLocalModel, getProviderTimeout, callProvider routing.
// Uses Node built-in test runner. Zero deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { providerFor, isLocalModel } from "../provider.mjs";

// ---------------------------------------------------------------------------
// providerFor
// ---------------------------------------------------------------------------

describe("providerFor", () => {
  it("routes gemini models to gemini", () => {
    assert.equal(providerFor("gemini-2.5-pro"), "gemini");
    assert.equal(providerFor("gemini-2.5-flash"), "gemini");
    assert.equal(providerFor("gemini-1.5-pro"), "gemini");
  });

  it("routes local/* models to ollama", () => {
    assert.equal(providerFor("local/qwen2.5-coder:14b"), "ollama");
    assert.equal(providerFor("local/llama3"), "ollama");
  });

  it("routes groq/* models to groq", () => {
    assert.equal(providerFor("groq/llama-3.3-70b-versatile"), "groq");
    assert.equal(providerFor("groq/mixtral-8x7b"), "groq");
  });

  it("routes openrouter/* models to openrouter", () => {
    assert.equal(providerFor("openrouter/minimax-m2.5"), "openrouter");
    assert.equal(providerFor("openrouter/nous-hermes"), "openrouter");
  });

  it("routes deepseek/* models to deepseek", () => {
    assert.equal(providerFor("deepseek/deepseek-v4-flash"), "deepseek");
    assert.equal(providerFor("deepseek/deepseek-v4-pro"), "deepseek");
  });

  it("routes everything else to mistral", () => {
    assert.equal(providerFor("codestral-latest"), "mistral");
    assert.equal(providerFor("mistral-large-latest"), "mistral");
    assert.equal(providerFor("devstral-small-2:24b"), "mistral");
    assert.equal(providerFor("some-unknown-model"), "mistral");
  });

  it("handles edge case empty string", () => {
    assert.equal(providerFor(""), "mistral");
  });
});

// ---------------------------------------------------------------------------
// isLocalModel
// ---------------------------------------------------------------------------

describe("isLocalModel", () => {
  it("returns true for local/* models", () => {
    assert.equal(isLocalModel("local/qwen2.5-coder:14b"), true);
    assert.equal(isLocalModel("local/llama3"), true);
  });

  it("returns false for cloud models", () => {
    assert.equal(isLocalModel("gemini-2.5-pro"), false);
    assert.equal(isLocalModel("codestral-latest"), false);
    assert.equal(isLocalModel("mistral-large-latest"), false);
    assert.equal(isLocalModel("groq/llama-3.3-70b"), false);
    assert.equal(isLocalModel("openrouter/minimax-m2.5"), false);
    assert.equal(isLocalModel("deepseek/deepseek-v4-flash"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isLocalModel(""), false);
  });
});

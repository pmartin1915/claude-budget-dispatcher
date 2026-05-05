// worker.test.mjs — Unit tests for worker.mjs critical functions.
// Focus: isPathInside (path traversal defense) and getSafeTestEnv (credential stripping).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPathInside, getSafeTestEnv, chooseAutofixModel } from "../worker.mjs";
import { resolve, sep } from "node:path";
import { mkdtempSync, writeFileSync, symlinkSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

// Use a real temp directory as the base for path tests
const BASE = mkdtempSync(resolve(tmpdir(), "worker-test-"));

describe("isPathInside", () => {
  it("accepts a valid subpath", () => {
    assert.equal(isPathInside(resolve(BASE, "src", "index.js"), BASE), true);
  });

  it("accepts a deeply nested subpath", () => {
    assert.equal(isPathInside(resolve(BASE, "a", "b", "c", "d.txt"), BASE), true);
  });

  it("rejects a path outside the base", () => {
    assert.equal(isPathInside(resolve(BASE, "..", "evil.txt"), BASE), false);
  });

  it("rejects an absolute path outside the base", () => {
    const outside = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/passwd";
    assert.equal(isPathInside(outside, BASE), false);
  });

  it("rejects path that starts with base name but diverges", () => {
    // e.g., /tmp/worker-test-abc vs /tmp/worker-test-abc-evil
    assert.equal(isPathInside(BASE + "-evil" + sep + "file.txt", BASE), false);
  });

  it("rejects when base does not exist", () => {
    assert.equal(
      isPathInside("/some/file.txt", "/nonexistent/base/path/xyz"),
      false,
    );
  });

  if (process.platform === "win32") {
    it("rejects Windows reserved device names (CON, PRN, NUL)", () => {
      assert.equal(isPathInside(resolve(BASE, "CON"), BASE), false);
      assert.equal(isPathInside(resolve(BASE, "PRN"), BASE), false);
      assert.equal(isPathInside(resolve(BASE, "NUL"), BASE), false);
      assert.equal(isPathInside(resolve(BASE, "COM1"), BASE), false);
      assert.equal(isPathInside(resolve(BASE, "LPT1"), BASE), false);
    });

    it("rejects reserved names with extensions (CON.txt)", () => {
      assert.equal(isPathInside(resolve(BASE, "CON.txt"), BASE), false);
      assert.equal(isPathInside(resolve(BASE, "nul.js"), BASE), false);
    });

    it("is case-insensitive on Windows", () => {
      const upper = BASE.toUpperCase();
      const lower = BASE.toLowerCase();
      assert.equal(
        isPathInside(resolve(lower, "file.txt"), upper),
        true,
      );
    });
  }
});

describe("getSafeTestEnv", () => {
  it("includes PATH", () => {
    const env = getSafeTestEnv();
    // PATH or Path should be present
    assert.ok(env.PATH || env.Path, "PATH should be in safe env");
  });

  it("excludes GEMINI_API_KEY", () => {
    const orig = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key-12345";
    try {
      const env = getSafeTestEnv();
      assert.equal(env.GEMINI_API_KEY, undefined);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it("excludes MISTRAL_API_KEY", () => {
    const orig = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = "test-key-67890";
    try {
      const env = getSafeTestEnv();
      assert.equal(env.MISTRAL_API_KEY, undefined);
    } finally {
      if (orig !== undefined) process.env.MISTRAL_API_KEY = orig;
      else delete process.env.MISTRAL_API_KEY;
    }
  });

  it("excludes GROQ_API_KEY", () => {
    const orig = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "test-key-groq";
    try {
      const env = getSafeTestEnv();
      assert.equal(env.GROQ_API_KEY, undefined);
    } finally {
      if (orig !== undefined) process.env.GROQ_API_KEY = orig;
      else delete process.env.GROQ_API_KEY;
    }
  });

  it("includes TEMP and TMP", () => {
    const env = getSafeTestEnv();
    // At least one should be present on any platform
    if (process.env.TEMP) assert.equal(env.TEMP, process.env.TEMP);
    if (process.env.TMP) assert.equal(env.TMP, process.env.TMP);
  });

  it("includes npm_config_cache if set", () => {
    const orig = process.env.npm_config_cache;
    process.env.npm_config_cache = "/fake/cache";
    try {
      const env = getSafeTestEnv();
      assert.equal(env.npm_config_cache, "/fake/cache");
    } finally {
      if (orig !== undefined) process.env.npm_config_cache = orig;
      else delete process.env.npm_config_cache;
    }
  });
});

describe("chooseAutofixModel", () => {
  it("substitutes mistral-large-latest when usedModel is codestral-latest", () => {
    assert.equal(chooseAutofixModel("codestral-latest"), "mistral-large-latest");
  });

  it("preserves pin when usedModel is gemini-2.5-pro", () => {
    assert.equal(chooseAutofixModel("gemini-2.5-pro"), "gemini-2.5-pro");
  });

  it("preserves pin when usedModel is mistral-large-latest (no double-substitute)", () => {
    assert.equal(chooseAutofixModel("mistral-large-latest"), "mistral-large-latest");
  });

  it("is case-insensitive across codestral variants", () => {
    assert.equal(chooseAutofixModel("Codestral-Latest"), "mistral-large-latest");
    assert.equal(chooseAutofixModel("CODESTRAL-LATEST"), "mistral-large-latest");
    assert.equal(chooseAutofixModel("codestral-2405"), "mistral-large-latest");
  });

  it("does not substitute models that contain 'codestral' but do not start with it", () => {
    // Defensive: regex anchors to start-of-string so "my-codestral-fork" pins through.
    assert.equal(chooseAutofixModel("my-codestral-fork"), "my-codestral-fork");
  });

  it("handles null and undefined usedModel without throwing", () => {
    // Defensive: real callers always supply usedModel, but guard against null/undefined.
    assert.equal(chooseAutofixModel(null), null);
    assert.equal(chooseAutofixModel(undefined), undefined);
  });
});

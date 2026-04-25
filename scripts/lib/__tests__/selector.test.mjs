// selector.test.mjs — Unit tests for the 2026-04-24 fleet-idle fix.
//
// Covers the pure helpers added to fix the task_not_allowed loop that
// skipped every dispatch cycle for 22h across the fleet.
//
// Integration tests for the corrective-retry flow require mocking Gemini
// plus filesystem-backed buildProjectContext. Deferred to Phase C (memfs +
// nock harness per HARDENING-synthesis-gemini-2026-04-24.md).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskAlias, isQuotaExhausted } from "../selector.mjs";

describe("normalizeTaskAlias", () => {
  const allowed = ["test", "typecheck", "audit", "tests-gen", "docs-gen", "session-log"];

  it("returns the task verbatim when it's already in the allowed list", () => {
    assert.equal(normalizeTaskAlias("audit", allowed), "audit");
    assert.equal(normalizeTaskAlias("tests-gen", allowed), "tests-gen");
  });

  it("normalizes underscore -> hyphen (Gemini hallucinating class name)", () => {
    // This is the actual bug: Gemini Flash emitted "tests_gen" (class name
    // from router.mjs TASK_TO_CLASS) instead of "tests-gen" (task name).
    assert.equal(normalizeTaskAlias("tests_gen", allowed), "tests-gen");
    assert.equal(normalizeTaskAlias("docs_gen", allowed), "docs-gen");
    assert.equal(normalizeTaskAlias("session_log", allowed), "session-log");
  });

  it("normalizes hyphen -> underscore when allowed list uses underscores", () => {
    const underscoreAllowed = ["tests_gen", "docs_gen"];
    assert.equal(normalizeTaskAlias("tests-gen", underscoreAllowed), "tests_gen");
    assert.equal(normalizeTaskAlias("docs-gen", underscoreAllowed), "docs_gen");
  });

  it("returns null when no alias form matches", () => {
    assert.equal(normalizeTaskAlias("refactor", allowed), null);
    assert.equal(normalizeTaskAlias("nonexistent-task", allowed), null);
  });

  it("returns null for empty allowed list", () => {
    assert.equal(normalizeTaskAlias("audit", []), null);
  });

  it("handles empty task string", () => {
    assert.equal(normalizeTaskAlias("", allowed), null);
  });

  it("is case-sensitive (does not normalize case)", () => {
    assert.equal(normalizeTaskAlias("Audit", allowed), null);
    assert.equal(normalizeTaskAlias("TEST", allowed), null);
  });
});

// Quota-exhausted detection on Gemini 429 errors. The fleet runs on a free-tier
// API key (1500 RPD); when that bucket drains it stays drained until midnight
// PT. We need to skip the 14s of retries that the per-minute throttle handler
// would otherwise burn, and surface a distinct cause so alerting can degrade.
describe("isQuotaExhausted", () => {
  it("returns true for RESOURCE_EXHAUSTED status code in message", () => {
    const err = { status: 429, message: "Got status: RESOURCE_EXHAUSTED. {error: ...}" };
    assert.equal(isQuotaExhausted(err), true);
  });

  it("returns true when errorDetails contains free-tier quota metric", () => {
    const err = {
      status: 429,
      message: "429 quota exceeded",
      errorDetails: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }] }],
    };
    assert.equal(isQuotaExhausted(err), true);
  });

  it("returns true when response.data references PerDayPerProjectPerModel", () => {
    const err = {
      status: 429,
      message: "Too Many Requests",
      response: { data: { error: { details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] } } },
    };
    assert.equal(isQuotaExhausted(err), true);
  });

  it("returns false for transient 429 with no quota markers", () => {
    const err = { status: 429, message: "Rate limit exceeded, try again later" };
    assert.equal(isQuotaExhausted(err), false);
  });

  it("returns false for null / empty error", () => {
    assert.equal(isQuotaExhausted(null), false);
    assert.equal(isQuotaExhausted(undefined), false);
    assert.equal(isQuotaExhausted({}), false);
  });
});

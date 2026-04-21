// track-merges.test.mjs — Unit tests for merge tracker pure functions.
// Uses Node built-in test runner (node:test + node:assert/strict). Zero deps.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseBranchName, classifyBranch, computeAggregates } from "../../track-merges.mjs";
import { getMergeRateContext } from "../context.mjs";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// parseBranchName
// ---------------------------------------------------------------------------

describe("parseBranchName", () => {
  it("parses a simple branch name", () => {
    const result = parseBranchName("origin/auto/combo-audit-20260420120000", "combo");
    assert.deepStrictEqual(result, {
      task: "audit",
      taskClass: "audit",
      timestamp: "20260420120000",
    });
  });

  it("parses a hyphenated slug (burn-wizard)", () => {
    const result = parseBranchName("origin/auto/burn-wizard-test-20260420120000", "burn-wizard");
    assert.deepStrictEqual(result, {
      task: "test",
      taskClass: "local",
      timestamp: "20260420120000",
    });
  });

  it("parses a hyphenated task (self-audit)", () => {
    const result = parseBranchName(
      "origin/auto/sandbox-workflow-enhancement-self-audit-20260421013218",
      "sandbox-workflow-enhancement"
    );
    assert.deepStrictEqual(result, {
      task: "self-audit",
      taskClass: "audit",
      timestamp: "20260421013218",
    });
  });

  it("parses a hyphenated task (roadmap-review)", () => {
    const result = parseBranchName(
      "origin/auto/sandbox-workflow-enhancement-roadmap-review-20260421005218",
      "sandbox-workflow-enhancement"
    );
    assert.deepStrictEqual(result, {
      task: "roadmap-review",
      taskClass: "research",
      timestamp: "20260421005218",
    });
  });

  it("returns null for non-matching slug", () => {
    const result = parseBranchName("origin/auto/combo-audit-20260420120000", "burn-wizard");
    assert.strictEqual(result, null);
  });

  it("returns null for non-auto branch", () => {
    const result = parseBranchName("origin/main", "combo");
    assert.strictEqual(result, null);
  });

  it("returns null for branch with no timestamp", () => {
    const result = parseBranchName("origin/auto/combo-audit", "combo");
    assert.strictEqual(result, null);
  });

  it("strips origin/ prefix", () => {
    const withOrigin = parseBranchName("origin/auto/combo-audit-20260420120000", "combo");
    const withoutOrigin = parseBranchName("auto/combo-audit-20260420120000", "combo");
    assert.deepStrictEqual(withOrigin, withoutOrigin);
  });

  it("returns unknown taskClass for unmapped tasks", () => {
    const result = parseBranchName("origin/auto/combo-mystery-20260420120000", "combo");
    assert.strictEqual(result.taskClass, "unknown");
  });
});

// ---------------------------------------------------------------------------
// classifyBranch
// ---------------------------------------------------------------------------

describe("classifyBranch", () => {
  it("classifies MERGED PR", () => {
    assert.strictEqual(classifyBranch({ state: "MERGED", mergedAt: "2026-04-20T12:00:00Z" }, 2), "merged");
  });

  it("classifies CLOSED PR", () => {
    assert.strictEqual(classifyBranch({ state: "CLOSED" }, 2), "closed");
  });

  it("classifies OPEN PR", () => {
    assert.strictEqual(classifyBranch({ state: "OPEN" }, 2), "open");
  });

  it("classifies no-pr when branch is young", () => {
    assert.strictEqual(classifyBranch(null, 3), "no-pr");
  });

  it("classifies stale when branch is old and no PR", () => {
    assert.strictEqual(classifyBranch(null, 10), "stale");
  });

  it("classifies stale at exactly staleDays boundary", () => {
    // > staleDays, not >=, so exactly 7 is not stale
    assert.strictEqual(classifyBranch(null, 7), "no-pr");
    assert.strictEqual(classifyBranch(null, 7.1), "stale");
  });

  it("uses custom staleDays", () => {
    assert.strictEqual(classifyBranch(null, 3, 2), "stale");
    assert.strictEqual(classifyBranch(null, 1, 2), "no-pr");
  });
});

// ---------------------------------------------------------------------------
// computeAggregates
// ---------------------------------------------------------------------------

describe("computeAggregates", () => {
  it("computes rates for mixed statuses", () => {
    const branches = [
      { project: "combo", taskClass: "audit", status: "merged" },
      { project: "combo", taskClass: "audit", status: "merged" },
      { project: "combo", taskClass: "audit", status: "closed" },
      { project: "combo", taskClass: "explore", status: "open" },
      { project: "burn-wizard", taskClass: "audit", status: "stale" },
    ];
    const agg = computeAggregates(branches);

    assert.strictEqual(agg.byProject.combo.total, 4);
    assert.strictEqual(agg.byProject.combo.merged, 2);
    assert.strictEqual(agg.byProject.combo.rate, 0.5);

    assert.strictEqual(agg.byProject["burn-wizard"].total, 1);
    assert.strictEqual(agg.byProject["burn-wizard"].stale, 1);

    assert.strictEqual(agg.byTaskClass.audit.total, 4);
    assert.strictEqual(agg.byTaskClass.audit.merged, 2);

    assert.strictEqual(agg.byProjectAndClass["combo|audit"].merged, 2);
    assert.strictEqual(agg.byProjectAndClass["combo|audit"].rate, 0.67);
  });

  it("handles empty array", () => {
    const agg = computeAggregates([]);
    assert.deepStrictEqual(agg.byProject, {});
    assert.deepStrictEqual(agg.byTaskClass, {});
    assert.deepStrictEqual(agg.byProjectAndClass, {});
  });

  it("rounds rate to 2 decimal places", () => {
    const branches = [
      { project: "x", taskClass: "a", status: "merged" },
      { project: "x", taskClass: "a", status: "open" },
      { project: "x", taskClass: "a", status: "open" },
    ];
    const agg = computeAggregates(branches);
    assert.strictEqual(agg.byProject.x.rate, 0.33);
  });
});

// ---------------------------------------------------------------------------
// getMergeRateContext
// ---------------------------------------------------------------------------

describe("getMergeRateContext", () => {
  const tmpDir = resolve(tmpdir(), `merge-test-${Date.now()}`);
  const trackerPath = resolve(tmpDir, "merge-tracker.json");

  before(() => mkdirSync(tmpDir, { recursive: true }));
  after(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("returns fallback when file missing", () => {
    const result = getMergeRateContext("combo", resolve(tmpDir, "nonexistent.json"));
    assert.strictEqual(result, "(no merge data yet)");
  });

  it("returns fallback when file is invalid JSON", () => {
    writeFileSync(trackerPath, "not json");
    const result = getMergeRateContext("combo", trackerPath);
    assert.strictEqual(result, "(merge data unreadable)");
  });

  it("returns fallback when no matching project data", () => {
    writeFileSync(trackerPath, JSON.stringify({
      aggregates: { byProjectAndClass: { "other|audit": { merged: 1, total: 2, rate: 0.5 } } },
    }));
    const result = getMergeRateContext("combo", trackerPath);
    assert.strictEqual(result, "(no auto-branches tracked)");
  });

  it("formats merge rate for matching project", () => {
    writeFileSync(trackerPath, JSON.stringify({
      aggregates: {
        byProjectAndClass: {
          "combo|audit": { merged: 3, total: 5, rate: 0.6 },
          "combo|explore": { merged: 0, total: 2, rate: 0 },
          "other|audit": { merged: 1, total: 1, rate: 1 },
        },
      },
    }));
    const result = getMergeRateContext("combo", trackerPath);
    assert.ok(result.includes("audit: 3/5 merged (60%)"));
    assert.ok(result.includes("explore: 0/2 merged (0%)"));
    assert.ok(!result.includes("other"));
  });

});

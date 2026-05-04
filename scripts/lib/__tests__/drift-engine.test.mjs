// drift-engine.test.mjs — unit tests for M4 drift detector pure functions.
// Mirrors the node:test + assert/strict shape of circuit-breaker.test.mjs.
// All tests are pure-function assertions; no I/O, no ONNX, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  freshDriftState,
  cosineDist,
  updateEma,
  evaluateDrift,
  extractSummaryText,
} from "../drift-engine.mjs";

// ── Helpers ──

const ZERO_VEC  = new Float32Array(4).fill(0);
const UNIT_X    = new Float32Array([1, 0, 0, 0]);
const UNIT_Y    = new Float32Array([0, 1, 0, 0]);
const UNIT_XY   = new Float32Array([1, 1, 0, 0]); // 45° from X and Y
const IDENTICAL = new Float32Array([1, 2, 3, 4]);

// ── freshDriftState ──

describe("freshDriftState()", () => {
  it("returns null ema_baseline", () => {
    assert.equal(freshDriftState().ema_baseline, null);
  });

  it("returns null last_distance", () => {
    assert.equal(freshDriftState().last_distance, null);
  });

  it("returns zero trip_count", () => {
    assert.equal(freshDriftState().trip_count, 0);
  });

  it("returns null last_trip_ts", () => {
    assert.equal(freshDriftState().last_trip_ts, null);
  });
});

// ── cosineDist ──

describe("cosineDist()", () => {
  it("identical vectors → 0", () => {
    const d = cosineDist(IDENTICAL, IDENTICAL);
    assert.ok(Math.abs(d) < 1e-6, `expected ~0, got ${d}`);
  });

  it("orthogonal vectors → 1", () => {
    const d = cosineDist(UNIT_X, UNIT_Y);
    assert.ok(Math.abs(d - 1) < 1e-6, `expected ~1, got ${d}`);
  });

  it("zero-magnitude vecA → 0 (fail-soft)", () => {
    assert.equal(cosineDist(ZERO_VEC, UNIT_X), 0);
  });

  it("zero-magnitude vecB → 0 (fail-soft)", () => {
    assert.equal(cosineDist(UNIT_X, ZERO_VEC), 0);
  });

  it("45° angle (UNIT_X vs UNIT_XY) → ~0.293", () => {
    const d = cosineDist(UNIT_X, UNIT_XY);
    // cos(45°) = 1/√2 ≈ 0.7071; distance = 1 - 0.7071 ≈ 0.2929
    assert.ok(Math.abs(d - 0.2929) < 0.001, `expected ~0.293, got ${d}`);
  });

  it("returns value in [0, 1] for arbitrary non-zero vectors", () => {
    const a = new Float32Array([3, 1, 4, 1]);
    const b = new Float32Array([1, 5, 9, 2]);
    const d = cosineDist(a, b);
    assert.ok(d >= 0 && d <= 1, `expected [0,1], got ${d}`);
  });
});

// ── updateEma ──

describe("updateEma()", () => {
  it("null baseline seeds from newVec (first observation)", () => {
    const result = updateEma(null, UNIT_X, 0.05);
    assert.ok(result instanceof Float32Array);
    assert.deepEqual(Array.from(result), Array.from(UNIT_X));
  });

  it("alpha=0 preserves baseline (no update)", () => {
    const result = updateEma(UNIT_X, UNIT_Y, 0);
    assert.deepEqual(Array.from(result), Array.from(UNIT_X));
  });

  it("alpha=1 replaces baseline with newVec", () => {
    const result = updateEma(UNIT_X, UNIT_Y, 1);
    assert.deepEqual(Array.from(result), Array.from(UNIT_Y));
  });

  it("fractional alpha interpolates correctly (α=0.5)", () => {
    const base = new Float32Array([0, 0, 0, 0]);
    const new_ = new Float32Array([2, 2, 2, 2]);
    const result = updateEma(base, new_, 0.5);
    // ema = 0 + 0.5*(2-0) = 1 for each element
    assert.deepEqual(Array.from(result), [1, 1, 1, 1]);
  });

  it("returns Float32Array", () => {
    assert.ok(updateEma(UNIT_X, UNIT_Y, 0.05) instanceof Float32Array);
  });
});

// ── evaluateDrift ──

describe("evaluateDrift()", () => {
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");

  it("first call (null baseline) never trips, seeds EMA", () => {
    const state = freshDriftState();
    const { tripped, distance, newState } = evaluateDrift(state, UNIT_X, { now: fixedNow });
    assert.equal(tripped, false);
    assert.equal(distance, null);
    assert.ok(newState.ema_baseline !== null);
    assert.equal(newState.trip_count, 0);
    assert.equal(newState.last_trip_ts, null);
  });

  it("below-threshold call doesn't trip, updates EMA", () => {
    // Seed baseline with UNIT_X, then submit a nearly-identical vector.
    const seeded = evaluateDrift(freshDriftState(), UNIT_X, { now: fixedNow }).newState;
    const nearX = new Float32Array([0.9999, 0.0001, 0, 0]);
    const { tripped, distance, newState } = evaluateDrift(seeded, nearX, { threshold: 0.15, now: fixedNow });
    assert.equal(tripped, false);
    assert.ok(distance !== null && distance < 0.15);
    assert.equal(newState.trip_count, 0);
  });

  it("above-threshold call trips, increments trip_count, records timestamp", () => {
    // Seed baseline with UNIT_X, then submit orthogonal UNIT_Y (distance ≈ 1).
    const seeded = evaluateDrift(freshDriftState(), UNIT_X, { now: fixedNow }).newState;
    const { tripped, distance, newState } = evaluateDrift(seeded, UNIT_Y, { threshold: 0.15, now: fixedNow });
    assert.equal(tripped, true);
    assert.ok(distance > 0.15);
    assert.equal(newState.trip_count, 1);
    assert.equal(newState.last_trip_ts, fixedNow.toISOString());
  });

  it("trip_count accumulates across multiple trips", () => {
    let state = freshDriftState();
    // Seed baseline with UNIT_X.
    state = evaluateDrift(state, UNIT_X, { now: fixedNow }).newState;
    // Two consecutive orthogonal submits.
    state = evaluateDrift(state, UNIT_Y, { threshold: 0.15, now: fixedNow }).newState;
    state = evaluateDrift(state, UNIT_Y, { threshold: 0.15, now: fixedNow }).newState;
    assert.equal(state.trip_count, 2);
  });

  it("non-trip call preserves last_trip_ts from prior trip", () => {
    let state = freshDriftState();
    state = evaluateDrift(state, UNIT_X, { now: fixedNow }).newState;
    // Trip.
    state = evaluateDrift(state, UNIT_Y, { threshold: 0.15, now: fixedNow }).newState;
    const savedTs = state.last_trip_ts;
    // Non-trip (near-identical to current EMA — note EMA has drifted toward UNIT_Y after 1 trip).
    const later = new Date("2026-05-03T13:00:00.000Z");
    state = evaluateDrift(state, state.ema_baseline, { threshold: 0.15, now: later }).newState;
    // No new trip — timestamp should be unchanged.
    assert.equal(state.last_trip_ts, savedTs);
  });
});

// ── extractSummaryText ──

describe("extractSummaryText()", () => {
  it("empty array returns empty string", () => {
    assert.equal(extractSummaryText([]), "");
  });

  it("entries without usable fields return empty string", () => {
    assert.equal(extractSummaryText([{ outcome: "success" }, { phase: "auto-push" }]), "");
  });

  it("extracts summary field", () => {
    const result = extractSummaryText([{ summary: "fixed a bug" }]);
    assert.ok(result.includes("fixed a bug"));
  });

  it("extracts pr_title and rationale fields", () => {
    const result = extractSummaryText([{ pr_title: "refactor auth", rationale: "reduces coupling" }]);
    assert.ok(result.includes("refactor auth"));
    assert.ok(result.includes("reduces coupling"));
  });

  it("extracts task field", () => {
    const result = extractSummaryText([{ task: "docs_gen" }]);
    assert.ok(result.includes("docs_gen"));
  });

  it("respects limit parameter (default 20)", () => {
    // Create 25 entries; only the last 20 should appear.
    const entries = Array.from({ length: 25 }, (_, i) => ({ summary: `entry-${i}` }));
    const result = extractSummaryText(entries, 20);
    assert.ok(result.includes("entry-24"), "should include last entry");
    assert.ok(!result.includes("entry-4"),  "should not include early entries");
  });

  it("concatenates multiple fields from multiple entries with newlines", () => {
    const entries = [
      { summary: "line one" },
      { pr_title: "line two" },
    ];
    const result = extractSummaryText(entries);
    assert.ok(result.includes("line one"));
    assert.ok(result.includes("line two"));
    assert.ok(result.includes("\n"));
  });

  it("ignores non-string or empty-string values", () => {
    const entries = [{ summary: 42 }, { pr_title: "" }, { rationale: "   " }, { task: "real" }];
    const result = extractSummaryText(entries);
    assert.ok(!result.includes("42"));
    assert.ok(result.includes("real"));
  });
});

// health.test.mjs — Unit tests for health.mjs state machine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHealth } from "../health.mjs";
import { writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(resolve(tmpdir(), "health-test-"));

function writeLog(entries) {
  const path = resolve(TMP, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, lines);
  return path;
}

function ago(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

describe("computeHealth — state machine", () => {
  it("returns unknown when log is unreadable", () => {
    const h = computeHealth("/nonexistent/log.jsonl");
    assert.equal(h.state, "unknown");
    assert.equal(h.reason, "log unreadable");
  });

  it("returns healthy with recent successes", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
      { outcome: "success", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.equal(h.reason, "ok");
  });

  it("returns down after 3 consecutive errors", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(2) },
      { outcome: "error", ts: ago(1.5) },
      { outcome: "error", ts: ago(1) },
      { outcome: "error", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "down");
    assert.match(h.reason, /3 consecutive errors/);
  });

  it("skips over skipped/dry-run entries in error streak", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(2) },
      { outcome: "error", ts: ago(1.5) },
      { outcome: "skipped", ts: ago(1.2) },
      { outcome: "dry-run", ts: ago(1) },
      { outcome: "error", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    // Only 2 errors (skipped/dry-run don't break streak but don't count)
    assert.equal(h.state, "healthy");
  });

  it("returns idle when recent entries are all skips and no success in 6+ hours", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(10) },
      { outcome: "skipped", ts: ago(4) },
      { outcome: "skipped", ts: ago(3) },
      { outcome: "skipped", ts: ago(2) },
      { outcome: "skipped", ts: ago(1) },
      { outcome: "skipped", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "idle");
    assert.match(h.reason, /no work found/);
  });

  it("returns down when no success in 6+ hours and recent entries include errors", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(10) },
      { outcome: "skipped", ts: ago(3) },
      { outcome: "error", ts: ago(2) },
      { outcome: "skipped", ts: ago(1) },
      { outcome: "skipped", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "down");
    assert.match(h.reason, /no successful dispatch/);
  });

  it("returns healthy when last success was recent despite errors before it", () => {
    const log = writeLog([
      { outcome: "error", ts: ago(5) },
      { outcome: "error", ts: ago(4) },
      { outcome: "error", ts: ago(3) },
      { outcome: "success", ts: ago(1) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
  });

  it("ignores non-real outcomes (unknown strings)", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
      { outcome: "banana", ts: ago(0.5) },  // not in REAL_OUTCOMES
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
  });

  it("handles empty log gracefully", () => {
    const log = writeLog([]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.equal(h.consecutive_errors, 0);
  });

  it("handles corrupt JSON lines gracefully", () => {
    const path = resolve(TMP, "corrupt.jsonl");
    writeFileSync(path, '{"outcome":"success","ts":"' + ago(1) + '"}\n{broken json\n');
    const h = computeHealth(path);
    assert.equal(h.state, "healthy");
  });

  it("returns correct hours_since_success", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(3) },
    ]);
    const h = computeHealth(log);
    assert.ok(h.hours_since_success >= 2.9 && h.hours_since_success <= 3.1);
  });

  it("returns null hours_since_success when no success on record", () => {
    const log = writeLog([
      { outcome: "skipped", ts: ago(1) },
      { outcome: "skipped", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.hours_since_success, null);
    assert.equal(h.last_success_ts, null);
  });
});

// Fallback-rate degraded rule (C2): a fallback dispatch returns
// outcome=success today, so a sustained Gemini quota outage stays silent in
// the existing alerting layer. This rule classifies the fleet as `degraded`
// when >=50% of the recent window used the deterministic selector fallback,
// catching the "burning free-tier faster than the cron cadence" condition
// Perry asked for a distinct signal on.
describe("computeHealth - fallback-rate rule", () => {
  it("stays healthy when no recent cycles used the fallback", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(2) },
      { outcome: "success", ts: ago(1.5) },
      { outcome: "success", ts: ago(1) },
      { outcome: "success", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.equal(h.selector_fallback_count, 0);
  });

  it("stays healthy when 2 of last 6 cycles used fallback (33%, below threshold)", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(3) },
      { outcome: "success", ts: ago(2.5) },
      { outcome: "success", ts: ago(2), selector_fallback: true },
      { outcome: "success", ts: ago(1.5) },
      { outcome: "success", ts: ago(1), selector_fallback: true },
      { outcome: "success", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.equal(h.selector_fallback_count, 2);
  });

  it("escalates to degraded when 3 of last 6 cycles used fallback (50%)", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(3) },
      { outcome: "success", ts: ago(2.5) },
      { outcome: "success", ts: ago(2), selector_fallback: true },
      { outcome: "success", ts: ago(1.5), selector_fallback: true },
      { outcome: "success", ts: ago(1), selector_fallback: true },
      { outcome: "success", ts: ago(0.5) },
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "degraded");
    assert.equal(h.selector_fallback_count, 3);
    assert.match(h.reason, /selector fallback/);
  });

  it("classifies degraded (not down) when 100% of last 6 cycles used fallback", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(3), selector_fallback: true },
      { outcome: "success", ts: ago(2.5), selector_fallback: true },
      { outcome: "success", ts: ago(2), selector_fallback: true },
      { outcome: "success", ts: ago(1.5), selector_fallback: true },
      { outcome: "success", ts: ago(1), selector_fallback: true },
      { outcome: "success", ts: ago(0.5), selector_fallback: true },
    ]);
    const h = computeHealth(log);
    // Down is reserved for total silence (3 consecutive errors or no success
    // in 6+h with non-benign skips). Sustained fallback alone is degraded.
    assert.equal(h.state, "degraded");
    assert.equal(h.selector_fallback_count, 6);
    assert.match(h.reason, /selector fallback/);
  });
});

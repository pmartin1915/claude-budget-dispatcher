// health.test.mjs — Unit tests for health.mjs state machine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHealth, evaluateNoProgress } from "../health.mjs";
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

// ---------------------------------------------------------------------------
// No-progress detector (Bug D): evaluateNoProgress + computeHealth integration.
//
// Push-phase JSONL entries have phase:"auto-push" and outcome values outside
// REAL_OUTCOMES ("auto-push-success", "auto-push-blocked", etc.). They must
// be visible in the raw entries list passed to evaluateNoProgress.
// ---------------------------------------------------------------------------

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 3_600_000).toISOString();
}

// Build a push-phase JSONL entry. project + outcome are required; ts defaults
// to inside the 3-day window.
function pushEntry(project, outcome, { ts } = {}) {
  return {
    phase: "auto-push",
    engine: "dispatch.mjs",
    project,
    outcome,
    ts: ts ?? daysAgo(1),
  };
}

describe("evaluateNoProgress — pure-function unit tests", () => {
  it("returns stuck:false and empty projects when no push-phase entries exist", () => {
    const result = evaluateNoProgress([], new Date());
    assert.equal(result.stuck, false);
    assert.deepEqual(result.projects, []);
  });

  it("returns stuck:false when attempts < MIN_PUSH_ATTEMPTS (freshly-opted-in project)", () => {
    // 4 blocked entries — below the 5-attempt floor; should not fire.
    const entries = Array.from({ length: 4 }, () =>
      pushEntry("my-project", "auto-push-blocked")
    );
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, false);
    assert.deepEqual(result.projects, []);
  });

  it("returns stuck:true when >= 5 attempts and 0 pushes in 3-day window", () => {
    const entries = Array.from({ length: 7 }, () =>
      pushEntry("sandbox-canary-test", "auto-push-blocked")
    );
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, true);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].project, "sandbox-canary-test");
    assert.equal(result.projects[0].attempts, 7);
    assert.equal(result.projects[0].pushed_count, 0);
  });

  it("returns stuck:false when project has >= 1 successful push in the window", () => {
    const entries = [
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-success"),  // one success
      pushEntry("my-project", "auto-push-blocked"),
    ];
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, false);
    assert.deepEqual(result.projects, []);
  });

  it("excludes auto-push-dry-run entries from attempt count", () => {
    // 4 dry-runs + 1 blocked = only 1 real attempt; should not fire.
    const entries = [
      ...Array.from({ length: 4 }, () => pushEntry("my-project", "auto-push-dry-run")),
      pushEntry("my-project", "auto-push-blocked"),
    ];
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, false);
  });

  it("excludes entries older than 3 calendar days from the window", () => {
    // 6 blocked entries all older than 3 days — out of window, no stuck signal.
    const entries = Array.from({ length: 6 }, () =>
      pushEntry("old-project", "auto-push-blocked", { ts: daysAgo(4) })
    );
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, false);
  });

  it("reports last_attempt_ts as the most-recent entry timestamp", () => {
    const olderTs = daysAgo(2);
    const newerTs = daysAgo(0.5);
    const entries = [
      pushEntry("my-project", "auto-push-blocked", { ts: olderTs }),
      pushEntry("my-project", "auto-push-blocked", { ts: newerTs }),
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-blocked"),
      pushEntry("my-project", "auto-push-blocked"),
    ];
    const result = evaluateNoProgress(entries, new Date());
    assert.equal(result.stuck, true);
    // last_attempt_ts should be the newest timestamp.
    assert.equal(result.projects[0].last_attempt_ts, newerTs);
  });
});

describe("computeHealth — no-progress integration", () => {
  it("flips to degraded when an opted-in project has >= 5 attempts and 0 pushes in 3 days", () => {
    // Mix real-outcome entries (healthy: recent success) with push-phase entries
    // (stuck: 7 blocked attempts on sandbox-canary-test, 0 successes).
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
      ...Array.from({ length: 7 }, () =>
        pushEntry("sandbox-canary-test", "auto-push-blocked")
      ),
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "degraded");
    assert.match(h.reason, /^no-progress:/);
    assert.match(h.reason, /sandbox-canary-test/);
    assert.match(h.reason, /0 pushes/);
    assert.equal(h.no_progress_projects.length, 1);
    assert.equal(h.no_progress_projects[0].project, "sandbox-canary-test");
    assert.equal(h.no_progress_projects[0].attempts, 7);
    assert.equal(h.no_progress_projects[0].pushed_count, 0);
  });

  it("stays healthy when the same project has at least one push success", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
      ...Array.from({ length: 6 }, () =>
        pushEntry("sandbox-canary-test", "auto-push-blocked")
      ),
      pushEntry("sandbox-canary-test", "auto-push-success"),
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.deepEqual(h.no_progress_projects, []);
  });

  it("stays healthy when attempts < 5 (freshly-opted-in project, no false positive)", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
      ...Array.from({ length: 4 }, () =>
        pushEntry("new-project", "auto-push-blocked")
      ),
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "healthy");
    assert.deepEqual(h.no_progress_projects, []);
  });

  it("existing down state takes priority over no-progress (no-progress does not override)", () => {
    // 3 consecutive errors → down. Also has stuck push-phase entries.
    // The no-progress rule must not flip down → degraded.
    const log = writeLog([
      { outcome: "success", ts: ago(2) },
      { outcome: "error", ts: ago(1.5) },
      { outcome: "error", ts: ago(1) },
      { outcome: "error", ts: ago(0.5) },
      ...Array.from({ length: 7 }, () =>
        pushEntry("my-project", "auto-push-blocked")
      ),
    ]);
    const h = computeHealth(log);
    assert.equal(h.state, "down");
    // no_progress_projects is still populated (informational), but state is down.
    assert.ok(Array.isArray(h.no_progress_projects));
  });

  it("returns no_progress_projects as empty array when log is healthy with no push entries", () => {
    const log = writeLog([
      { outcome: "success", ts: ago(1) },
    ]);
    const h = computeHealth(log);
    assert.deepEqual(h.no_progress_projects, []);
  });
});

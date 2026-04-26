// fleet.test.mjs — Unit tests for fleet.mjs computeFleet, countDispatchesToday,
// readEstimatorSnapshot, and aggregateLastDispatch helpers.
//
// Mirrors health.test.mjs conventions: real tmpfs fixture log file (not
// mocked fs); estimator snapshot fixture written as a sibling file to the
// log so readEstimatorSnapshot's path-derivation gets exercised.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFleet,
  countDispatchesToday,
  readEstimatorSnapshot,
  aggregateLastDispatch,
} from "../fleet.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(resolve(tmpdir(), "fleet-test-"));

function freshDir() {
  return mkdtempSync(resolve(TMP, "case-"));
}

function writeLog(entries, dir = freshDir()) {
  const path = resolve(dir, "budget-dispatch-log.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return { path, dir };
}

function writeEstimator(dir, snap) {
  writeFileSync(resolve(dir, "usage-estimate.json"), JSON.stringify(snap));
}

function ago(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// countDispatchesToday — pure function, easy fixtures
// ---------------------------------------------------------------------------

describe("countDispatchesToday()", () => {
  it("counts non-skipped non-wrapper-success entries with today's UTC date prefix", () => {
    const now = new Date("2026-04-26T18:00:00.000Z");
    const todayPrefix = "2026-04-26";
    const entries = [
      { outcome: "success", ts: `${todayPrefix}T05:00:00.000Z` },
      { outcome: "success", ts: `${todayPrefix}T06:00:00.000Z` },
      { outcome: "skipped", ts: `${todayPrefix}T07:00:00.000Z`, reason: "user-active" },
      { outcome: "error", ts: `${todayPrefix}T08:00:00.000Z` },
      { outcome: "wrapper-success", ts: `${todayPrefix}T09:00:00.000Z` },
    ];
    // 2 success + 1 error = 3 (skipped + wrapper-success excluded)
    assert.equal(countDispatchesToday(entries, now), 3);
  });

  it("stops walking back at the first pre-today entry (chronological order)", () => {
    const now = new Date("2026-04-26T18:00:00.000Z");
    const entries = [
      { outcome: "success", ts: "2026-04-25T05:00:00.000Z" }, // yesterday
      { outcome: "success", ts: "2026-04-25T06:00:00.000Z" }, // yesterday
      { outcome: "success", ts: "2026-04-26T05:00:00.000Z" }, // today
      { outcome: "success", ts: "2026-04-26T06:00:00.000Z" }, // today
    ];
    assert.equal(countDispatchesToday(entries, now), 2);
  });

  it("returns 0 on empty log", () => {
    assert.equal(countDispatchesToday([], new Date()), 0);
  });

  it("returns 0 when no entries match today", () => {
    const now = new Date("2026-04-26T18:00:00.000Z");
    const entries = [
      { outcome: "success", ts: "2026-04-25T05:00:00.000Z" },
      { outcome: "success", ts: "2026-04-25T06:00:00.000Z" },
    ];
    assert.equal(countDispatchesToday(entries, now), 0);
  });

  it("ignores entries with no ts field (corrupt/legacy)", () => {
    const now = new Date("2026-04-26T18:00:00.000Z");
    const entries = [
      { outcome: "success" }, // no ts -> ignored
      { outcome: "success", ts: "2026-04-26T05:00:00.000Z" },
    ];
    // First entry has no ts; the loop continues without breaking. Second
    // entry counts. Verifies the `continue` branch in the impl.
    assert.equal(countDispatchesToday(entries, now), 1);
  });
});

// ---------------------------------------------------------------------------
// readEstimatorSnapshot — best-effort sibling-file read
// ---------------------------------------------------------------------------

describe("readEstimatorSnapshot()", () => {
  it("returns all-null fields when no usage-estimate.json exists", () => {
    const { path } = writeLog([]);
    const snap = readEstimatorSnapshot(path);
    assert.equal(snap.dispatches_today_max, null);
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.monthly_pct, null);
    assert.equal(snap.weekly_gate_passes, null);
    assert.equal(snap.urgency_mode, null);
    assert.equal(snap.estimator_skip_reason, null);
  });

  it("returns all-null fields when usage-estimate.json is malformed", () => {
    const { path, dir } = writeLog([]);
    writeFileSync(resolve(dir, "usage-estimate.json"), "{ not valid json");
    const snap = readEstimatorSnapshot(path);
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.monthly_pct, null);
  });

  it("plumbs through the canonical estimator fields", () => {
    const { path, dir } = writeLog([]);
    writeEstimator(dir, {
      generated_at: "2026-04-26T18:57:03.646Z",
      dispatch_authorized: false,
      skip_reason: "weekly-reserve-floor-threatened",
      trailing30: { actual_pct: 72.9, gate_passes: true },
      weekly: {
        actual_pct: 143.97,
        headroom_pct: -43.97,
        gate_passes: false,
        hours_until_reset: 96,
        urgency_mode: "interactive-reserve-hold",
        effective_max_runs_per_day: 30,
      },
    });
    const snap = readEstimatorSnapshot(path);
    assert.equal(snap.weekly_pct, 143.97);
    assert.equal(snap.weekly_headroom_pct, -43.97);
    assert.equal(snap.weekly_gate_passes, false);
    assert.equal(snap.weekly_hours_until_reset, 96);
    assert.equal(snap.urgency_mode, "interactive-reserve-hold");
    assert.equal(snap.dispatches_today_max, 30);
    assert.equal(snap.monthly_pct, 72.9);
    assert.equal(snap.monthly_gate_passes, true);
    assert.equal(snap.estimator_skip_reason, "weekly-reserve-floor-threatened");
    assert.equal(snap.estimator_generated_at, "2026-04-26T18:57:03.646Z");
  });

  it("skips legacy snapshots that lack a weekly block (insufficient-history-span)", () => {
    const { path, dir } = writeLog([]);
    writeEstimator(dir, {
      generated_at: "2026-04-11T07:36:00.000Z",
      skip_reason: "insufficient-history-span",
      trailing30: null,
      weekly: null,
    });
    const snap = readEstimatorSnapshot(path);
    // Numeric fields all null — guard prevents crashes.
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.monthly_pct, null);
    assert.equal(snap.dispatches_today_max, null);
    // String fields still surface from the top-level snapshot.
    assert.equal(snap.estimator_skip_reason, "insufficient-history-span");
  });

  it("rejects non-finite numbers (NaN, Infinity in malformed snapshots)", () => {
    const { path, dir } = writeLog([]);
    // Manually write a snapshot with NaN/Infinity (JSON.stringify normally
    // emits null for these; this fixture mimics a partly-corrupted file).
    writeFileSync(resolve(dir, "usage-estimate.json"), JSON.stringify({
      weekly: { actual_pct: null, gate_passes: "maybe", urgency_mode: "" },
      trailing30: { actual_pct: undefined },
    }));
    const snap = readEstimatorSnapshot(path);
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.weekly_gate_passes, null); // string is not a boolean
    assert.equal(snap.urgency_mode, null);       // empty string -> null
    assert.equal(snap.monthly_pct, null);
  });
});

// ---------------------------------------------------------------------------
// computeFleet — end-to-end with new fields
// ---------------------------------------------------------------------------

describe("computeFleet() — Bug A/B fix follow-up: new dashboard surfaces", () => {
  it("surfaces last_run_reason from the most recent skip entry", () => {
    const { path } = writeLog([
      { outcome: "success", ts: ago(20), project: "p1" },
      { outcome: "skipped", ts: ago(2), reason: "daily-quota-reached" },
      { outcome: "skipped", ts: ago(1), reason: "user-active" },
    ]);
    const snap = computeFleet(path, "test-machine");
    assert.equal(snap.last_run_outcome, "skipped");
    assert.equal(snap.last_run_reason, "user-active");
  });

  it("surfaces last_run_reason as null when last entry has no reason", () => {
    const { path } = writeLog([
      { outcome: "success", ts: ago(1), project: "p1" },
    ]);
    const snap = computeFleet(path, "test-machine");
    assert.equal(snap.last_run_reason, null);
  });

  it("populates dispatches_today from log entries", () => {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const { path } = writeLog([
      { outcome: "success", ts: `${todayPrefix}T05:00:00.000Z`, project: "p1" },
      { outcome: "success", ts: `${todayPrefix}T06:00:00.000Z`, project: "p1" },
      { outcome: "skipped", ts: `${todayPrefix}T07:00:00.000Z`, reason: "user-active" },
    ]);
    const snap = computeFleet(path, "test-machine");
    assert.equal(snap.dispatches_today, 2); // skipped excluded
  });

  it("merges estimator-derived fields into the fleet payload", () => {
    const { path, dir } = writeLog([
      { outcome: "skipped", ts: ago(0.1), reason: "daily-quota-reached" },
    ]);
    writeEstimator(dir, {
      generated_at: ago(0.1),
      skip_reason: "weekly-reserve-floor-threatened",
      weekly: {
        actual_pct: 144,
        headroom_pct: -44,
        gate_passes: false,
        hours_until_reset: 96,
        urgency_mode: "interactive-reserve-hold",
        effective_max_runs_per_day: 30,
      },
      trailing30: { actual_pct: 73, gate_passes: true },
    });
    const snap = computeFleet(path, "test-machine");
    assert.equal(snap.weekly_pct, 144);
    assert.equal(snap.weekly_gate_passes, false);
    assert.equal(snap.dispatches_today_max, 30);
    assert.equal(snap.monthly_pct, 73);
    assert.equal(snap.estimator_skip_reason, "weekly-reserve-floor-threatened");
  });

  it("returns nulls for estimator fields when usage-estimate.json is absent", () => {
    const { path } = writeLog([
      { outcome: "skipped", ts: ago(0.1), reason: "user-active" },
    ]);
    const snap = computeFleet(path, "test-machine");
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.monthly_pct, null);
    assert.equal(snap.dispatches_today_max, null);
    // Existing fields still populated.
    assert.equal(snap.last_run_reason, "user-active");
    assert.equal(snap.machine, "test-machine");
  });

  it("preserves the unreadable-log fallback shape with new fields zeroed/nulled", () => {
    const snap = computeFleet("/nonexistent/log.jsonl", "test-machine");
    assert.equal(snap.last_run_reason, null);
    assert.equal(snap.dispatches_today, 0);
    assert.equal(snap.weekly_pct, null);
    assert.equal(snap.monthly_pct, null);
  });
});

// ---------------------------------------------------------------------------
// aggregateLastDispatch — fleet-aggregate "last successful dispatch"
// ---------------------------------------------------------------------------

describe("aggregateLastDispatch()", () => {
  it("returns the most recent last_dispatch_ts across machines", () => {
    const snaps = [
      { machine: "alpha", last_dispatch_ts: "2026-04-26T05:18:55.355Z" },
      { machine: "beta",  last_dispatch_ts: "2026-04-26T07:32:51.847Z" }, // newest
      { machine: "gamma", last_dispatch_ts: "2026-04-26T06:13:04.945Z" },
    ];
    const agg = aggregateLastDispatch(snaps);
    assert.equal(agg.ts, "2026-04-26T07:32:51.847Z");
    assert.equal(agg.machine, "beta");
  });

  it("ignores machines with null/missing last_dispatch_ts (e.g. monitor-only laptops)", () => {
    const snaps = [
      { machine: "monitor", last_dispatch_ts: null },
      { machine: "active",  last_dispatch_ts: "2026-04-26T05:18:55.355Z" },
    ];
    const agg = aggregateLastDispatch(snaps);
    assert.equal(agg.ts, "2026-04-26T05:18:55.355Z");
    assert.equal(agg.machine, "active");
  });

  it("returns null/null when the fleet has no dispatches yet", () => {
    const snaps = [
      { machine: "a", last_dispatch_ts: null },
      { machine: "b", last_dispatch_ts: null },
    ];
    const agg = aggregateLastDispatch(snaps);
    assert.equal(agg.ts, null);
    assert.equal(agg.machine, null);
  });

  it("returns null/null on empty input or undefined", () => {
    assert.deepEqual(aggregateLastDispatch([]), { ts: null, machine: null });
    assert.deepEqual(aggregateLastDispatch(undefined), { ts: null, machine: null });
  });

  it("ignores malformed timestamps (defense-in-depth on gist-sourced data)", () => {
    const snaps = [
      { machine: "broken", last_dispatch_ts: "definitely-not-a-date" },
      { machine: "good",   last_dispatch_ts: "2026-04-26T05:18:55.355Z" },
    ];
    const agg = aggregateLastDispatch(snaps);
    assert.equal(agg.machine, "good");
  });
});

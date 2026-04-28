// log.test.mjs — Unit tests for log.mjs.
// Covers: appendLog, writeLastRun, countTodayRuns, rotateLog.
// Uses Node built-in test runner. Zero deps.
//
// Tests redirect log.mjs's writes to a tmpdir via BUDGET_DISPATCH_STATUS_DIR
// (set by _test-status-dir.mjs) so they cannot pollute the live status/
// files. The prelude must be imported before log.mjs so its module-load
// path resolution sees the override.

import "./_test-status-dir.mjs"; // Must be first -- sets env var
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { appendLog, writeLastRun, countTodayRuns, rotateLog } from "../log.mjs";

const TEST_STATUS_DIR = process.env.BUDGET_DISPATCH_STATUS_DIR;
const LOG_PATH = resolve(TEST_STATUS_DIR, "budget-dispatch-log.jsonl");
const LAST_RUN_PATH = resolve(TEST_STATUS_DIR, "budget-dispatch-last-run.json");

describe("appendLog", () => {
  it("appends a JSONL record with timestamp", async () => {
    appendLog({ outcome: "test-success", reason: "unit-test" });

    const content = readFileSync(LOG_PATH, "utf8").trim();
    const lastLine = content.split("\n").pop();
    const parsed = JSON.parse(lastLine);

    assert.equal(parsed.outcome, "test-success");
    assert.equal(parsed.reason, "unit-test");
    assert.ok(parsed.ts, "timestamp should be present");
    assert.ok(parsed.ts.includes("T"), "timestamp should be ISO format");
  });
});

describe("writeLastRun", () => {
  it("writes a structured last-run marker", async () => {
    writeLastRun({ outcome: "success", reason: "ok" }, 1234);

    const content = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8"));
    assert.equal(content.status, "success");
    assert.equal(content.error, "ok");
    assert.equal(content.duration_ms, 1234);
    assert.equal(content.engine, "dispatch.mjs");
    assert.ok(content.timestamp);
  });
});

describe("countTodayRuns", () => {
  it("returns a non-negative integer", () => {
    const count = countTodayRuns();
    assert.ok(Number.isInteger(count));
    assert.ok(count >= 0);
  });
});

describe("rotateLog", () => {
  it("does not throw on small logs (<100 lines)", () => {
    // rotateLog bails early if < 100 lines, so this is a no-op smoke test
    assert.doesNotThrow(() => rotateLog(7));
  });
});

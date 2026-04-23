// log.test.mjs — Unit tests for log.mjs.
// Covers: appendLog, writeLastRun, countTodayRuns, rotateLog.
// Uses Node built-in test runner. Zero deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { appendLog, writeLastRun, countTodayRuns, rotateLog } from "../log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = resolve(__dirname, "..", "..", "..", "status");
const LOG_PATH = resolve(STATUS_DIR, "budget-dispatch-log.jsonl");
const LAST_RUN_PATH = resolve(STATUS_DIR, "budget-dispatch-last-run.json");

// ---------------------------------------------------------------------------
// Tests against the real status/ directory (safe — only appends)
// ---------------------------------------------------------------------------

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

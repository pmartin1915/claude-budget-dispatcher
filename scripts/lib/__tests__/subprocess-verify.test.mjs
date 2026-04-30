// subprocess-verify.test.mjs — Tests for P0-1 subprocess verification wrapper.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifiedExec } from "../subprocess-verify.mjs";

describe("verifiedExec", () => {
  // Use `node -e` as a portable test command that works on all platforms.
  const nodeExe = process.execPath;

  it("returns verified=true when command succeeds and no markers are required", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.log('hello')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      settleMs: 50,
    });

    assert.equal(result.verified, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("hello"));
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.verificationFailures, 0);
  });

  it("returns verified=true when success marker is found in output", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.log('tests passed: 42')"],
      cwd: process.cwd(),
      successMarkers: [/tests? passed/i],
      timeoutMs: 10_000,
      settleMs: 50,
    });

    assert.equal(result.verified, true);
    assert.ok(result.stdout.includes("tests passed"));
  });

  it("returns verified=false when exit code is 0 but marker is missing", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.log('no marker here')"],
      cwd: process.cwd(),
      successMarkers: [/NEVER_MATCH_THIS_STRING/],
      timeoutMs: 10_000,
      settleMs: 50,
      maxRetries: 0, // no retries for speed
    });

    assert.equal(result.verified, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.verificationFailures, 1);
    assert.equal(result.attempts, 1);
  });

  it("retries on verification failure", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.log('no marker')"],
      cwd: process.cwd(),
      successMarkers: [/NEVER_MATCH/],
      timeoutMs: 10_000,
      settleMs: 50,
      maxRetries: 1,
    });

    assert.equal(result.verified, false);
    assert.equal(result.attempts, 2); // 1 initial + 1 retry
    assert.equal(result.verificationFailures, 2);
  });

  it("returns verified=false immediately on non-zero exit (no retries)", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "process.exit(1)"],
      cwd: process.cwd(),
      successMarkers: [/ok/],
      timeoutMs: 10_000,
      settleMs: 50,
      maxRetries: 2,
    });

    assert.equal(result.verified, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.attempts, 1); // didn't retry on non-zero exit
  });

  it("handles timeout", { timeout: 15_000 }, async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "setTimeout(()=>{},60000)"],
      cwd: process.cwd(),
      timeoutMs: 1000, // short enough to trigger
      settleMs: 50,
      maxRetries: 0,
    });

    assert.equal(result.verified, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  });

  it("handles spawn error for non-existent command", async () => {
    const result = await verifiedExec({
      command: ["__nonexistent_command_xyz__"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      settleMs: 50,
      maxRetries: 0,
    });

    assert.equal(result.verified, false);
    assert.equal(result.spawnError, true);
  });

  it("checks markers in stderr too", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.error('PASS: all tests ok')"],
      cwd: process.cwd(),
      successMarkers: [/PASS/],
      timeoutMs: 10_000,
      settleMs: 50,
    });

    assert.equal(result.verified, true);
  });

  it("populates stdout_tail and stderr_tail (capped at 2000 chars)", async () => {
    const result = await verifiedExec({
      command: [nodeExe, "-e", "console.log('x'.repeat(5000)); console.error('y'.repeat(5000))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      settleMs: 50,
    });

    assert.ok(result.stdout_tail.length <= 2000);
    assert.ok(result.stderr_tail.length <= 2000);
  });
});

// heartbeat.test.mjs — Tests for P1-1 heartbeat telemetry.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHeartbeatPayload, pushHeartbeat, collectEnvHealth, computeTaskHash } from "../heartbeat.mjs";

describe("buildHeartbeatPayload", () => {
  it("returns a well-shaped payload with all fields", () => {
    const payload = buildHeartbeatPayload({
      nodeId: "test-uuid-1234",
      machineName: "testhost",
      currentTaskHash: "abc123",
      envHealth: { gemini_key_set: true },
      driftVelocity: 0.15,
    });

    assert.equal(payload.schema_version, 1);
    assert.equal(payload.node_id, "test-uuid-1234");
    assert.equal(payload.machine, "testhost");
    assert.equal(typeof payload.last_active_timestamp, "number");
    assert.ok(payload.last_active_timestamp > 0);
    assert.equal(payload.current_task_hash, "abc123");
    assert.deepEqual(payload.environmental_health, { gemini_key_set: true });
    assert.equal(payload.drift_velocity, 0.15);
    assert.equal(typeof payload.heartbeat_ts, "string");
    assert.match(payload.heartbeat_ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults current_task_hash to null", () => {
    const payload = buildHeartbeatPayload({
      nodeId: "x",
      machineName: "host",
    });
    assert.equal(payload.current_task_hash, null);
    assert.equal(payload.drift_velocity, null);
    assert.deepEqual(payload.environmental_health, {});
  });

  it("falls back to machineName for node_id when nodeId is null", () => {
    const payload = buildHeartbeatPayload({
      nodeId: null,
      machineName: "fallback-host",
    });
    assert.equal(payload.node_id, "fallback-host");
  });
});

describe("computeTaskHash", () => {
  it("returns a 64-char hex SHA-256", () => {
    const hash = computeTaskHash("burn-wizard", "auto/burn-wizard-audit-20260430", "abc1234");
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const a = computeTaskHash("project", "branch", "sha");
    const b = computeTaskHash("project", "branch", "sha");
    assert.equal(a, b);
  });

  it("differs when any input changes", () => {
    const base = computeTaskHash("p", "b", "c");
    assert.notEqual(computeTaskHash("p2", "b", "c"), base);
    assert.notEqual(computeTaskHash("p", "b2", "c"), base);
    assert.notEqual(computeTaskHash("p", "b", "c2"), base);
  });

  it("defaults commitish to 'uncommitted'", () => {
    const a = computeTaskHash("p", "b");
    const b = computeTaskHash("p", "b", "uncommitted");
    assert.equal(a, b);
  });
});

describe("pushHeartbeat", () => {
  it("returns error when gistId is missing", async () => {
    const result = await pushHeartbeat({}, "", "token");
    assert.equal(result.ok, false);
    assert.match(result.error, /missing/);
  });

  it("returns error when token is missing", async () => {
    const result = await pushHeartbeat({}, "gist-id", "");
    assert.equal(result.ok, false);
    assert.match(result.error, /missing/);
  });
});

describe("collectEnvHealth", () => {
  it("returns an object with key health flags", () => {
    const health = collectEnvHealth();
    assert.equal(typeof health.gemini_key_set, "boolean");
    assert.equal(typeof health.mistral_key_set, "boolean");
    assert.equal(typeof health.github_token_set, "boolean");
    assert.equal(typeof health.platform, "string");
    assert.equal(typeof health.node_version, "string");
  });

  it("never throws", () => {
    assert.doesNotThrow(() => collectEnvHealth());
  });
});

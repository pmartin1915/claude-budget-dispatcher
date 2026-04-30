// sentinel.test.mjs — Tests for P1-2 sentinel dead-node detection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateHeartbeats, runSentinel } from "../sentinel.mjs";

const INTERVAL_MS = 20 * 60 * 1000; // 20 min
const NOW = Date.now();

function makeHeartbeat(overrides = {}) {
  return {
    filename: `heartbeat-${overrides.machine ?? "test"}.json`,
    data: {
      schema_version: 1,
      node_id: overrides.nodeId ?? "node-1",
      machine: overrides.machine ?? "test",
      last_active_timestamp: overrides.lastTs ?? NOW - 5 * 60_000, // 5 min ago
      current_task_hash: overrides.taskHash ?? null,
      environmental_health: {},
      drift_velocity: null,
      heartbeat_ts: new Date().toISOString(),
    },
  };
}

describe("evaluateHeartbeats", () => {
  it("marks a fresh heartbeat as alive with 0 misses", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat({ lastTs: NOW - 5 * 60_000 })],
      sentinelState: { miss_counts: {} },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].status, "alive");
    assert.equal(result.updates[0].missCount, 0);
    assert.equal(result.deadNodes.length, 0);
    assert.equal(result.orphanedTasks.length, 0);
  });

  it("increments miss count for a stale heartbeat", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat({ lastTs: NOW - 35 * 60_000 })], // 35 min ago > 30 min threshold
      sentinelState: { miss_counts: {} },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates[0].status, "degraded");
    assert.equal(result.updates[0].missCount, 1);
    assert.equal(result.deadNodes.length, 0);
  });

  it("declares dead after 3 consecutive misses", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat({
        lastTs: NOW - 2 * 60 * 60_000, // 2h ago
        taskHash: "orphan-hash-abc",
      })],
      sentinelState: { miss_counts: { "node-1": 2 } }, // already 2 misses
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates[0].status, "dead");
    assert.equal(result.updates[0].missCount, 3);
    assert.equal(result.deadNodes.length, 1);
    assert.equal(result.deadNodes[0].nodeId, "node-1");
    assert.equal(result.deadNodes[0].currentTaskHash, "orphan-hash-abc");
    assert.equal(result.orphanedTasks.length, 1);
    assert.equal(result.orphanedTasks[0].taskHash, "orphan-hash-abc");
  });

  it("does NOT produce orphan when dead node has no current task", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat({
        lastTs: NOW - 2 * 60 * 60_000,
        taskHash: null,
      })],
      sentinelState: { miss_counts: { "node-1": 2 } },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.deadNodes.length, 1);
    assert.equal(result.orphanedTasks.length, 0);
  });

  it("resets miss count when a dead node comes back alive", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat({ lastTs: NOW - 1_000 })], // 1s ago
      sentinelState: { miss_counts: { "node-1": 5 } }, // was dead
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates[0].status, "alive");
    assert.equal(result.updates[0].missCount, 0);
    assert.equal(result.deadNodes.length, 0);
  });

  it("handles multiple nodes with mixed states", () => {
    const result = evaluateHeartbeats({
      heartbeats: [
        makeHeartbeat({ nodeId: "alive-node", machine: "m1", lastTs: NOW - 1_000 }),
        makeHeartbeat({ nodeId: "dead-node", machine: "m2", lastTs: NOW - 3 * 60 * 60_000, taskHash: "hash-x" }),
        makeHeartbeat({ nodeId: "degraded-node", machine: "m3", lastTs: NOW - 40 * 60_000 }),
      ],
      sentinelState: { miss_counts: { "dead-node": 2, "degraded-node": 0 } },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates.length, 3);
    const statusMap = Object.fromEntries(result.updates.map((u) => [u.nodeId, u.status]));
    assert.equal(statusMap["alive-node"], "alive");
    assert.equal(statusMap["dead-node"], "dead");
    assert.equal(statusMap["degraded-node"], "degraded");
    assert.equal(result.deadNodes.length, 1);
    assert.equal(result.orphanedTasks.length, 1);
  });

  it("handles malformed heartbeat data gracefully", () => {
    const result = evaluateHeartbeats({
      heartbeats: [{ filename: "heartbeat-bad.json", data: null }],
      sentinelState: { miss_counts: {} },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    // null data is skipped entirely
    assert.equal(result.updates.length, 0);
  });

  it("handles heartbeat with missing last_active_timestamp", () => {
    const result = evaluateHeartbeats({
      heartbeats: [{
        filename: "heartbeat-notime.json",
        data: { node_id: "no-ts", machine: "bad" },
      }],
      sentinelState: { miss_counts: {} },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].status, "malformed");
    assert.equal(result.updates[0].missCount, 1);
  });

  it("persists new sentinel state shape", () => {
    const result = evaluateHeartbeats({
      heartbeats: [makeHeartbeat()],
      sentinelState: { miss_counts: {} },
      now: NOW,
      intervalMs: INTERVAL_MS,
    });

    assert.equal(result.newSentinelState.schema_version, 1);
    assert.ok(result.newSentinelState.miss_counts);
    assert.equal(typeof result.newSentinelState.last_evaluated_ts, "number");
    assert.equal(typeof result.newSentinelState.last_evaluated_iso, "string");
    assert.ok(Array.isArray(result.newSentinelState.dead_nodes));
  });
});

describe("runSentinel", () => {
  it("returns error when gistId is missing", async () => {
    const result = await runSentinel({ gistId: "", token: "tok", intervalMs: INTERVAL_MS });
    assert.match(result.error, /missing/);
    assert.equal(result.deadNodes.length, 0);
  });

  it("returns error when token is missing", async () => {
    const result = await runSentinel({ gistId: "gist", token: "", intervalMs: INTERVAL_MS });
    assert.match(result.error, /missing/);
  });

  it("returns error when no heartbeat files are found", async () => {
    const result = await runSentinel({
      gistId: "gist",
      token: "tok",
      intervalMs: INTERVAL_MS,
      _readHeartbeats: async () => [],
      _readGistFile: async () => ({ data: null }),
      _writeGistFile: async () => ({ ok: true }),
    });
    assert.match(result.error, /no heartbeat/);
  });

  it("detects dead nodes and writes state via DI", async () => {
    const writtenFiles = {};
    const result = await runSentinel({
      gistId: "gist",
      token: "tok",
      intervalMs: INTERVAL_MS,
      now: NOW,
      _readHeartbeats: async () => [
        makeHeartbeat({ lastTs: NOW - 2 * 60 * 60_000, taskHash: "orphan-abc" }),
      ],
      _readGistFile: async (gistId, filename) => {
        if (filename === "sentinel-state.json") {
          return { data: { miss_counts: { "node-1": 2 } } };
        }
        if (filename === "pending-tasks.json") {
          return { data: { schema_version: 1, entries: [] } };
        }
        return { data: null };
      },
      _writeGistFile: async (gistId, filename, payload) => {
        writtenFiles[filename] = payload;
        return { ok: true };
      },
    });

    assert.equal(result.deadNodes.length, 1);
    assert.equal(result.orphanedTasks.length, 1);
    assert.ok(writtenFiles["sentinel-state.json"]);
    assert.ok(writtenFiles["sentinel-state.json"].dead_nodes.includes("node-1"));
  });
});

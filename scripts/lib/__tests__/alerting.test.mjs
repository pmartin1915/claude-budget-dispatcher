// alerting.test.mjs — Unit tests for the pure decideAlertAction helper.
//
// The module's I/O plumbing (checkAndAlert reads log + state files, calls
// fetch) is exercised end-to-end via dispatch.mjs and isn't re-mocked here.
// This suite covers the decision branches that were added/changed in the
// 2026-04-24 alerting-gap fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideAlertAction } from "../alerting.mjs";

const defaultAlertConfig = {
  enabled: true,
  provider: "ntfy",
  topic: "test-topic",
  on_transitions: ["down", "degraded"],
  heartbeat_hours: 168,
  stuck_realert_hours: 4,
};

const healthyState = {
  state: "healthy",
  reason: "ok",
  last_success_ts: "2026-04-24T00:00:00Z",
  last_structural_failure: null,
};

const downState = {
  state: "down",
  reason: "no successful dispatch in 23.0h",
  last_success_ts: "2026-04-23T00:00:00Z",
  last_structural_failure: {
    reason: "selector-failed",
    detail: "task_not_allowed",
    model: "gemini-2.5-flash",
    message: null,
    ts: "2026-04-24T01:00:00Z",
  },
};

const degradedState = {
  state: "degraded",
  reason: "3 structural failures in last 6 cycles (selector-failed: task_not_allowed)",
  last_success_ts: "2026-04-24T00:00:00Z",
  last_structural_failure: downState.last_structural_failure,
};

describe("decideAlertAction — transitions", () => {
  it("fires on healthy -> down", () => {
    const action = decideAlertAction({
      health: downState,
      prevState: "healthy",
      lastAlertTs: "2026-04-22T00:00:00Z",
      hoursSinceAlert: 48,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.ok(action);
    assert.equal(action.kind, "transition");
    assert.match(action.title, /down on perrypc/);
    assert.match(action.body, /healthy -> down/);
    assert.match(action.body, /selector-failed/);
    assert.match(action.body, /detail=task_not_allowed/);
    assert.equal(action.priority, 4);
  });

  it("fires on healthy -> degraded", () => {
    const action = decideAlertAction({
      health: degradedState,
      prevState: "healthy",
      lastAlertTs: null,
      hoursSinceAlert: 999,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.ok(action);
    assert.equal(action.kind, "transition");
    assert.match(action.body, /healthy -> degraded/);
    assert.equal(action.priority, 4);
  });

  it("does NOT fire on a transition to idle (not in on_transitions)", () => {
    const idleState = { ...healthyState, state: "idle", reason: "no work found in 10h" };
    const action = decideAlertAction({
      health: idleState,
      prevState: "healthy",
      lastAlertTs: null,
      hoursSinceAlert: 999,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.equal(action, null);
  });

  it("does NOT fire on first run (prevState is null)", () => {
    const action = decideAlertAction({
      health: downState,
      prevState: null,
      lastAlertTs: null,
      hoursSinceAlert: 0,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    // With prevState null, transition branch falls through; stuck branch
    // also requires prevState === health.state which is false. Heartbeat
    // only fires on healthy. So null.
    assert.equal(action, null);
  });
});

describe("decideAlertAction — stuck re-alert", () => {
  it("re-fires when stuck in down past the interval", () => {
    const action = decideAlertAction({
      health: downState,
      prevState: "down",
      lastAlertTs: "2026-04-23T22:00:00Z",
      hoursSinceAlert: 5, // > stuck_realert_hours (4)
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.ok(action);
    assert.equal(action.kind, "stuck");
    assert.match(action.title, /still down on perrypc/);
    assert.match(action.body, /still down \(5\.0h since last alert\)/);
    assert.equal(action.priority, 4);
  });

  it("does NOT re-fire when stuck but inside the interval", () => {
    const action = decideAlertAction({
      health: downState,
      prevState: "down",
      lastAlertTs: "2026-04-24T00:00:00Z",
      hoursSinceAlert: 2, // < stuck_realert_hours (4)
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.equal(action, null);
  });

  it("uses 'started in' phrasing when there is no prior alert", () => {
    // First-run-in-bad-state: prevState matches (was recorded on a previous
    // cycle) but no alert was ever sent (lastAlertTs is null).
    const action = decideAlertAction({
      health: downState,
      prevState: "down",
      lastAlertTs: null,
      hoursSinceAlert: 999,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.ok(action);
    assert.equal(action.kind, "stuck");
    assert.match(action.body, /started in down state/);
    assert.doesNotMatch(action.body, /still down/);
  });

  it("is disabled when stuck_realert_hours is 0", () => {
    const cfg = { ...defaultAlertConfig, stuck_realert_hours: 0 };
    const action = decideAlertAction({
      health: downState,
      prevState: "down",
      lastAlertTs: "2026-04-23T00:00:00Z",
      hoursSinceAlert: 24,
      host: "perrypc",
      alertConfig: cfg,
    });
    assert.equal(action, null);
  });

  it("does NOT fire stuck re-alert when state is healthy", () => {
    const action = decideAlertAction({
      health: healthyState,
      prevState: "healthy",
      lastAlertTs: "2026-04-23T00:00:00Z",
      hoursSinceAlert: 24,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    // Healthy stays healthy shouldn't trigger stuck alerts. Heartbeat might
    // (depends on heartbeat_hours), but not the stuck branch.
    // 24h < heartbeat_hours=168, so heartbeat also silent.
    assert.equal(action, null);
  });
});

describe("decideAlertAction — heartbeat", () => {
  it("fires when healthy and silent past heartbeat_hours", () => {
    const action = decideAlertAction({
      health: healthyState,
      prevState: "healthy",
      lastAlertTs: "2026-04-10T00:00:00Z",
      hoursSinceAlert: 336, // 14 days > 168h
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.ok(action);
    assert.equal(action.kind, "heartbeat");
    assert.equal(action.priority, 1);
    assert.match(action.body, /Still healthy/);
  });

  it("does NOT fire heartbeat inside the interval", () => {
    const action = decideAlertAction({
      health: healthyState,
      prevState: "healthy",
      lastAlertTs: "2026-04-23T00:00:00Z",
      hoursSinceAlert: 24,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.equal(action, null);
  });

  it("is disabled when heartbeat_hours is 0", () => {
    const cfg = { ...defaultAlertConfig, heartbeat_hours: 0 };
    const action = decideAlertAction({
      health: healthyState,
      prevState: "healthy",
      lastAlertTs: "2026-04-10T00:00:00Z",
      hoursSinceAlert: 999,
      host: "perrypc",
      alertConfig: cfg,
    });
    assert.equal(action, null);
  });
});

describe("decideAlertAction — precedence", () => {
  it("prefers transition over stuck when both could fire", () => {
    // If prevState and current differ AND current is watched, transition
    // fires; stuck branch requires prevState === current.
    const action = decideAlertAction({
      health: downState,
      prevState: "degraded",
      lastAlertTs: "2026-04-20T00:00:00Z",
      hoursSinceAlert: 96,
      host: "perrypc",
      alertConfig: defaultAlertConfig,
    });
    assert.equal(action.kind, "transition");
    assert.match(action.body, /degraded -> down/);
  });
});

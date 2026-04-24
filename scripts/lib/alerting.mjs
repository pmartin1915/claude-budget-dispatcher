// alerting.mjs — E1.1: out-of-band notifications on health state transitions.
// Uses ntfy.sh (free, no account required). Zero dependencies.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { computeHealth } from "./health.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = resolve(__dirname, "..", "..", "status");
const ALERT_STATE_PATH = resolve(STATUS_DIR, "alerting-state.json");
const LOG_PATH = resolve(STATUS_DIR, "budget-dispatch-log.jsonl");

/**
 * Read persisted alert state (previous health state + last alert timestamp).
 * @returns {{ prev_state: string|null, last_alert_ts: string|null }}
 */
function readAlertState() {
  try {
    return JSON.parse(readFileSync(ALERT_STATE_PATH, "utf8"));
  } catch {
    return { prev_state: null, last_alert_ts: null };
  }
}

/**
 * Persist alert state for the next dispatch cycle.
 * @param {{ prev_state: string, last_alert_ts: string|null }} state
 */
function writeAlertState(state) {
  writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * HTTP headers must be ASCII (ByteString). ntfy.sh rejects any non-ASCII
 * char in the Title header with: "Cannot convert argument to a ByteString".
 * Common offenders: em/en dashes, smart quotes, ellipsis. Replace with ASCII
 * equivalents; strip anything else to '?'.
 * @param {string} s
 * @returns {string}
 */
function asciiSafeHeader(s) {
  return String(s)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\r\n]/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}

/**
 * Send a notification via ntfy.sh.
 * @param {string} topic - ntfy.sh topic name
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {number} [priority=3] - ntfy priority (1=min, 3=default, 5=urgent)
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendNtfy(topic, title, body, priority = 3) {
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: asciiSafeHeader(title),
        Priority: String(priority),
        Tags: priority >= 4 ? "warning" : "white_check_mark",
      },
      body,
    });
    if (!res.ok) {
      console.warn(`[alerting] ntfy.sh returned ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[alerting] ntfy.sh send failed: ${e.message}`);
    return false;
  }
}

/**
 * Check health state transitions and send alerts if configured.
 * Called at the end of each dispatch cycle (after log is written).
 *
 * @param {object} config - Parsed budget.json (reads config.alerting)
 * @returns {Promise<void>}
 */
export async function checkAndAlert(config) {
  const alertConfig = config.alerting;
  if (!alertConfig?.enabled) return;

  const topic = alertConfig.topic;
  if (!topic) {
    console.warn("[alerting] enabled but no topic configured");
    return;
  }

  const health = computeHealth(LOG_PATH);
  const alertState = readAlertState();
  const prevState = alertState.prev_state;
  const host = hostname();
  const lastAlertTs = alertState.last_alert_ts;
  const lastAlertMs = lastAlertTs ? new Date(lastAlertTs).getTime() : 0;
  const hoursSinceAlert = (Date.now() - lastAlertMs) / 3_600_000;

  let sent = false;

  // Compose a rich body used by both transition and stuck re-alerts.
  const buildBody = (prefix) => {
    let body = prefix;
    const sf = health.last_structural_failure;
    if (sf) {
      body += `\nmodel=${sf.model ?? "unknown"}`;
      if (sf.detail) body += ` detail=${sf.detail}`;
      if (sf.message) body += `\nerror="${sf.message.slice(0, 200)}"`;
      body += `\nat ${sf.ts}`;
    }
    return body;
  };

  // State transition alert
  const onTransitions = alertConfig.on_transitions ?? ["down", "degraded"];
  if (prevState && prevState !== health.state && onTransitions.includes(health.state)) {
    const priority = (health.state === "down" || health.state === "degraded") ? 4 : 3;
    sent = await sendNtfy(
      topic,
      `Dispatcher ${health.state} on ${host}`,
      buildBody(`${prevState} -> ${health.state}: ${health.reason}`),
      priority,
    );
  }

  // 2026-04-24 alerting-gap fix: stuck-state re-alert. Without this, a
  // machine that flips healthy -> down once and stays down for 22h sends
  // exactly one ntfy and then goes silent. Re-fire at a configurable cadence
  // while stuck in an alerting state so Perry knows it's still broken.
  const stuckRealertHours = alertConfig.stuck_realert_hours ?? 4;
  const isStuckBadState = prevState === health.state && onTransitions.includes(health.state);
  if (!sent && isStuckBadState && stuckRealertHours > 0 && hoursSinceAlert >= stuckRealertHours) {
    const priority = (health.state === "down" || health.state === "degraded") ? 4 : 3;
    // Distinguish "started in bad state, no prior alert" from "stuck after
    // transition alert". Avoids a misleading "still down" when there was no
    // prior alert to be still-anything relative to.
    const prefix = lastAlertTs
      ? `still ${health.state} (${hoursSinceAlert.toFixed(1)}h since last alert)`
      : `started in ${health.state} state`;
    sent = await sendNtfy(
      topic,
      `Dispatcher still ${health.state} on ${host}`,
      buildBody(`${prefix}: ${health.reason}`),
      priority,
    );
  }

  // Heartbeat: periodic "still running" ping
  const heartbeatHours = alertConfig.heartbeat_hours ?? 168; // 7 days
  if (!sent && health.state === "healthy" && heartbeatHours > 0) {
    if (hoursSinceAlert >= heartbeatHours) {
      sent = await sendNtfy(
        topic,
        `Dispatcher heartbeat - ${host}`,
        `Still healthy. Last success: ${health.last_success_ts ?? "none"}`,
        1, // min priority for heartbeat
      );
    }
  }

  // Persist state
  writeAlertState({
    prev_state: health.state,
    last_alert_ts: sent ? new Date().toISOString() : (alertState.last_alert_ts ?? null),
  });
}

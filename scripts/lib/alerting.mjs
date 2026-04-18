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
        Title: title.replace(/[\r\n]/g, " "),
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

  let sent = false;

  // State transition alert
  const onTransitions = alertConfig.on_transitions ?? ["down"];
  if (prevState && prevState !== health.state && onTransitions.includes(health.state)) {
    const priority = health.state === "down" ? 4 : 3;
    sent = await sendNtfy(
      topic,
      `Dispatcher ${health.state} on ${host}`,
      `${prevState} -> ${health.state}: ${health.reason}`,
      priority,
    );
  }

  // Heartbeat: periodic "still running" ping
  const heartbeatHours = alertConfig.heartbeat_hours ?? 168; // 7 days
  if (!sent && health.state === "healthy" && heartbeatHours > 0) {
    const lastAlertMs = alertState.last_alert_ts
      ? new Date(alertState.last_alert_ts).getTime()
      : 0;
    const hoursSinceAlert = (Date.now() - lastAlertMs) / 3_600_000;
    if (hoursSinceAlert >= heartbeatHours) {
      sent = await sendNtfy(
        topic,
        `Dispatcher heartbeat — ${host}`,
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

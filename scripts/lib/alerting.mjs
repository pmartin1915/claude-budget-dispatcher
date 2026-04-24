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
 * Pure decision function — given health + last-alert state + config, decide
 * what (if anything) to send. Returns null for no action, or an object with
 * { kind, title, body, priority }. Split out from checkAndAlert so the
 * branching logic is unit-testable without filesystem or network.
 *
 * kind values:
 *   "transition" — state changed into a watched alerting state
 *   "stuck"      — still in a watched alerting state; nth re-alert
 *   "heartbeat"  — healthy, periodic keep-alive
 *
 * @param {object} args
 * @param {object} args.health           - computeHealth() result
 * @param {string|null} args.prevState   - previous state from alerting-state.json
 * @param {string|null} args.lastAlertTs - ISO timestamp or null
 * @param {number} args.hoursSinceAlert  - computed from lastAlertTs
 * @param {string} args.host             - hostname
 * @param {object} args.alertConfig      - config.alerting
 * @returns {{kind: string, title: string, body: string, priority: number} | null}
 */
export function decideAlertAction({ health, prevState, lastAlertTs, hoursSinceAlert, host, alertConfig }) {
  const onTransitions = alertConfig.on_transitions ?? ["down", "degraded"];
  const isWatchedBadState = onTransitions.includes(health.state);
  const badStatePriority = (health.state === "down" || health.state === "degraded") ? 4 : 3;

  const buildBody = (prefix) => {
    let body = prefix;
    const sf = health.last_structural_failure;
    if (sf) {
      if (sf.reason) body += `\nreason=${sf.reason}`;
      body += `${sf.reason ? " " : "\n"}model=${sf.model ?? "unknown"}`;
      if (sf.detail) body += ` detail=${sf.detail}`;
      if (sf.message) body += `\nerror="${sf.message.slice(0, 200)}"`;
      body += `\nat ${sf.ts}`;
    }
    return body;
  };

  // Priority 1: state transition into a watched state.
  if (prevState && prevState !== health.state && isWatchedBadState) {
    return {
      kind: "transition",
      title: `Dispatcher ${health.state} on ${host}`,
      body: buildBody(`${prevState} -> ${health.state}: ${health.reason}`),
      priority: badStatePriority,
    };
  }

  // Priority 2: stuck in a watched state past the re-alert interval.
  // 2026-04-24 alerting-gap fix: a single transition alert is easy to miss.
  // Re-fire every stuck_realert_hours (default 4h, 0 disables).
  const stuckRealertHours = alertConfig.stuck_realert_hours ?? 4;
  const isStuck = prevState === health.state && isWatchedBadState;
  if (isStuck && stuckRealertHours > 0 && hoursSinceAlert >= stuckRealertHours) {
    // Distinguish "started in bad state, no prior alert" (no transition
    // was ever observed) from "stuck after transition alert".
    const prefix = lastAlertTs
      ? `still ${health.state} (${hoursSinceAlert.toFixed(1)}h since last alert)`
      : `started in ${health.state} state`;
    return {
      kind: "stuck",
      title: `Dispatcher still ${health.state} on ${host}`,
      body: buildBody(`${prefix}: ${health.reason}`),
      priority: badStatePriority,
    };
  }

  // Priority 3: heartbeat when healthy and silent for a while.
  const heartbeatHours = alertConfig.heartbeat_hours ?? 168; // 7 days
  if (health.state === "healthy" && heartbeatHours > 0 && hoursSinceAlert >= heartbeatHours) {
    return {
      kind: "heartbeat",
      title: `Dispatcher heartbeat - ${host}`,
      body: `Still healthy. Last success: ${health.last_success_ts ?? "none"}`,
      priority: 1,
    };
  }

  return null;
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

  const action = decideAlertAction({
    health, prevState, lastAlertTs, hoursSinceAlert, host, alertConfig,
  });

  let sent = false;
  if (action) {
    sent = await sendNtfy(topic, action.title, action.body, action.priority);
  }

  // Persist state
  writeAlertState({
    prev_state: health.state,
    last_alert_ts: sent ? new Date().toISOString() : (alertState.last_alert_ts ?? null),
  });
}

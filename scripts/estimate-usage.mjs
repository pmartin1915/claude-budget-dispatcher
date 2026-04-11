#!/usr/bin/env node
// estimate-usage.mjs
//
// Scans ~/.claude/projects/**/*.jsonl for Anthropic usage fields and produces
// a usage snapshot gating the Budget Dispatcher. Runs as a plain Node script
// (no Claude cost) on a Windows Task Scheduler cron.
//
// Input:  ../config/budget.json (monthly/weekly thresholds, token weights)
// Output: ../status/usage-estimate.json (snapshot with gate decision)
//
// Exit codes: 0 = success (even if gate is red), 2 = fatal error

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "config", "budget.json");
const OUTPUT_PATH = resolve(__dirname, "..", "status", "usage-estimate.json");
const PAUSE_FILE = resolve(__dirname, "..", "config", "PAUSED");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function die(msg, code = 2) {
  console.error(`[estimate-usage] FATAL: ${msg}`);
  process.exit(code);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) die(`config missing: ${CONFIG_PATH}`);
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`config parse error: ${e.message}`);
  }
}

/** Recursively collect .jsonl files under a directory. */
function collectJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/** Compute weighted token cost for a usage object. */
function weightedCost(usage, weights) {
  if (!usage || typeof usage !== "object") return 0;
  const inp = (usage.input_tokens || 0) * weights.input_tokens;
  const out = (usage.output_tokens || 0) * weights.output_tokens;
  const cc = (usage.cache_creation_input_tokens || 0) * weights.cache_creation_input_tokens;
  const cr = (usage.cache_read_input_tokens || 0) * weights.cache_read_input_tokens;
  return inp + out + cc + cr;
}

/**
 * Stream-parse a .jsonl file and yield (timestamp, weighted_cost) for each usage entry.
 *
 * H3 fix: files modified within the last 30 seconds are "hot" — Claude Code may be
 * mid-write, so the trailing line could be a partial JSON object. We buffer lines
 * and drop the last line from hot files to avoid silent corruption.
 */
async function* usageEntries(filePath, weights) {
  let isHot = false;
  try {
    isHot = statSync(filePath).mtimeMs > Date.now() - 30_000;
  } catch {
    // stat failure → treat as cold, process all lines
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Buffer one line when hot so we can drop the final (possibly partial) line.
  let pending = null;

  for await (const line of rl) {
    if (isHot) {
      const toProcess = pending;
      pending = line;
      if (toProcess === null) continue;
      const entry = parseUsageLine(toProcess, weights);
      if (entry) yield entry;
    } else {
      const entry = parseUsageLine(line, weights);
      if (entry) yield entry;
    }
  }
  // Hot-file final line is intentionally dropped (may be partial).
}

function parseUsageLine(line, weights) {
  if (!line.trim()) return null; // L4: whitespace-only lines
  // Fast path: skip lines without usage data entirely.
  if (!line.includes('"usage"')) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // corrupt line — skip
  }
  const usage = obj?.message?.usage;
  if (!usage) return null;
  // Timestamps may be at top-level or nested — try both.
  const ts = obj.timestamp || obj.message?.timestamp || obj.message?.created_at;
  const when = ts ? Date.parse(ts) : NaN;
  if (Number.isNaN(when)) return null;
  return { when, cost: weightedCost(usage, weights) };
}

/**
 * Monthly period start (resetsOnDay of the current billing month, 00:00 UTC).
 *
 * C3 fix: UTC-everywhere. Transcript timestamps arrive as ISO UTC strings, so
 * mixing in local-time bucket boundaries caused up to 24h of drift around the
 * reset day.
 */
function monthlyPeriodStart(now, resetsOnDay) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  if (d.getUTCDate() >= resetsOnDay) {
    // Period started this month. Clamp to last day if requested reset day
    // exceeds this month's length (e.g. resetsOnDay=31 in April).
    const lastDayThis = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(resetsOnDay, lastDayThis));
  } else {
    // Period started last month. Walk to day 1 first so setUTCMonth doesn't
    // overflow forward when the previous month is shorter (Feb → 31).
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const lastDayPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(resetsOnDay, lastDayPrev));
  }
  return d.getTime();
}

function daysInMonthContaining(ts) {
  const d = new Date(ts);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Given total weighted cost in the period, normalize to an estimated "percent
 * of target budget used". The user's declared target_burn_pct_per_day implies
 * a target daily cost; we bootstrap that from the observed past-30-day average
 * scaled to the declared burn rate.
 *
 * Math: actual_pct = (cost_this_period / baseline_cost_for_full_period) * 100
 * baseline_cost_for_full_period = trailing_30day_cost * (target_pct_per_day / observed_pct_per_day)
 *
 * Simpler bootstrap: assume the trailing-30-day average IS the target rate
 * (i.e., user's historical usage equals their target). This is true-enough as
 * a pace signal — if historical burn was 2.5%/day and user's target is also
 * 2.5%/day, pace-matching works. Document this clearly.
 */
// Minimum weighted-cost history required before the trailing-30 baseline is
// trusted enough to bootstrap cost_per_pct_point. Below this, the snapshot
// fails closed with "insufficient-history-for-bootstrap". Tuned against
// token_weights in budget.example.json — ~100 weighted-cost units is an
// afternoon of light Claude Code usage.
const MIN_HISTORY_COST = 100;

function buildSnapshot(config, fileStats) {
  const now = Date.now();
  const weights = config.token_weights;

  // C2: validate target_burn_pct_per_day before anything that divides by it.
  const target = config.monthly?.target_burn_pct_per_day;
  if (!target || typeof target !== "number" || target <= 0) {
    const paused = config.paused === true || existsSync(PAUSE_FILE);
    return {
      generated_at: new Date(now).toISOString(),
      paused,
      dispatch_authorized: false,
      skip_reason: "invalid-config-target_burn_pct_per_day",
      monthly: null,
      weekly: null,
      bootstrap: {
        trailing_30day_cost: 0,
        cost_per_pct_point: null,
        method: "trailing-30-anchored-to-target-rate"
      }
    };
  }

  // Partition usage into buckets:
  //   - monthlyCost: within current monthly period
  //   - weeklyCost:  within trailing rolling_days (default 7)
  //   - trailing30: last 30 days (used for bootstrap scale)
  let monthlyCost = 0;
  let weeklyCost = 0;
  let trailing30 = 0;

  const monthStart = monthlyPeriodStart(now, config.monthly.resets_on_day);
  const weekStart = now - config.weekly.rolling_days * 86400_000;
  const thirtyStart = now - 30 * 86400_000;

  for (const { when, cost } of fileStats) {
    if (when >= thirtyStart) trailing30 += cost;
    if (when >= monthStart) monthlyCost += cost;
    if (when >= weekStart) weeklyCost += cost;
  }

  // C1: fail closed on cold start. Without a trailing-30-day baseline the
  // bootstrap math can't anchor cost_per_pct_point — the old fallback of 1
  // silently greenlit dispatch on fresh installs. Refuse to dispatch until
  // enough history accumulates.
  if (trailing30 < MIN_HISTORY_COST) {
    const paused = config.paused === true || existsSync(PAUSE_FILE);
    return {
      generated_at: new Date(now).toISOString(),
      paused,
      dispatch_authorized: false,
      skip_reason: "insufficient-history-for-bootstrap",
      monthly: {
        period_start: new Date(monthStart).toISOString(),
        cost_weighted_units: round(monthlyCost, 0),
        actual_pct: null,
        expected_pct_at_pace: null,
        headroom_pct: null,
        reserve_ok: false,
        gate_passes: false
      },
      weekly: {
        window_start: new Date(weekStart).toISOString(),
        rolling_days: config.weekly.rolling_days,
        cost_weighted_units: round(weeklyCost, 0),
        actual_pct: null,
        expected_pct_at_pace: null,
        headroom_pct: null,
        reserve_ok: false,
        gate_passes: false,
        is_floor: true
      },
      bootstrap: {
        trailing_30day_cost: round(trailing30, 0),
        cost_per_pct_point: null,
        min_history_cost: MIN_HISTORY_COST,
        method: "trailing-30-anchored-to-target-rate"
      }
    };
  }

  // Bootstrap: assume trailing-30-day = 30 * target_pct_per_day "percent-days".
  // → cost_per_pct_point = trailing30 / (30 * target_pct_per_day)
  const costPerPctPoint = trailing30 / (30 * target);

  const monthlyActualPct = costPerPctPoint > 0 ? monthlyCost / costPerPctPoint : 0;

  // Weekly normalization: expected weekly cost = 7 * target, scaled to 100% of weekly budget.
  const weeklyBudgetCost = 7 * target * costPerPctPoint;
  const weeklyActualPct = weeklyBudgetCost > 0 ? (weeklyCost / weeklyBudgetCost) * 100 : 0;

  // Pace expectations
  const daysInMonth = daysInMonthContaining(now);
  const daysElapsedInMonth = (now - monthStart) / 86400_000;
  const monthlyExpectedPct = (daysElapsedInMonth / daysInMonth) * 100;

  // Weekly pace: fraction of 7 days elapsed since weekly window opened.
  // For a rolling window, the "expected" pct at pace is always 100% * (1.0) if
  // usage is constant — so we compare against the *target* instead: weeklyExpectedPct
  // is simply the target 7-day burn (i.e., 100% of weekly budget matches target).
  const weeklyExpectedPct = 100; // by definition of "target"

  const monthlyHeadroom = monthlyExpectedPct - monthlyActualPct;
  const weeklyHeadroom = weeklyExpectedPct - weeklyActualPct;

  const monthlyReserveOk =
    monthlyActualPct + config.max_opportunistic_pct_per_run
      <= 100 - config.monthly.reserve_floor_pct;
  const weeklyReserveOk =
    weeklyActualPct + config.max_opportunistic_pct_per_run
      <= 100 - config.weekly.reserve_floor_pct;

  const monthlyGate =
    monthlyReserveOk && monthlyHeadroom >= config.monthly.trigger_headroom_pct;
  const weeklyGate =
    weeklyReserveOk && weeklyHeadroom >= config.weekly.trigger_headroom_pct;

  // Weekly is the floor: both must pass.
  const dispatchAuthorized = monthlyGate && weeklyGate;

  const paused = config.paused === true || existsSync(PAUSE_FILE);

  return {
    generated_at: new Date(now).toISOString(),
    paused,
    dispatch_authorized: dispatchAuthorized && !paused,
    skip_reason: paused
      ? "paused"
      : !monthlyGate
        ? !monthlyReserveOk
          ? "monthly-reserve-floor-threatened"
          : "monthly-headroom-below-trigger"
        : !weeklyGate
          ? !weeklyReserveOk
            ? "weekly-reserve-floor-threatened"
            : "weekly-headroom-below-trigger"
          : null,
    monthly: {
      period_start: new Date(monthStart).toISOString(),
      days_elapsed: round(daysElapsedInMonth, 2),
      days_in_period: daysInMonth,
      cost_weighted_units: round(monthlyCost, 0),
      actual_pct: round(monthlyActualPct, 2),
      expected_pct_at_pace: round(monthlyExpectedPct, 2),
      headroom_pct: round(monthlyHeadroom, 2),
      reserve_ok: monthlyReserveOk,
      gate_passes: monthlyGate
    },
    weekly: {
      window_start: new Date(weekStart).toISOString(),
      rolling_days: config.weekly.rolling_days,
      cost_weighted_units: round(weeklyCost, 0),
      actual_pct: round(weeklyActualPct, 2),
      expected_pct_at_pace: weeklyExpectedPct,
      headroom_pct: round(weeklyHeadroom, 2),
      reserve_ok: weeklyReserveOk,
      gate_passes: weeklyGate,
      is_floor: true
    },
    bootstrap: {
      trailing_30day_cost: round(trailing30, 0),
      cost_per_pct_point: round(costPerPctPoint, 2),
      method: "trailing-30-anchored-to-target-rate"
    }
  };
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

async function main() {
  const config = loadConfig();
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    die(`claude projects dir missing: ${CLAUDE_PROJECTS_DIR}`);
  }

  const files = collectJsonlFiles(CLAUDE_PROJECTS_DIR);
  if (files.length === 0) {
    console.warn("[estimate-usage] no transcript files found — writing empty snapshot");
  }

  const entries = [];
  for (const f of files) {
    try {
      for await (const entry of usageEntries(f, config.token_weights)) {
        entries.push(entry);
      }
    } catch (e) {
      console.warn(`[estimate-usage] skip corrupt file ${f}: ${e.message}`);
    }
  }

  const snapshot = buildSnapshot(config, entries);

  // M5: auto-create status dir on first run. This is friendlier for first-run
  // users than fail-closed, and the dispatcher still fail-closes on the actual
  // gate decision, so there's no safety downside.
  const statusDir = dirname(OUTPUT_PATH);
  if (!existsSync(statusDir)) {
    mkdirSync(statusDir, { recursive: true });
  }
  try {
    writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    die(`failed to write snapshot to ${OUTPUT_PATH}: ${e.message}`);
  }
  console.log(`[estimate-usage] wrote ${OUTPUT_PATH}`);
  console.log(
    `  dispatch_authorized=${snapshot.dispatch_authorized}  reason=${snapshot.skip_reason || "green-light"}`
  );
  if (snapshot.monthly && snapshot.monthly.actual_pct !== null) {
    console.log(
      `  monthly: ${snapshot.monthly.actual_pct}% used / ${snapshot.monthly.expected_pct_at_pace}% expected (headroom ${snapshot.monthly.headroom_pct}%)`
    );
  }
  if (snapshot.weekly && snapshot.weekly.actual_pct !== null) {
    console.log(
      `  weekly:  ${snapshot.weekly.actual_pct}% used / ${snapshot.weekly.expected_pct_at_pace}% target (headroom ${snapshot.weekly.headroom_pct}%)`
    );
  }
}

main().catch((e) => die(e.stack || e.message));

#!/usr/bin/env node
// Budget Dispatcher Dashboard -- localhost web UI for engine switching & monitoring.
// Zero external dependencies. Uses Node built-in http module.
// Start: node scripts/dashboard.mjs [--port 7380]

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const CONFIG_PATH = join(REPO_ROOT, "config", "budget.json");
const SNAPSHOT_PATH = join(REPO_ROOT, "status", "usage-estimate.json");
const LAST_RUN_PATH = join(REPO_ROOT, "status", "budget-dispatch-last-run.json");
const LOG_PATH = join(REPO_ROOT, "status", "budget-dispatch-log.jsonl");
const PAUSE_PATH = join(REPO_ROOT, "config", "PAUSED");

const PORT = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 && process.argv[idx + 1] ? parseInt(process.argv[idx + 1], 10) : 7380;
})();

// ---- Helpers ----

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readRecentLogs(n = 10) {
  try {
    const raw = readFileSync(LOG_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-n).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

function getState() {
  const config = readJson(CONFIG_PATH);
  if (!config) return { error: "config/budget.json not found or invalid" };

  const snapshot = readJson(SNAPSHOT_PATH);
  const lastRun = readJson(LAST_RUN_PATH);
  const recentLogs = readRecentLogs(10);

  const override = config.engine_override ?? null;
  let nextEngine;
  if (override && override !== "auto") {
    nextEngine = override;
  } else {
    nextEngine = snapshot?.dispatch_authorized ? "claude" : "node";
  }

  return {
    engine_override: override,
    next_engine: nextEngine,
    paused: config.paused ?? false,
    pause_file_exists: existsSync(PAUSE_PATH),
    dry_run: config.dry_run ?? false,
    budget: snapshot
      ? {
          dispatch_authorized: snapshot.dispatch_authorized,
          skip_reason: snapshot.skip_reason ?? null,
          headroom_pct: snapshot.trailing30?.headroom_pct ?? null,
          actual_pct: snapshot.trailing30?.actual_pct ?? null,
          expected_pct: snapshot.trailing30?.expected_pct_at_pace ?? null,
          weekly_actual_pct: snapshot.weekly?.actual_pct ?? null,
          weekly_headroom_pct: snapshot.weekly?.headroom_pct ?? null,
          generated_at: snapshot.generated_at ?? null,
        }
      : null,
    last_run: lastRun,
    recent_logs: recentLogs,
    projects: (config.projects_in_rotation ?? []).map((p) => p.slug),
    max_runs_per_day: config.max_runs_per_day ?? 8,
  };
}

function setEngineOverride(engine) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };

  const valid = ["auto", "node", "claude"];
  if (!valid.includes(engine)) return { ok: false, error: `invalid engine: ${engine}` };

  config.engine_override = engine === "auto" ? null : engine;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, engine_override: config.engine_override };
}

function togglePause(paused) {
  const config = readJson(CONFIG_PATH);
  if (!config) return { ok: false, error: "config not found" };

  config.paused = !!paused;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { ok: true, paused: config.paused };
}

function triggerDispatch(dryRun = true) {
  const args = ["scripts/dispatch.mjs", "--force"];
  if (dryRun) args.push("--dry-run");

  const child = spawn("node", args, {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  child.unref();
  return { ok: true, pid: child.pid, dry_run: dryRun };
}

// ---- HTTP Server ----

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, getState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/engine") {
    const body = await parseBody(req);
    json(res, setEngineOverride(body.engine));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pause") {
    const body = await parseBody(req);
    json(res, togglePause(body.paused));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dispatch") {
    const body = await parseBody(req);
    json(res, triggerDispatch(body.dry_run !== false));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Budget Dispatcher Dashboard running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});

// ---- HTML Page ----

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Budget Dispatcher</title>
<style>
  :root {
    --bg: #1a1b26; --surface: #24283b; --border: #414868;
    --text: #c0caf5; --text-dim: #565f89; --accent: #7aa2f7;
    --green: #9ece6a; --red: #f7768e; --yellow: #e0af68; --cyan: #7dcfff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    background: var(--bg); color: var(--text);
    max-width: 640px; margin: 0 auto; padding: 16px;
  }
  h1 { font-size: 16px; color: var(--accent); margin-bottom: 16px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; margin-bottom: 12px;
  }
  .card h2 { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .engine-btns { display: flex; gap: 8px; margin-bottom: 10px; }
  .engine-btns button {
    flex: 1; padding: 10px 0; border: 2px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text); cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 600; transition: all 0.15s;
  }
  .engine-btns button:hover { border-color: var(--accent); color: var(--accent); }
  .engine-btns button.active { border-color: var(--accent); background: rgba(122,162,247,0.15); color: var(--accent); }
  .next-engine { font-size: 13px; color: var(--text-dim); }
  .next-engine span { font-weight: 700; }
  .next-engine span.node { color: var(--green); }
  .next-engine span.claude { color: var(--yellow); }
  .metric { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .metric .label { color: var(--text-dim); }
  .metric .value { font-weight: 600; }
  .metric .value.yes { color: var(--green); }
  .metric .value.no { color: var(--red); }
  .metric .value.warn { color: var(--yellow); }
  .actions { display: flex; gap: 8px; }
  .actions button {
    flex: 1; padding: 10px 0; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); cursor: pointer;
    font-family: inherit; font-size: 13px; transition: all 0.15s;
  }
  .actions button:hover { border-color: var(--accent); }
  .actions button.pause-active { border-color: var(--yellow); color: var(--yellow); }
  .actions button.dispatch { border-color: var(--cyan); color: var(--cyan); }
  .log-entry {
    font-size: 11px; padding: 6px 0; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 8px;
  }
  .log-entry:last-child { border-bottom: none; }
  .log-entry .ts { color: var(--text-dim); white-space: nowrap; }
  .log-entry .outcome { font-weight: 600; }
  .log-entry .outcome.success, .log-entry .outcome.wrapper-success { color: var(--green); }
  .log-entry .outcome.skipped { color: var(--text-dim); }
  .log-entry .outcome.error { color: var(--red); }
  .log-entry .reason { color: var(--text-dim); flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-bar { font-size: 11px; color: var(--text-dim); text-align: center; margin-top: 8px; }
  .error-msg { color: var(--red); font-size: 13px; padding: 8px; }
</style>
</head>
<body>

<h1>Budget Dispatcher Control Panel</h1>

<div class="card">
  <h2>Engine Mode</h2>
  <div class="engine-btns">
    <button id="btn-auto" onclick="setEngine('auto')">Auto</button>
    <button id="btn-node" onclick="setEngine('node')">Free Only</button>
    <button id="btn-claude" onclick="setEngine('claude')">Claude</button>
  </div>
  <div class="next-engine">Next dispatch will use: <span id="next-engine">--</span></div>
</div>

<div class="card">
  <h2>Budget</h2>
  <div class="metric"><span class="label">Authorized</span><span class="value" id="budget-auth">--</span></div>
  <div class="metric"><span class="label">Headroom</span><span class="value" id="budget-headroom">--</span></div>
  <div class="metric"><span class="label">Trailing 30</span><span class="value" id="budget-trailing">--</span></div>
  <div class="metric"><span class="label">Weekly</span><span class="value" id="budget-weekly">--</span></div>
  <div class="metric"><span class="label">Snapshot age</span><span class="value" id="budget-age">--</span></div>
</div>

<div class="card">
  <h2>Last Run</h2>
  <div class="metric"><span class="label">Status</span><span class="value" id="last-status">--</span></div>
  <div class="metric"><span class="label">Reason</span><span class="value" id="last-reason">--</span></div>
  <div class="metric"><span class="label">Duration</span><span class="value" id="last-duration">--</span></div>
  <div class="metric"><span class="label">Time</span><span class="value" id="last-time">--</span></div>
</div>

<div class="card">
  <h2>Actions</h2>
  <div class="actions">
    <button id="btn-pause" onclick="togglePause()">Pause</button>
    <button class="dispatch" onclick="dispatchNow(true)">Dry Run</button>
    <button class="dispatch" onclick="dispatchNow(false)">Dispatch Now</button>
  </div>
</div>

<div class="card">
  <h2>Recent Runs</h2>
  <div id="log-entries"><div class="log-entry">Loading...</div></div>
</div>

<div class="status-bar" id="status-bar">Connecting...</div>

<script>
let state = null;

async function fetchState() {
  try {
    const r = await fetch('/api/state');
    state = await r.json();
    render();
    document.getElementById('status-bar').textContent =
      'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('status-bar').textContent = 'Error: ' + e.message;
  }
}

function render() {
  if (!state || state.error) {
    document.getElementById('status-bar').textContent = state?.error || 'No data';
    return;
  }

  // Engine buttons
  const active = state.engine_override || 'auto';
  ['auto', 'node', 'claude'].forEach(e => {
    const btn = document.getElementById('btn-' + e);
    btn.classList.toggle('active', active === e);
  });

  // Next engine
  const ne = document.getElementById('next-engine');
  ne.textContent = state.next_engine.toUpperCase();
  ne.className = state.next_engine;

  // Budget
  const b = state.budget;
  if (b) {
    const authEl = document.getElementById('budget-auth');
    authEl.textContent = b.dispatch_authorized ? 'YES' : 'NO';
    authEl.className = 'value ' + (b.dispatch_authorized ? 'yes' : 'no');

    const hEl = document.getElementById('budget-headroom');
    const h = b.headroom_pct;
    hEl.textContent = h != null ? h.toFixed(1) + '%' : '--';
    hEl.className = 'value ' + (h != null ? (h >= 0 ? 'yes' : 'no') : '');

    document.getElementById('budget-trailing').textContent =
      b.actual_pct != null ? b.actual_pct.toFixed(1) + '% used / ' + (b.expected_pct?.toFixed(1) ?? '?') + '% expected' : '--';

    document.getElementById('budget-weekly').textContent =
      b.weekly_actual_pct != null ? b.weekly_actual_pct.toFixed(1) + '% used (headroom ' + (b.weekly_headroom_pct?.toFixed(1) ?? '?') + '%)' : '--';

    const age = b.generated_at ? timeAgo(new Date(b.generated_at)) : '--';
    document.getElementById('budget-age').textContent = age;
  }

  // Last run
  const lr = state.last_run;
  if (lr) {
    const statusEl = document.getElementById('last-status');
    statusEl.textContent = lr.status || '--';
    statusEl.className = 'value ' + (lr.status === 'success' || lr.status === 'wrapper-success' ? 'yes' : lr.status === 'error' ? 'no' : 'warn');

    document.getElementById('last-reason').textContent = lr.error || lr.reason || '--';
    document.getElementById('last-duration').textContent = lr.duration_ms != null ? lr.duration_ms + 'ms' : (lr.wrapper_duration_sec != null ? lr.wrapper_duration_sec + 's' : '--');
    document.getElementById('last-time').textContent = lr.timestamp ? new Date(lr.timestamp).toLocaleString() : '--';
  }

  // Pause button
  const pauseBtn = document.getElementById('btn-pause');
  const isPaused = state.paused || state.pause_file_exists;
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('pause-active', isPaused);

  // Log entries
  const logDiv = document.getElementById('log-entries');
  if (state.recent_logs.length === 0) {
    logDiv.innerHTML = '<div class="log-entry" style="color:var(--text-dim)">No logs yet</div>';
  } else {
    logDiv.innerHTML = state.recent_logs.map(l => {
      const ts = l.ts ? new Date(l.ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '?';
      const outcome = l.outcome || l.status || '?';
      const reason = l.reason || l.error || l.skip_reason || '';
      return '<div class="log-entry">' +
        '<span class="ts">' + ts + '</span>' +
        '<span class="outcome ' + outcome + '">' + outcome + '</span>' +
        '<span class="reason">' + reason + '</span>' +
        '</div>';
    }).join('');
  }
}

function timeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

async function setEngine(engine) {
  await fetch('/api/engine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine })
  });
  await fetchState();
}

async function togglePause() {
  const isPaused = state?.paused || state?.pause_file_exists;
  await fetch('/api/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !isPaused })
  });
  await fetchState();
}

async function dispatchNow(dryRun) {
  const label = dryRun ? 'Dry run' : 'Dispatch';
  if (!dryRun && !confirm('Run a real dispatch now? This will create a worktree and call a model.')) return;
  const r = await fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: dryRun })
  });
  const result = await r.json();
  document.getElementById('status-bar').textContent =
    label + ' triggered (PID ' + (result.pid || '?') + '). Refresh in a few seconds.';
  setTimeout(fetchState, 5000);
}

// Initial load + auto-refresh
fetchState();
setInterval(fetchState, 30000);
</script>

</body>
</html>`;

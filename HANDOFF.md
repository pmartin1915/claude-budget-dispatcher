# Handoff -- PC Claude instance (Part 9 -- 2026-04-16)

> **READ THIS FIRST.** Part 9 supersedes all previous parts. Parts 5-8 are historical context below.

## Part 9: TL;DR for next instance

- **Engine switching dashboard shipped (`c925524`).** `node scripts/dashboard.mjs` serves a dark-themed control panel at `http://localhost:7380`. Three engine buttons (Auto / Free Only / Claude), budget status, last run info, recent logs, pause/resume, and dispatch-now. Zero new npm dependencies -- uses Node's built-in `node:http` module. Auto-refreshes every 30s.
- **Config-based engine override shipped (`c925524`).** `config/budget.json` now has `engine_override` field. Set to `"node"`, `"claude"`, or `null` (auto). The scheduled task reads this on every firing -- no admin privileges needed, no scheduled task edits required. The dashboard and CLI write this field.
- **CLI control shipped (`c925524`).** `node scripts/control.mjs` -- interactive terminal menu for engine switching, pause/resume, and dry-run dispatch. Alternative to the web dashboard.
- **`-ForceBudget` flag shipped (`c925524`).** `run-dispatcher.ps1 -ForceBudget` bypasses the budget gate and activity gate for manual Claude engine validation. Never in the scheduled task. Mutex, daily quota, and PAUSED gates remain active.
- **Claude engine NOT YET VALIDATED.** The flag exists but hasn't been used yet. First validation requires: `.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine claude -ForceBudget` (will consume some Claude Max tokens).
- **Scorecard: 36/36 done** (excluding S-1/S-2 which are infrastructure-gated on WSL2).
- **`dry_run: false`** -- live, do NOT flip back to true.
- **Budget state:** headroom -24% (trailing30-reserve-floor-threatened). Auto mode selects node on every firing.

## Part 9: what was done (2026-04-16)

| Commit | What | Files |
|--------|------|-------|
| `c925524` | Engine switching dashboard, CLI control, config override, -ForceBudget | `run-dispatcher.ps1`, `dashboard.mjs`, `control.mjs`, `budget.example.json`, `package.json`, `DISPATCHER-STATUS.md` |

### New files
- `scripts/dashboard.mjs` -- web dashboard (~440 lines, inline HTML/CSS/JS)
- `scripts/control.mjs` -- CLI control (~105 lines)

### Non-code changes
- None. Scheduled task `BudgetDispatcher-Node` still fires with `-Engine auto`, now reads `engine_override` from config.

## Part 9: current dispatcher state (as of 2026-04-16)

- **Scheduled task `BudgetDispatcher-Node`:** Ready. Firing every 20 min with `-Engine auto`.
- **`ClaudeBudgetDispatcher`:** Disabled. Not needed (auto mode handles both engines).
- **`config/budget.json`:** `dry_run: false`, `paused: false`, `max_runs_per_day: 50`, `engine_override: null` (auto).
- **Budget estimate:** refreshed every firing. Current: `dispatch_authorized: false`, headroom -24%.
- **Engine override:** `null` (auto mode). Dashboard and CLI can change this without admin.
- **Pre-commit hook:** installed (.git/hooks/pre-commit -- R-6 ASCII check on .ps1 files).
- **Gist sync:** active. https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf

## Part 9: scorecard

| Status | Count | Items |
|---|---|---|
| Done | 36 | All original audit items + Parts 7-8 fixes + Part 9 features (dashboard, CLI, config override, -ForceBudget) |
| Deferred-infra | 2 | S-1 (execution sandbox), S-2 (network isolation) -- need WSL2/Windows Sandbox |

## Part 9: architecture notes for next instance

### Engine override flow

```
run-dispatcher.ps1 -Engine auto
  |
  +-- Acquire mutex
  +-- Read config/budget.json -> engine_override
  |     |
  |     +-- engine_override = "node"   --> Engine = 'node'
  |     +-- engine_override = "claude" --> Engine = 'claude'
  |     +-- engine_override = null     --> Engine stays 'auto' (existing logic)
  |     +-- read error                 --> Engine stays 'auto' (warn + fallthrough)
  |
  +-- If Engine = 'auto': existing budget-adaptive resolution
  +-- If Engine = 'node': dispatch.mjs pipeline
  +-- If Engine = 'claude': estimator -> activity gate -> claude -p
  +-- If -ForceBudget: skip budget gate + activity gate for Claude engine
```

### Dashboard architecture

```
scripts/dashboard.mjs (Node http server, port 7380, 127.0.0.1 only)
  |
  +-- GET /             -> inline HTML page (dark theme, auto-refresh 30s)
  +-- GET /api/state    -> reads config + status files, returns JSON
  +-- POST /api/engine  -> writes engine_override to budget.json
  +-- POST /api/pause   -> writes paused to budget.json
  +-- POST /api/dispatch -> spawns dispatch.mjs --force [--dry-run]
```

### Manual testing commands

```bash
# Start dashboard:
node scripts/dashboard.mjs
# Then open http://localhost:7380

# CLI control:
node scripts/control.mjs

# Validate Claude engine (one-time, burns Claude Max tokens):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-dispatcher.ps1 \
  -RepoRoot "C:\Users\perry\DevProjects\claude-budget-dispatcher" -Engine claude -ForceBudget
# Then check log: ls -t status/dispatcher-runs/*.log | head -1 | xargs cat

# Inspect pipeline (no side effects):
GEMINI_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GEMINI_API_KEY','User')") \
MISTRAL_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('MISTRAL_API_KEY','User')") \
node scripts/dispatch.mjs --force --dry-run

# Check results:
cat status/budget-dispatch-last-run.json
```

### Key files modified this session

| File | What changed | Key lines |
|------|-------------|-----------|
| `scripts/run-dispatcher.ps1` | engine_override reader, -ForceBudget param + bypass | 63-65, 150-168, 175-207, 395-418 |
| `scripts/dashboard.mjs` | NEW: web dashboard, inline HTML, JSON API | entire file |
| `scripts/control.mjs` | NEW: interactive CLI control | entire file |
| `config/budget.example.json` | Added engine_override field + doc comment | 7-9 |
| `package.json` | Added dashboard + control npm scripts | 10-11 |
| `DISPATCHER-STATUS.md` | Dashboard/CLI/override docs in engine switching section | 96-116 |

## Part 9: what's left

### Must-do (not yet done)
- **Claude engine validation** -- Run `run-dispatcher.ps1 -Engine claude -ForceBudget` once to confirm the full Claude pipeline works end-to-end. The flag and override are shipped; the actual test hasn't been run yet.

### Infrastructure-gated (needs WSL2 or Windows Sandbox)
- **S-1** Execution sandbox for generated code
- **S-2** Network isolation for test subprocesses

### Optional
- **I-4 native SDK reconciliation** -- swap `withTimeout` to native `AbortSignal.timeout`. Low priority.
- **Expand project rotation** -- add more projects + src/ dirs to unlock more tasks.
- **Dashboard enhancements** -- see suggestions below.

## Part 9: suggestions for future sessions

These are ideas from this session that weren't in scope but could add value:

1. **Dashboard: auto-open browser on start.** Add `import { exec } from 'node:child_process'; exec('start http://localhost:7380')` on Windows to auto-open after `server.listen`. Small QoL win.

2. **Dashboard: WebSocket for live updates.** Replace 30s polling with a file-watcher + WebSocket push. Would show dispatch results the instant they happen. More complex but much more responsive.

3. **Dashboard: show projects in rotation.** The API already returns `projects` list. Adding a "Projects" card showing the rotation with last-dispatched timestamps would give visibility into what's being worked on.

4. **System tray icon.** A tiny Node.js system tray app (using `systray2` or similar npm package) that shows a green/yellow/red dot for dispatcher status. Right-click menu for engine switching, pause, open dashboard. Would make the dispatcher visible without opening a browser. Moderate effort.

5. **Desktop notifications on dispatch.** Use `node-notifier` or PowerShell toast notifications to alert when a dispatch completes. Especially useful for Claude engine dispatches that take minutes.

6. **Config override: add `"auto"` as explicit option.** Currently `null` means auto. Consider allowing `"auto"` as a string value (the PS1 already handles it) for clarity in the config file. The dashboard already does this (clicking "Auto" sets override to null).

7. **Budget trend sparkline.** Parse the last 24h of `budget-dispatch-log.jsonl` and render a tiny ASCII or SVG sparkline of headroom over time in the dashboard. Would show whether headroom is trending toward positive (Claude activation imminent).

8. **Scheduled task health check.** Add a dashboard indicator showing whether `BudgetDispatcher-Node` is registered and its next run time. Could use `powershell -Command "(Get-ScheduledTaskInfo 'BudgetDispatcher-Node').NextRunTime"`.

## Part 9: things NOT to do

- Do not flip `dry_run` back to `true`.
- Do not re-enable the `ClaudeBudgetDispatcher` scheduled task (auto mode replaces it).
- Do not use `gemini-3-pro-preview` (bills Perry's Google Cloud credits).
- Do not commit `config/budget.json` (gitignored, local-only).
- Do not push `auto/` branches to origin.
- PS1 files must stay pure ASCII (R-6 pre-commit hook enforces this).
- Before any commit: run `mcp__pal__codereview` with model `gemini-2.5-pro`. Fallback to `review_validation_type: "internal"` if Gemini is 503-ing.
- Do not add `-ForceBudget` to the scheduled task arguments.

## Part 9: gotchas (appended to prior sessions)

8. **Budget estimate staleness is now solved.** Every firing (even node engine) refreshes `usage-estimate.json`.
9. **libuv UV_HANDLE_CLOSING assertion** still fires on `--force --dry-run` exit path. Cosmetic -- all logging completes before the assertion.
10. **Redundant estimator call** when auto resolves to claude. Harmless (~1s overhead).
11. **engine_override null vs "null".** PowerShell's ConvertFrom-Json returns `$null` for JSON `null`. The override reader checks both `$override` (catches $null) and `$override -ne 'null'` (catches the string "null" if someone types it literally). Both are correct.
12. **Dashboard innerHTML.** Log entries are rendered via innerHTML with data from local JSONL files. Minimal XSS risk since all data is locally-generated. If external data ever enters the log pipeline, harden with textContent or escaping.

---

# Historical context (Parts 5-8)

Parts 5 through 8 shipped the bulk of the audit findings (36 items), took the free-model engine from dry-run to live, resolved the OneDrive junction / selector hot-fix / named mutex / error visibility / libuv crash, and added auto mode with budget-adaptive routing. See git log for full history. The key progression:

- **Part 5:** ajv blackout fix, selector hot-fix verified, R-3 named mutex
- **Part 6:** S-7 scanner, I-4 timeouts, R-5 log rotation, C-4 git fsck, R-7 index.lock cleanup, R-4 gist sync
- **Part 7:** libuv crash fix, S-8 npm audit, C-5 fallback chain, selector src/ filter, error visibility, dry_run=false flip
- **Part 8:** Auto mode, worktree cleanup, --force flag
- **Part 9:** Engine switching dashboard, CLI control, config override, -ForceBudget (this session)

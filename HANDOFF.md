# Handoff -- PC Claude instance (Part 10 -- 2026-04-16)

> **READ THIS FIRST.** Part 10 supersedes all previous parts. Parts 5-9 are historical context below.

## Part 10: TL;DR for next instance

- **Claude engine VALIDATED (2026-04-16).** Full pipeline confirmed end-to-end: estimator, gate bypasses, `claude -p` via `.cmd` shim, ExitCode capture, stdin/stdout piping, JSONL logging. Claude correctly fail-closed on negative headroom. Three bugs found and fixed during validation.
- **Dashboard redesigned (`9da4f2c`, `174b072`).** 6-tab layout: Status (health beacon, prediction, budget bars), Budget (trajectory, sparkline), Projects (roster management, task toggles), Logs (paginated, drill-down), Config (all settings), About (project charters and roadmaps). 8 API endpoints. Zero new dependencies.
- **CLI enhanced (`9da4f2c`).** 10 menu options: engine switch, pause, dry-run toggle, real dispatch, prediction, log tail, open browser.
- **libuv crash fixed (`ff8b9ab`).** `dispatch.mjs` was crashing on exit when Gemini/Mistral HTTP handles were still closing. `setImmediate` replaced with `setTimeout(..., 200)`. Tested 4x, all clean exits.
- **PowerShell process launch fixed (`ed25364`, `6873aa8`).** Two PS 5.1 bugs: `Get-Command claude` resolved to `.ps1` shim (incompatible with `Start-Process`), and `Start-Process -PassThru` returned null `ExitCode` with redirected IO. Fixed by resolving `.cmd` and using `[System.Diagnostics.Process]::Start`.
- **`-ForceBudget` now bypasses activity gate (`537b30f`).** Matches Node engine's `--force` behavior. Manual testing no longer blocked by idle check.
- **Scorecard: 36/36 done** (excluding S-1/S-2 which are infrastructure-gated on WSL2).
- **Both engines validated.** Node engine has 1 successful real dispatch (roadmap-review). Claude engine validated via `-ForceBudget`.
- **`dry_run: false`** -- live, do NOT flip back to true.
- **Budget state:** headroom -24% (trailing30-reserve-floor-threatened). Auto mode selects node on every firing.

## Part 10: what was done (2026-04-16)

| Commit | What | Files |
|--------|------|-------|
| `537b30f` | `-ForceBudget` bypasses activity gate | `run-dispatcher.ps1`, `HANDOFF.md`, `DISPATCHER-STATUS.md`, `HANDOFF-PROMPT.md` |
| `ed25364` | Resolve `claude.cmd` instead of `.ps1` for Start-Process | `run-dispatcher.ps1` |
| `6873aa8` | .NET Process for reliable ExitCode on claude -p | `run-dispatcher.ps1` |
| `dfb45fb` | Mark Claude engine validated | `HANDOFF.md` |
| `ff8b9ab` | Fix libuv crash on dispatch.mjs exit | `dispatch.mjs` |
| `9da4f2c` | Redesigned dashboard (5 tabs) + enhanced CLI | `dashboard.mjs`, `control.mjs` |
| `861af9b` | Fix client-side `esc()` missing | `dashboard.mjs` |
| `174b072` | About tab with project docs | `dashboard.mjs` |

### Architecture: dashboard flow

```
node scripts/dashboard.mjs (localhost:7380)
  |
  +-- GET /              -> 6-tab HTML page (Status, Budget, Projects, Logs, Config, About)
  +-- GET /api/state     -> engine, budget, last run, recent logs, today's run count
  +-- GET /api/predict   -> local heuristic: next project/task/model (no API tokens)
  +-- GET /api/budget-detail -> full snapshot + 7-day histogram
  +-- GET /api/projects  -> roster with per-project history
  +-- GET /api/project-docs -> CLAUDE.md, DISPATCH.md, STATE.md, ROADMAP.md for each project
  +-- GET /api/logs      -> paginated JSONL (offset, limit, outcome/project filter)
  +-- GET /api/run-log   -> individual dispatcher-runs/*.log content (path-validated)
  +-- POST /api/engine   -> set engine_override
  +-- POST /api/pause    -> toggle pause
  +-- POST /api/dry-run  -> toggle dry_run
  +-- POST /api/dispatch -> trigger dispatch (--force, optional --dry-run)
  +-- POST /api/projects/reorder -> move project up/down in rotation
  +-- POST /api/projects/tasks   -> update project's opportunistic_tasks
```

### Manual testing

```
node scripts/dashboard.mjs                     # web UI at localhost:7380
node scripts/control.mjs                        # CLI menu (10 options)
node scripts/dispatch.mjs --force --dry-run     # inspect pipeline
node scripts/dispatch.mjs --force               # real dispatch now
cat status/budget-dispatch-last-run.json        # check results
```

### Key files modified this session

| File | What changed | Key lines |
|------|-------------|-----------|
| `scripts/run-dispatcher.ps1` | Activity gate bypass, .cmd resolution, .NET Process for claude -p | 375-385, 418-453, 457-570 |
| `scripts/dashboard.mjs` | Complete rewrite: 6 tabs, 8 new API endpoints, health beacon, prediction, budget bars, log drill-down, project docs | entire file (~1250 lines) |
| `scripts/control.mjs` | Enhanced: 10 menu options, prediction, log tail, weekly data, color output | entire file (~200 lines) |
| `scripts/dispatch.mjs` | libuv drain fix (setImmediate -> setTimeout) | line 257 |

## Part 10: what's left

### High-value next steps

1. **Add iOS apps to project rotation.** Create `CLAUDE.md` and `DISPATCH.md` in each iOS app repo defining pre-approved tasks (audit, explore, tests-gen, docs-gen). Add entries to `projects_in_rotation` in `config/budget.json`. The dispatcher and dashboard will pick them up automatically. Start with `audit` as the first task to get a baseline.

2. **Desktop notifications on dispatch.** Use PowerShell toast notifications (`New-BurntToastNotification` or `[Windows.UI.Notifications]`) to alert when a dispatch completes. Especially useful overnight -- check your notification center in the morning.

3. **Scheduled task health check in dashboard.** Add a Status tab indicator showing whether `BudgetDispatcher-Node` is registered and its next run time. Use `powershell -Command "(Get-ScheduledTaskInfo 'BudgetDispatcher-Node').NextRunTime"` from the dashboard server.

4. **Auto-open browser on dashboard start.** Add `import { exec } from 'node:child_process'; exec('start http://localhost:7380')` after `server.listen`. Small QoL win.

5. **WebSocket for live updates.** Replace 30s polling with file-watcher + push. Shows dispatch results the instant they happen. Node's `node:fs.watch` + `node:http` upgrade to WebSocket (no dependency needed). More responsive monitoring.

6. **System tray icon.** A tiny Node.js system tray app showing green/yellow/red dot for dispatcher status. Right-click menu for engine switching, pause, open dashboard. Would make the dispatcher visible without opening a browser. Moderate effort, needs `systray2` or similar.

7. **Budget trend sparkline.** Parse the last 7 days of JSONL and render headroom-over-time in the Budget tab. Would show whether headroom is trending toward positive (Claude activation imminent). The 7-day activity sparkline is already there; this would add a headroom line.

8. **Expand free model roster.** When Gemini 2.5 Flash or other free models become available, add them to `fallback_chain` in budget.json. The allowlist mode already supports this.

### Infrastructure-gated (needs WSL2 or Windows Sandbox)
- **S-1** Execution sandbox for generated code
- **S-2** Network isolation for test subprocesses

### Optional
- **I-4 native SDK reconciliation** -- swap `withTimeout` to native `AbortSignal.timeout`. Low priority.

## Part 10: things NOT to do

- Do not flip `dry_run` back to `true`.
- Do not re-enable the `ClaudeBudgetDispatcher` scheduled task (auto mode replaces it).
- Do not use `gemini-3-pro-preview` (bills Perry's Google Cloud credits).
- Do not commit `config/budget.json` (gitignored, local-only).
- Do not push `auto/` branches to origin.
- PS1 files must stay pure ASCII (R-6 pre-commit hook enforces this).
- Before any commit: run `mcp__pal__codereview` with model `gemini-2.5-pro`. Fallback to `review_validation_type: "internal"` if Gemini is 503-ing.
- Do not add `-ForceBudget` to the scheduled task arguments.

## Part 10: gotchas (appended to prior sessions)

8. **Budget estimate staleness is now solved.** Every firing (even node engine) refreshes `usage-estimate.json`.
9. **libuv UV_HANDLE_CLOSING assertion -- FIXED (`ff8b9ab`).** Was crashing dispatch.mjs on exit when API clients had open HTTP handles. Fixed by replacing `setImmediate` with `setTimeout(..., 200)` for handle drain. Tested 4x clean.
10. **Redundant estimator call** when auto resolves to claude. Harmless (~1s overhead).
11. **engine_override null vs "null".** PowerShell's ConvertFrom-Json returns `$null` for JSON `null`. The override reader checks both. Both are correct.
12. **Dashboard innerHTML -- NOW SAFE.** All dynamic content passes through `esc()` (HTML entity escaping) on both server and client side. XSS-safe even if external data enters the log pipeline.
13. **PowerShell .ps1 vs .cmd shim.** `Get-Command claude` on Windows resolves to `claude.ps1` (PowerShell preference), but `Start-Process` / `ProcessStartInfo` cannot execute `.ps1` files directly. The wrapper now swaps to `.cmd` sibling automatically.
14. **PowerShell 5.1 ExitCode null bug.** `Start-Process -PassThru` with `-RedirectStandardOutput` returns null ExitCode. Both engines now use `[System.Diagnostics.Process]::Start` with async stream capture instead.

---

# Historical context (Parts 5-9)

Parts 5 through 9 shipped the bulk of the audit findings (36 items), took both engines from dry-run to live, resolved the OneDrive junction / selector hot-fix / named mutex / error visibility / libuv crash, added auto mode with budget-adaptive routing, and shipped the engine switching dashboard with CLI control. See git log for full history. The key progression:

- **Part 5:** ajv blackout fix, selector hot-fix verified, R-3 named mutex
- **Part 6:** S-7 scanner, I-4 timeouts, R-5 log rotation, C-4 git fsck, R-7 index.lock cleanup, R-4 gist sync
- **Part 7:** libuv crash fix, S-8 npm audit, C-5 fallback chain, selector src/ filter, error visibility, dry_run=false flip
- **Part 8:** Auto mode, worktree cleanup, --force flag
- **Part 9:** Engine switching dashboard, CLI control, config override, -ForceBudget
- **Part 10:** Claude engine validation, dashboard redesign (6 tabs), CLI upgrade, libuv drain fix, PS 5.1 process launch fixes (this session)

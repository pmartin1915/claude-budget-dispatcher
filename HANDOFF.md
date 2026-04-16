# Handoff -- PC Claude instance (Part 12 -- 2026-04-16)

> **READ THIS FIRST.** Part 12 supersedes all previous parts. Parts 5-11 are historical context below.

## Part 12: TL;DR for next instance

- **Standalone tray .exe shipped (`1e26a58`, `6695d2d`).** `bin/BudgetDispatcher.exe` compiled from `scripts/tray-app.cs` via `csc.exe` (C# 5, .NET Framework, zero installs). Shows as "Budget Dispatcher" in Task Manager and tray settings. Green/yellow/red dot. Same functionality as `tray.ps1` -- exact behavioral port. Startup shortcut updated. Ran 8+ hours overnight without a crash.
- **Icon fix (`6695d2d`).** Original icons were 4-bit (GetHicon drops ARGB). Rewrote `tray-icons.ps1` to embed PNG data directly in ICO format -- proper 32-bit with transparency.
- **Gemini 2.5 Pro code review applied.** Resource disposal for Font/ContextMenuStrip/Timer, consolidated cleanup (Quit just calls Application.Exit), error log iteration matches PS1 behavior.
- **DISPATCHER-STATUS.md updated (`6f795f0`).** Added tray app section, toast notifications section, updated runtime state and quick reference. Also exported as DISPATCHER-STATUS.docx via pandoc.
- **Pushed to GitHub.** 22 commits pushed to origin/main.
- **Overnight results (8 hours, $0.00 cost):** 89 wrapper-successes, 5 real dispatches (1 audit, 2 proposals, 1 self-audit, 1 roadmap-review), all Gemini 2.5 Pro. Zero errors. Canary test audit found every planted bug.
- **All previous state unchanged.** `dry_run: false`, auto mode active, both engines validated, scorecard 36/36.

## Part 12: what was done (2026-04-16)

| Commit | What | Files |
|--------|------|-------|
| `1e26a58` | Standalone BudgetDispatcher.exe (C# port of tray.ps1) | `scripts/tray-app.cs`, `scripts/build-tray.cmd`, `.gitignore` |
| `6695d2d` | Regenerate icons as 32-bit PNG-in-ICO | `scripts/tray-icons.ps1`, `assets/tray-*.ico`, `scripts/tray-app.cs` |
| `6f795f0` | Updated DISPATCHER-STATUS.md with tray/notifications/dashboard sections | `DISPATCHER-STATUS.md` |

### Tray app architecture (updated)

```
bin/BudgetDispatcher.exe (C# WinForms, compiled from scripts/tray-app.cs)
  |-- NotifyIcon with green/yellow/red .ico (32-bit PNG-in-ICO)
  |-- ContextMenuStrip (Open Dashboard, Engine, Pause, Dispatch, Quit)
  |-- Timer (30s) -> GET /api/state -> update icon + tooltip + checkmarks
  |-- "Open Dashboard" -> scripts/dashboard-launcher.cmd -> Chrome
  |-- Single-instance mutex: Global\claude-budget-dispatcher-tray
  |-- Startup shortcut: shell:startup\Budget Dispatcher Tray.lnk -> bin\BudgetDispatcher.exe
  |-- Build: scripts\build-tray.cmd (csc.exe, no SDK needed)
```

`scripts/tray.ps1` kept as fallback/reference.

## Part 12: what's left

### Priority 1: Add real projects to the rotation

The dispatcher currently rotates between two sandbox repos. It needs real projects to do real work overnight. Perry's GitHub repos at `github.com/pmartin1915` are the source.

**Already cloned locally:**
- `c:\Users\perry\DevProjects\combo` -- TypeScript utility library with Jest tests, has CLAUDE.md already

**Best candidates to add (most recently active, real codebases):**

| Repo | Language | Description | Why |
|------|----------|-------------|-----|
| `combo` | TypeScript | Utility library with Jest tests | Already cloned, has CLAUDE.md, tests exist -- easiest first target |
| `boardbound` | TypeScript | (recently active) | Clone needed |
| `shortless-ios` | Swift | Safari content blocker for iOS | Clone needed, Perry mentioned iOS apps specifically |
| `shortless` | TypeScript | Content blocker (non-iOS) | Clone needed |
| `medilex` | TypeScript | (medical domain) | Clone needed, may need clinical_gate: true |
| `wilderness` | TypeScript | React survival game (Vite, Playwright) | Clone needed, has Playwright tests |
| `burn-wizard` | TypeScript | (recently active) | Clone needed |

**For each project, the next instance should:**

1. Clone to `c:\Users\perry\DevProjects\` if not already there
2. Check if `CLAUDE.md` exists; if not, create one (project overview, key constraints, architecture)
3. Check if `DISPATCH.md` exists; if not, create one with pre-approved tasks:
   ```markdown
   # Dispatch Configuration
   ## Pre-Approved Tasks
   | Task | Description |
   |------|-------------|
   | audit | Review codebase for bugs, security issues, code quality |
   | explore | Map architecture, dependencies, and patterns |
   | tests-gen | Generate missing test cases |
   | docs-gen | Generate or improve documentation |
   ```
4. Add entry to `projects_in_rotation` in `config/budget.json`:
   ```json
   {
     "slug": "combo",
     "path": "c:\\Users\\perry\\DevProjects\\combo",
     "clinical_gate": false,
     "opportunistic_tasks": ["audit", "explore", "tests-gen", "docs-gen"]
   }
   ```
5. Set `clinical_gate: true` for any medical/clinical repos (medilex, ecg-wizard-pwa)
6. Start with `audit` as the first task -- get a baseline before doing generative work
7. Verify: `node scripts/dispatch.mjs --force --dry-run` should show the new project in selector output

**Start with combo** (already cloned, has CLAUDE.md) -- it's the quickest win. Then add 2-3 more. Don't add all at once; verify each one dispatches successfully before adding the next.

### Priority 2: Create greenfield "extra-sub-standalone" projects

These are **new projects built from scratch by the dispatcher** over multiple dispatch cycles. Each one is a standalone repo that the AI bootstraps, scaffolds, and incrementally builds. The naming convention is `extra-sub-standalone-<slug>`. Existing examples: `extra-sub-standalone-canary-test`, `extra-sub-standalone-workflow-enhancement`.

**Perry's wishlist -- create these 5 projects:**

| Slug | What | First tasks |
|------|------|-------------|
| `biz-app` | A business application or business model tool | scaffold, plan, design |
| `game-adventure` | A playable game (genre TBD by the model) | scaffold, plan, design, implement |
| `dnd-math` | D&D-themed math game -- planning, lore, scaffolding, game mechanics | plan, worldbuild, scaffold, implement |
| `sand-physics` | Sand/particle physics simulation game (like Noita or falling sand) | scaffold, plan, implement |
| `worldbuilder` | Worldbuilding project -- lore, maps, factions, history, narrative | plan, worldbuild, docs-gen |

**How to set up each one:**

1. Create a new repo at `c:\Users\perry\DevProjects\sandbox\extra-sub-standalone-<slug>\`
   - `git init`, create initial commit
2. Create `CLAUDE.md` -- project charter explaining what this project is, the tech stack, the vision. This is what the model reads on every dispatch to understand the project.
3. Create `DISPATCH.md` -- pre-approved tasks. Start with `plan` and `scaffold` tasks, then expand to `implement`, `tests-gen`, `audit` as the project grows.
4. Create `STATE.md` -- empty initially, the dispatcher updates this after each run to track what's been done and what's next. This is how continuity works across dispatch cycles.
5. Create `ROADMAP.md` -- high-level goals and milestones.
6. Add to `projects_in_rotation` in `config/budget.json` with appropriate tasks.

**The self-improvement loop:**
```
Dispatch cycle 1: plan (model reads CLAUDE.md, writes ROADMAP.md, STATE.md)
Dispatch cycle 2: scaffold (creates project structure, package.json, etc.)
Dispatch cycle 3: implement (picks a roadmap item, writes code, commits)
Dispatch cycle 4: audit (reviews what was built, finds issues)
Dispatch cycle 5: implement (fixes audit findings or adds next feature)
...repeat indefinitely, each cycle building on the last
```

The model reads STATE.md to know what was done last time and what to do next. Each dispatch updates STATE.md so the next dispatch has context. Over days and weeks, these projects grow from empty repos into real applications.

**Key:** The `extra-sub-standalone` projects use the structured subagent workflow from the sandbox-workflow-enhancement proposals (9-phase protocol: orient, plan, second opinion, execute, self-test, cross-model audit, fix, retest, commit). The `DISPATCH.md` complexity class determines which phases apply.

### Other next steps

1. **WebSocket for live dashboard updates.** Replace 30s polling with file-watcher + push. Node's `node:fs.watch` on status/ + `node:http` upgrade to WebSocket (no dependency needed).

2. **Budget trend sparkline.** Parse last 7 days of JSONL and render headroom-over-time in Budget tab.

3. **Expand free model roster.** Add new free models to `fallback_chain` in budget.json as they become available.

## Part 12: things NOT to do

- Do not flip `dry_run` back to `true`.
- Do not re-enable the `ClaudeBudgetDispatcher` scheduled task (auto mode replaces it).
- Do not use `gemini-3-pro-preview` (bills Perry's Google Cloud credits).
- Do not commit `config/budget.json` (gitignored, local-only).
- Do not push `auto/` branches to origin.
- PS1 files must stay pure ASCII (R-6 pre-commit hook enforces this).
- Before any commit: run `mcp__pal__codereview` with model `gemini-2.5-pro`. Fallback to `review_validation_type: "internal"` if Gemini is 503-ing.
- Do not add `-ForceBudget` to the scheduled task arguments.
- Do not kill or restart `BudgetDispatcher.exe` unless rebuilding -- it auto-starts on login.

## Part 12: gotchas (appended to prior sessions)

8. **Budget estimate staleness is now solved.** Every firing (even node engine) refreshes `usage-estimate.json`.
9. **libuv UV_HANDLE_CLOSING assertion -- FIXED (`ff8b9ab`).** Was crashing dispatch.mjs on exit when API clients had open HTTP handles. Fixed by replacing `setImmediate` with `setTimeout(..., 200)` for handle drain. Tested 4x clean.
10. **Redundant estimator call** when auto resolves to claude. Harmless (~1s overhead).
11. **engine_override null vs "null".** PowerShell's ConvertFrom-Json returns `$null` for JSON `null`. The override reader checks both. Both are correct.
12. **Dashboard innerHTML -- NOW SAFE.** All dynamic content passes through `esc()` (HTML entity escaping) on both server and client side. XSS-safe even if external data enters the log pipeline.
13. **PowerShell .ps1 vs .cmd shim.** `Get-Command claude` on Windows resolves to `claude.ps1` (PowerShell preference), but `Start-Process` / `ProcessStartInfo` cannot execute `.ps1` files directly. The wrapper now swaps to `.cmd` sibling automatically.
14. **PowerShell 5.1 ExitCode null bug.** `Start-Process -PassThru` with `-RedirectStandardOutput` returns null ExitCode. Both engines now use `[System.Diagnostics.Process]::Start` with async stream capture instead.
15. **Toast notification on skip-as-success.** When dispatch.mjs skips (user-active) it exits 0, so the PS1 wrapper sees "success" and fires a toast. The toast says "Dispatch: success" but no project/task since the JSONL's wrapper-success entry has none. This is by design -- the important toasts are real dispatches with work product, which DO have project/task info.
16. **Dashboard execFileSync and scheduled task.** `getScheduledTaskInfo()` uses `execFileSync("powershell", ...)` which bypasses cmd.exe entirely -- no quote-escaping issues. If you test from bash with `node -e "..."`, the `$` in PowerShell vars gets eaten by bash. The actual dashboard.mjs file uses JS strings (not template literals) so `$` passes through correctly.
17. **Icon 4-bit color loss -- FIXED (`6695d2d`).** `Bitmap.GetHicon()` + `Icon.Save()` drops to 4-bit, losing antialiasing and transparency. Fixed by writing PNG data directly into the ICO container (PNG-in-ICO, Vista+). Icons are now 32-bit ARGB.
18. **pandoc installed via winget.** Located at `c:/Users/perry/AppData/Local/Pandoc/pandoc.exe`. Not in bash PATH but works via full path or cmd.exe.

---

# Historical context (Parts 5-11)

Parts 5 through 11 shipped the bulk of the audit findings (36 items), took both engines from dry-run to live, resolved the OneDrive junction / selector hot-fix / named mutex / error visibility / libuv crash, added auto mode with budget-adaptive routing, shipped the dashboard with CLI control, validated both engines, added desktop notifications, system tray app, and compiled the tray app into a standalone .exe. See git log for full history. The key progression:

- **Part 5:** ajv blackout fix, selector hot-fix verified, R-3 named mutex
- **Part 6:** S-7 scanner, I-4 timeouts, R-5 log rotation, C-4 git fsck, R-7 index.lock cleanup, R-4 gist sync
- **Part 7:** libuv crash fix, S-8 npm audit, C-5 fallback chain, selector src/ filter, error visibility, dry_run=false flip
- **Part 8:** Auto mode, worktree cleanup, --force flag
- **Part 9:** Engine switching dashboard, CLI control, config override, -ForceBudget
- **Part 10:** Claude engine validation, dashboard redesign (6 tabs), CLI upgrade, libuv drain fix, PS 5.1 process launch fixes
- **Part 11:** Desktop toast notifications, scheduled task health in dashboard, auto-open browser, system tray app (PowerShell)
- **Part 12:** Standalone BudgetDispatcher.exe (C# port), icon fix (32-bit PNG-in-ICO), DISPATCHER-STATUS.md update, pandoc install

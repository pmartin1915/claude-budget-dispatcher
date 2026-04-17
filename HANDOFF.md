# Handoff -- Laptop Claude instance (Part 14 -- 2026-04-16)

> **READ THIS FIRST.** Part 14 supersedes all previous parts. Read the TL;DR, then "what was done" and "what's left".

## Part 14: TL;DR for next instance

- **Fleet progress dashboard shipped.** New "Fleet" tab on the dashboard (`localhost:7380`), 7th tab between Config and About. Shows all 11 projects as rows with colored phase cells: green (complete), yellow (in-progress), gray (not-started). Parses each project's ROADMAP.md (3 different markdown formats handled). API endpoint: `GET /api/fleet`.
- **Dispatcher ran overnight on PC.** Activity gate working (skips when Perry is active). Selector picks projects correctly (combo, canary-test, workflow-enhancement all dispatched). Cross-family audit working (Gemini generates, Mistral audits).
- **Overnight reverts explained and fixed.** All overnight dispatches to combo/wilderness/boardbound were reverted because `npm test` in `verify-commit.mjs` failed — `node_modules` wasn't installed. Perry manually ran `npm install` on combo (48 tests pass), wilderness (517 pass), boardbound (736 pass, 2 pre-existing date-sensitive failures). Next idle window should produce successful commits.
- **Dispatch stats (first 24h with 11 projects):** 20 successes (workflow-enhancement), 13 reverts (combo — now fixed), 8 dry-runs. Selector correctly prioritizes never-dispatched projects.
- **Interconnected fleet vision unchanged.** Signal fires, not bridges. Worldbuilder exports lore JSON -> dnd-game imports. Each project independently useful.
- **boardbound has 2 flaky date tests.** Dispatches to boardbound will still revert until those are fixed or the dispatcher picks a task that doesn't trigger verify.
- **All previous state unchanged.** `dry_run: false`, auto mode active, tray app running, Ollama running, 11 projects in rotation.

## Part 14: what was done (2026-04-16)

### Fleet progress dashboard (PC instance)

| Change | Detail |
|--------|--------|
| `parseRoadmap()` | Unified markdown parser handles 3 formats: (A) checkbox `- [x]`/`- [ ]` for greenfield, (B) freeform bullets with `*(done)*` markers for combo, (C) goal-based `**Status:** DONE` for workflow-enhancement |
| `getFleetData()` | Aggregates ROADMAP.md (checks root then `ai/`) + JSONL log stats per project |
| `GET /api/fleet` | Returns `{ projects: [{ slug, phases: [{name, total, done, status}], last_dispatch, total_dispatches }] }` |
| Fleet tab UI | Per-project rows with colored phase cells. Legend, summary footer with aggregate counts. No auto-refresh (roadmaps change infrequently). |
| File changed | `scripts/dashboard.mjs` only (+211 lines). No other files touched. |

### Perry's npm install fixes (manual)

| Project | Result | Notes |
|---------|--------|-------|
| combo | `npm install` -> 48 tests pass | Was causing all overnight reverts |
| wilderness | `npm install` -> 517 tests pass | Ready for dispatch |
| boardbound | `npm install` -> 736 pass, 2 fail | 2 date-sensitive test failures (pre-existing, not dispatcher-caused) |

### Overnight dispatch observations

- **Runs/24h:** ~151 log entries (57 wrapper-success, 46 skipped, 20 success, 14 dry-run, 13 reverted, 1 error)
- **Projects touched:** workflow-enhancement (44 total dispatches), combo (8), canary-test (8)
- **Greenfield projects (5):** 0 dispatches yet — selector has been favoring combo and workflow-enhancement. Once combo stops reverting, selector should start distributing to greenfield projects.
- **Revert pattern:** All reverts were combo audits that passed Gemini worker + cross-family Mistral audit but failed `npm test` in verify-commit (jest not found). Now fixed.

## Part 14: what's left

### For the laptop instance (Perry at girlfriend's house)

1. **Monitor overnight dispatches.** Check the Gist sync or `status/budget-dispatch-log.jsonl` to see if combo dispatches now commit successfully. Look for the first `auto/combo-*` branches.
2. **Check greenfield project distribution.** After combo stops reverting, the selector should start picking the 5 never-dispatched greenfield sandboxes. Monitor if this happens.
3. **boardbound date tests.** Two pre-existing date-sensitive test failures cause boardbound dispatches to revert. Options: (a) fix the tests, (b) mark them as skipped, (c) wait for the dispatcher to pick a task that doesn't trigger verify.
4. **shortless-ios has no tests.** DISPATCH.md only allows audit/explore/docs-gen. Verify these tasks work (no npm test step needed for audit/explore).

### Deferred from Part 13 (still relevant)

5. **Groq API key.** Perry needs to sign up at https://console.groq.com and set `GROQ_API_KEY` env var. Free tier, no credit card.
6. **OpenRouter API key** (optional). Sign up at https://openrouter.ai, set `OPENROUTER_API_KEY`.
7. **Add burn-wizard to rotation.** Clone from `github.com/pmartin1915/burn-wizard`, create DISPATCH.md, add to config.
8. **Optiplex thin-client test.** `curl http://<PC-IP>:11434/v1/chat/completions` should work (OLLAMA_HOST=0.0.0.0, firewall rule exists).
9. **Cross-project status board.** Wire GitHub Issue pmartin1915/claude-budget-dispatcher#1 machine registry into the fleet dashboard so colored cells also show which machine last touched each project.

## Part 14: things NOT to do

- Do not modify provider.mjs, router.mjs, throttle.mjs, worker.mjs, dispatch.mjs (laptop owns code changes).
- Do not flip `dry_run` back to `true`.
- Do not use `gemini-3-pro-preview` (bills Google Cloud credits).
- Do not commit `config/budget.json` (gitignored).
- Do not uninstall node_modules from combo/wilderness/boardbound (the fix that unblocked overnight dispatches).
- Before any commit to tracked repos: run `mcp__pal__codereview` with model `gemini-2.5-pro`.

## Part 14: gotchas

25. **ROADMAP.md location varies.** Greenfield sandboxes have `ROADMAP.md` at project root. workflow-enhancement has `ai/ROADMAP.md`. The fleet dashboard checks both locations (root first, then `ai/`). The existing `getProjectDocs()` only checks `ai/ROADMAP.md` — if you add a new project, put ROADMAP.md at root for the fleet tab to find it.
26. **combo ROADMAP uses freeform format.** Not checkboxes — uses `*(done YYYY-MM-DD)*` markers on bullets and `## Now / Next / Later` sections. The parser handles this but new projects should prefer checkbox format.
27. **Fleet tab has no auto-refresh.** Switch away and back to reload. Roadmaps don't change frequently enough to warrant a polling interval.
28. **Dashboard must be restarted to pick up code changes.** The HTML is embedded as a template string in dashboard.mjs. If you edit the file, you must restart the dashboard process.

---

## Part 13: TL;DR for next instance (superseded by Part 14)

- **11 projects in rotation** (was 2). 4 real repos (combo, boardbound, shortless-ios, wilderness) + 2 existing sandboxes + 5 new greenfield sandboxes (biz-app, game-adventure, dnd-game, sand-physics, worldbuilder).
- **Per-project model routing shipped** (`b1e66d8`, laptop). `project_overrides` in budget.json with per-task fallback chains. boardbound uses Flash for explore, Pro for audit. combo/shortless-ios have Pro-first routing. Ollama models as codegen fallback.
- **Multi-provider support shipped** (`b1e66d8`, laptop). provider.mjs handles Gemini/Mistral/Groq/OpenRouter/Ollama via unified `callProvider()`. Budget.json `providers` block configures endpoints and throttles.
- **Ollama installed and running** on PC. Vulkan enabled (AMD RDNA2). 3 models pulled: `qwen2.5-coder:7b` (4.7 GB), `qwen2.5-coder:14b` (9.0 GB), `devstral-small-2:24b` (15 GB). Listens on `0.0.0.0:11434` for Optiplex thin-client access.
- **Groq and OpenRouter keys NOT SET.** Perry needs to sign up and add env vars manually. Dispatch works without them (informational warning only).
- **dnd-game and worldbuilder bridge** set up. Both CLAUDE.md files reference each other as sister projects. Worldbuilder produces lore; dnd-game consumes it via lore adapter interface.
- **Perry's vision: interconnected project fleet.** The 5 greenfield sandboxes are designed to eventually connect via **signal fires** (status announcements + JSON data contracts), not code coupling. Worldbuilder exports lore -> dnd-game imports it. game-adventure could share the same world. sand-physics could power environmental sim. biz-app could model faction economies. Each project stays independent but broadcasts readiness for others to consume. **Next step:** fleet progress dashboard showing all projects' roadmap phases as colored cells.
- **All previous state unchanged.** `dry_run: false`, auto mode active, tray app running, 11 projects verified with `--force --dry-run`.

## Part 13: what was done (2026-04-16)

### Session 1: Projects and rotation expansion

| Action | What | Details |
|--------|------|---------|
| combo | Created DISPATCH.md, added to config | Committed to combo repo (`0a3cb92`) |
| boardbound | Cloned from GitHub, added to config | Already had CLAUDE.md + DISPATCH.md + ai/STATE.md |
| shortless-ios | Cloned, created CLAUDE.md + DISPATCH.md + ai/STATE.md | Committed (`dfaa2ab`), audit/explore/docs-gen only (Swift, no npm test) |
| wilderness | Cloned from GitHub, added to config | Already had CLAUDE.md + DISPATCH.md + ai/STATE.md |
| biz-app | Greenfield scaffold + git init | `c74e3f2` -- business tool, model chooses which |
| game-adventure | Greenfield scaffold + git init | `c3d2cc5` -- playable game, genre TBD |
| dnd-game | Greenfield scaffold + git init | `c6d3c93` -- real D&D game, teaching toggle, bridges to worldbuilder |
| sand-physics | Greenfield scaffold + git init | `8c0e679` -- falling sand sim (Noita-style) |
| worldbuilder | Greenfield scaffold + git init | `fce36b7` -- GoT/Skyrim worldbuilding, bridges to dnd-game |

### Session 2: Multi-provider integration (PC-side config)

| Action | What |
|--------|------|
| Pulled `b1e66d8` | Per-project routing + multi-provider support from laptop |
| Added `providers` block | groq (6s throttle), openrouter (10s), ollama (0ms) |
| Added `project_overrides` | boardbound (Flash explore, Pro audit, Ollama codegen fallback), combo (Pro for clinical, Ollama fallback), shortless-ios (Pro for Swift) |
| Installed Ollama 0.20.7 | Via winget, OLLAMA_VULKAN=1, OLLAMA_HOST=0.0.0.0:11434 |
| Pulled 3 models | qwen2.5-coder:7b, qwen2.5-coder:14b, devstral-small-2:24b |
| Verified provider.mjs -> Ollama | `callProvider("local/qwen2.5-coder:7b", ...)` returns correct response |

### Routing matrix (live in budget.json)

| Project | explore | audit | tests_gen | docs_gen | audit_model |
|---------|---------|-------|-----------|----------|-------------|
| **boardbound** | Flash > Pro | Pro | Codestral > Ollama:14b | Mistral > Flash | tests: Pro, refactor: Mistral |
| **combo** | Pro | Pro | Codestral > Ollama:14b | Mistral | tests: Pro |
| **shortless-ios** | Pro | Pro | (not in tasks) | Pro > Mistral | -- |
| **wilderness** | (global) | (global) | (global) | (global) | auto C-1 |
| **all sandboxes** | (global) | (global) | (global) | (global) | auto C-1 |

Global defaults: explore/audit/research -> gemini-2.5-pro, tests_gen/refactor -> codestral-latest, docs_gen -> mistral-large-latest. Fallback: Pro > Flash > Mistral.

## Part 13: what's left

### Perry manual steps (can't be automated)

1. **Groq API key.** Sign up at https://console.groq.com. Free tier, no credit card. Then:
   ```powershell
   [Environment]::SetEnvironmentVariable('GROQ_API_KEY', 'gsk_YOUR_KEY_HERE', 'User')
   ```
   Test: `node -e "import('./scripts/lib/provider.mjs').then(m => m.callProvider({gemini:null,mistral:null}, {groq:{base_url:'https://api.groq.com/openai/v1',env_key:'GROQ_API_KEY'}}, 'groq/llama-3.3-70b-versatile', 'Say hello').then(console.log))"`

2. **OpenRouter API key** (optional). Sign up at https://openrouter.ai. Then:
   ```powershell
   [Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', 'sk-or-YOUR_KEY', 'User')
   ```

### Next priorities

1. **Fleet progress dashboard.** Perry wants a visual board showing all 11 projects' roadmap progress at a glance -- colored cells (green/yellow/gray) per phase. Natural home: new tab on the existing dashboard (localhost:7380) or extension of the Projects tab. Data sources: each project's `ai/STATE.md` (what's done), `ROADMAP.md` (phases), and the JSONL dispatch log (task outcomes + timestamps). Design principle: **signal fires, not bridges** -- projects announce readiness ("geography phase 1 complete") but never reach into each other's code. The dnd-game/worldbuilder connection and future cross-project integrations are data contracts (JSON export/import), not code coupling.
2. **Let the dispatcher run overnight with 11 projects.** Monitor the log: `tail -20 status/budget-dispatch-log.jsonl`. The selector should distribute across projects, prioritizing never-dispatched ones first.
3. **Add Groq models to fallback chains.** Groq key is set and verified. E.g. `"groq/llama-3.3-70b-versatile"` in boardbound's tests_gen chain.
4. **Add burn-wizard to rotation** (mentioned in task list but not yet cloned/configured). Clone from `github.com/pmartin1915/burn-wizard`, create DISPATCH.md, add to config.
5. **Optiplex thin-client test.** From the Optiplex, `curl http://<PC-IP>:11434/v1/chat/completions ...` should work since OLLAMA_HOST=0.0.0.0. Firewall rule for port 11434 already created. Perry is setting up Optiplex now.
6. **Cross-project status board (laptop instance shipped scripts/status.mjs).** GitHub Issue pmartin1915/claude-budget-dispatcher#1 has machine registry + structured comment protocol. Instances post checkin/checkout when working on shared repos. Wire this into the fleet progress dashboard so the colored board also shows which machine last touched each project.

## Part 13: things NOT to do

- Do not modify provider.mjs, router.mjs, throttle.mjs, worker.mjs, dispatch.mjs (laptop owns code changes).
- Do not flip `dry_run` back to `true`.
- Do not use `gemini-3-pro-preview` (bills Google Cloud).
- Do not commit `config/budget.json` (gitignored).
- Before any commit to tracked repos: run `mcp__pal__codereview` with model `gemini-2.5-pro`.
- Do not kill Ollama service unless testing Vulkan restart.

## Part 13: gotchas

19. **Ollama auto-starts on login.** The installer creates a startup entry. If you need to restart with new env vars, quit via tray icon and relaunch from Start menu.
20. **`local/` prefix required.** In budget.json, Ollama models must be prefixed with `local/` (e.g. `"local/qwen2.5-coder:14b"`). `providerFor()` in provider.mjs routes based on this prefix.
21. **Groq/OpenRouter warnings are informational.** `[dispatch] provider "groq" configured but GROQ_API_KEY not set` appears on every dry-run. It doesn't block dispatch. The warning disappears once the key is in the environment.
22. **boardbound has no `src/` directory.** Source lives in `app/`, `lib/`, `components/`. The `NEEDS_SRC` filter in context.mjs means `tests-gen`, `docs-gen`, `refactor`, `clean` are auto-filtered for boardbound. Only `audit` and `explore` will fire until the project gets a `src/` directory or context.mjs is updated.
23. **shortless-ios `docs-gen` is also filtered.** Same `NEEDS_SRC` issue -- Swift source is in `ShortlessApp/`, not `src/`. Only `audit` and `explore` will fire. This is intentional and noted in the DISPATCH.md.
24. **devstral-small-2:24b is 15 GB.** Loading it takes ~30s on first call (GPU memory allocation). Subsequent calls are fast. The 14b qwen model is the better default for codegen fallback (faster load, good quality).

---

## Part 12: TL;DR for next instance (superseded by Part 13)

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
| `dnd-game` | A real D&D game with balanced mechanics (see detailed spec below) | plan, scaffold, implement |
| `sand-physics` | Sand/particle physics simulation game (like Noita or falling sand) | scaffold, plan, implement |
| `worldbuilder` | Worldbuilding: grounded, realistic lore (see detailed spec below) | plan, worldbuild, docs-gen |

**Detailed spec: `dnd-game`**

This is NOT a math-teaching app. It's a **real, playable D&D game** with proper balanced mechanics -- dice rolls, stat modifiers, combat, encounters, leveling. It can start text-based (terminal or simple web UI). The game should feel like an actual D&D session, not a classroom exercise.

- Real D&D-style mechanics: d20 rolls, ability scores, AC, saving throws, initiative, etc.
- Balanced encounters with actual challenge ratings
- Character creation, progression, inventory
- **Teaching toggle:** An optional mode (off by default) that, when enabled, shows the math behind what just happened -- "You rolled 14 + 3 STR modifier = 17, beating the goblin's AC of 15." When off, it just says "You hit the goblin." The toggle should feel like a coach whispering in your ear, not a textbook interrupting the game.
- The goal is: someone who has never played D&D can turn the toggle on and learn how it works by playing. Someone who already knows can turn it off and just enjoy the game.

**Detailed spec: `worldbuilder`**

Grounded, "realistic" worldbuilding in the tone of **Game of Thrones** and **Skyrim** -- political intrigue, geography that makes sense, factions with believable motivations, history with cause and effect. Not high-fantasy cartoon. Think: a world that could support a serious RPG campaign.

- Lore documents: history, geography, factions, notable figures, religions, economy
- Internal consistency -- if a kingdom is landlocked, it doesn't have a navy
- Maps (text-based descriptions initially, can be visualized later)
- Designed to eventually be used BY the dnd-game project as its setting

**Bridge between dnd-game and worldbuilder:** These two projects are designed to merge later. The worldbuilder creates the setting; the dnd-game uses it. For now they develop independently, but their CLAUDE.md files should reference each other so the models know the connection exists.

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

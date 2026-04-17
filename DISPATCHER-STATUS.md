   # Dispatcher Status & Engine Guide

> Last updated: 2026-04-16 (Part 13 session)

---

## What this system does

The **claude-budget-dispatcher** fires every 20 minutes via Windows Task Scheduler. When you've been idle for 20+ minutes, it picks a project and task from your rotation, does bounded work (tests, audits, docs, codegen), commits to a throwaway `auto/` branch, and logs the result. You review and merge (or discard) later.

There are **two engines** that can run the pipeline. They share the same wrapper (`run-dispatcher.ps1`), the same config (`config/budget.json`), the same activity gate, and the same projects. They differ in what does the thinking.

---

## The Two Engines

### Engine A: Claude-oversighted (`-Engine claude`)

|                       |                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scheduled task**    | `ClaudeBudgetDispatcher` (currently **disabled**)                                                                                                                            |
| **Entry point**       | `run-dispatcher.ps1 -Engine claude` -> `claude -p < tasks/budget-dispatch.md`                                                                                                |
| **Who thinks**        | Claude Max (your Anthropic subscription)                                                                                                                                     |
| **Cost per run**      | ~$0.20-1.00 in Claude Max tokens                                                                                                                                             |
| **Budget gate**       | Required. `estimate-usage.mjs` checks weekly/monthly headroom before firing. Only runs when you're under-pace on your subscription.                                          |
| **Activity gate**     | Required. 20 min idle.                                                                                                                                                       |
| **How it picks work** | Claude reads each project's STATE.md and DISPATCH.md, reasons about what to do, then either does the work itself (Branch A) or delegates to a free model via PAL (Branch B). |
| **Audit model**       | Claude audits Claude (same family -- shared-blind-spot risk, but mitigated by Claude's strong judgment)                                                                      |
| **Safety model**      | Claude is in the loop for every decision. Human-equivalent judgment on edge cases.                                                                                           |
| **Best for**          | Complex tasks: architecture reviews, multi-file refactors, clinical domain work, design decisions, anything in the `claude_only` list.                                       |

**Why you want this engine:** It uses your subscription tokens that would otherwise expire unused. It handles the hard stuff -- design, security, architecture -- that free models aren't trusted with. The budget gate ensures it only fires when you have headroom to spare.

**Current state:** Disabled. To re-enable, activate the `ClaudeBudgetDispatcher` scheduled task in Task Scheduler. **Do not enable both engines simultaneously** -- they'd race on the mutex and double-bill.

---

### Engine B: Free-model (`-Engine node`)

|                       |                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scheduled task**    | `BudgetDispatcher-Node` (currently **active, firing every 20 min**)                                                                                               |
| **Entry point**       | `run-dispatcher.ps1 -Engine node` -> `node scripts/dispatch.mjs`                                                                                                  |
| **Who thinks**        | Gemini 2.5 Pro/Flash, Mistral Large, Codestral (all free tier)                                                                                                    |
| **Cost per run**      | $0.00                                                                                                                                                             |
| **Budget gate**       | Skipped (free tier = no budget to track)                                                                                                                          |
| **Activity gate**     | Required. 20 min idle.                                                                                                                                            |
| **How it picks work** | `selector.mjs` sends project context to Gemini Flash, which returns a structured JSON pick. `router.mjs` maps the task to a model.                                |
| **Audit model**       | Cross-family: if Gemini generated the code, Mistral audits it (and vice versa). No shared blind spots.                                                            |
| **Safety model**      | Schema validation (ajv), path-escape checks, env allowlisting, clinical gate, security scanner -- explicit guards because there's no Claude judgment in the loop. |
| **Best for**          | High-frequency mechanical work: test generation, docs, code exploration, audits, refactoring. Runs unlimited times per day at zero cost (rate-limit permitting).  |

**Why you want this engine:** It's free and unlimited. Rate limits are the only constraint, and the C-5 fallback chain (shipped this session) means a 503 on one model just rolls to the next. It can run 50+ times a day without touching your subscription.

**Current state:** Active. `dry_run: false`. First live dispatch completed successfully this session (roadmap-review on sandbox-workflow-enhancement, Gemini 2.5 Pro, 53 seconds).

---

## Side-by-side comparison

| Concern             | Claude engine                            | Free-model engine                           |
| ------------------- | ---------------------------------------- | ------------------------------------------- |
| Scheduled task      | Selected by auto mode when budget allows | Selected by auto mode when budget is tight  |
| Fires every         | 20 min                                   | 20 min                                      |
| Cost                | ~$0.20-1.00/run                          | $0.00/run                                   |
| Budget gate         | Yes (protects subscription)              | No (nothing to protect)                     |
| Activity gate       | Yes (20 min idle)                        | Yes (20 min idle)                           |
| Selector            | Claude reasoning                         | Gemini 2.5 Flash (structured JSON)          |
| Worker              | Claude Max                               | Gemini/Mistral/Codestral                    |
| Fallback on 503     | N/A (single model)                       | Walks candidate chain (C-5)                 |
| Cross-family audit  | No (Claude audits Claude)                | Yes (Gemini <-> Mistral)                    |
| Schema validation   | No (trusts Claude output)                | Yes (ajv on all LLM output)                 |
| Security scanner    | No                                       | Yes (scan.mjs, 13 secret + 8 code patterns) |
| `claude_only` tasks | Can do them                              | Skips them (returns to Claude)              |
| Max runs/day        | 50 (budget-gated)                        | 50 (config limit, but no cost pressure)     |
| Commits to          | `auto/` branches                         | `auto/` branches                            |
| Pushes to origin    | Never                                    | Never                                       |

---

## System tray app

A green/yellow/red dot lives next to your clock showing dispatcher health at a glance. No browser needed.

| Icon color | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| Green      | Healthy -- dispatches running normally (free models or Claude authorized) |
| Yellow     | Paused -- you (or something) paused the dispatcher                        |
| Red        | Errors detected (2+ recent failures) or dashboard offline                 |

**Right-click menu:**
- **Open Dashboard** -- launches Chrome to the web UI (starts the dashboard if it's not already running)
- **Engine: Auto / Free Only / Claude** -- switch engines instantly (checkmark shows current)
- **Pause / Resume** -- toggle dispatching on/off
- **Dispatch Now** -- trigger an immediate run
- **Quit** -- close the tray app

**Double-click** the icon to open the dashboard.

**How it works:** `bin/BudgetDispatcher.exe` is a standalone Windows app (C# WinForms, compiled from `scripts/tray-app.cs`). It polls `localhost:7380/api/state` every 30 seconds and swaps the icon color based on what it finds. Shows as "Budget Dispatcher" in Task Manager and tray settings -- not "Windows PowerShell" like the old PowerShell version.

**Pinning it:** Settings > Personalization > Taskbar > Other system tray icons > toggle "Budget Dispatcher" on. It auto-starts on login via a shortcut in `shell:startup`.

**Rebuilding it:** If you ever need to recompile, run `scripts\build-tray.cmd`. It uses `csc.exe` that ships with Windows -- no SDK or Visual Studio needed.

---

## Desktop notifications

When a dispatch completes, a Windows toast notification pops up in the corner and stays in your Notification Center. Useful overnight -- check your notifications in the morning to see what happened.

| Toast shows       | Example                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| Outcome           | "Dispatch: success" or "Dispatch: error"                                          |
| Engine & duration | "Engine: node, Duration: 3s"                                                      |
| Project & task    | "Project: sandbox-canary-test, Task: tests-run" (pulled from the last JSONL line) |

Skipped runs (user was active) stay silent -- no notification spam. The toast system uses the Windows WinRT notification API, zero dependencies.

---

## How to switch between engines

Both engines use the same mutex (`Global\claude-budget-dispatcher`), so they can't run simultaneously.

**Auto mode (current setup -- recommended):**
```powershell
# run-dispatcher.ps1 -Engine auto
# Checks budget estimate on every firing:
#   - If dispatch_authorized=true (budget has headroom) -> uses Claude engine
#   - Otherwise -> uses free-model engine
# Fail-safe: defaults to free models on any error
```

The `BudgetDispatcher-Node` scheduled task uses `-Engine auto`. The old `ClaudeBudgetDispatcher` task is disabled and no longer needed.

**System tray (quickest):**
Right-click the green dot next to your clock. Pick "Engine: Auto", "Engine: Free Only", or "Engine: Claude". Done.

**Dashboard (full control):**
```bash
node scripts/dashboard.mjs        # opens http://localhost:7380
# Or: npm run dashboard
```
Six-tab web UI: Status (health beacon, scheduled task info, prediction), Budget (trajectory, sparkline), Projects (roster management), Logs (paginated, drill-down), Config (all settings), About (project charters). Click a button to switch engines instantly. The override persists in `config/budget.json` -- no admin privileges needed, works even when the dashboard isn't running. Auto-opens Chrome on startup.

**CLI control (terminal alternative):**
```bash
node scripts/control.mjs           # interactive menu
# Or: npm run control
```
10-option menu: engine switch, pause, dry-run toggle, real dispatch, prediction, log tail, open browser.

**Config override (manual):**
Set `"engine_override"` in `config/budget.json` to `"node"`, `"claude"`, or `null` (auto). The scheduled task reads this on every firing.

**Force a specific engine (command line):**
```powershell
# Override auto mode for testing:
.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine node    # force free models
.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine claude  # force Claude (budget gate still applies)
.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine claude -ForceBudget  # bypass budget + activity gates (manual validation only)
```

---

## Projects in rotation (11 total)

The dispatcher picks one project per firing and does bounded work on it. Projects fall into two categories:

### Real projects (your actual repos -- 4)

| Project           | What                                                | Language                | Tasks                               |
| ----------------- | --------------------------------------------------- | ----------------------- | ----------------------------------- |
| **combo**         | Clinical utility framework (Parkland, Lund-Browder) | TypeScript              | audit, explore, tests-gen, docs-gen |
| **boardbound**    | AI-powered FNP board certification prep app         | TypeScript/React Native | audit, explore, tests-gen, docs-gen |
| **shortless-ios** | Safari content blocker + Screen Time app            | Swift                   | audit, explore, docs-gen            |
| **wilderness**    | Survival game with calculators and data             | TypeScript/React/Vite   | audit, explore, tests-gen, docs-gen |

These are your published, working codebases. The dispatcher does read-only audits, writes tests, improves docs, and explores architecture -- it never deploys, deletes, or installs packages.

### Greenfield sandboxes (AI builds from scratch -- 5)

| Project            | What                                                      | Status                              |
| ------------------ | --------------------------------------------------------- | ----------------------------------- |
| **biz-app**        | Business application (model chooses which)                | Scaffolded, awaiting first dispatch |
| **game-adventure** | Playable game (genre TBD by the model)                    | Scaffolded, awaiting first dispatch |
| **dnd-game**       | Real D&D game with balanced mechanics and teaching toggle | Scaffolded, awaiting first dispatch |
| **sand-physics**   | Falling sand / particle simulation (Noita-style)          | Scaffolded, awaiting first dispatch |
| **worldbuilder**   | Grounded worldbuilding (Game of Thrones / Skyrim tone)    | Scaffolded, awaiting first dispatch |

These start as empty repos with a charter (CLAUDE.md) and roadmap. Each dispatch cycle reads what was done last time (STATE.md), picks the next task, does bounded work, and commits. Over days and weeks, these grow from empty repos into real applications.

**The dnd-game + worldbuilder connection:** These two are sister projects. Worldbuilder creates a realistic fantasy setting (geography, factions, history, NPCs). The dnd-game will eventually use that setting. For now they develop independently, but they reference each other so the models know the bridge exists.

**How greenfield projects grow:**
```
Cycle 1: research (model reads the charter, investigates the domain)
Cycle 2: plan (designs architecture, writes ROADMAP.md)
Cycle 3: scaffold (creates package.json, project structure)
Cycle 4: implement (picks a roadmap item, writes code)
Cycle 5: audit (reviews what was built, finds issues)
Cycle 6: implement (fixes issues or adds next feature)
...repeat indefinitely
```

### Infrastructure sandboxes (existing -- 2)

| Project                          | What                                        |
| -------------------------------- | ------------------------------------------- |
| **sandbox-workflow-enhancement** | Meta-improvements to the dispatcher itself  |
| **sandbox-canary-test**          | Disposable test bed for pipeline validation |

---

## Model providers (5 families)

The dispatcher can call models from five different providers. All free except Claude (subscription).

| Provider               | Models                                                    | Cost                    | Where it runs |
| ---------------------- | --------------------------------------------------------- | ----------------------- | ------------- |
| **Gemini** (Google)    | gemini-2.5-pro, gemini-2.5-flash                          | Free tier               | Google Cloud  |
| **Mistral**            | mistral-large-latest, codestral-latest                    | Free tier               | Mistral Cloud |
| **Groq**               | llama-3.3-70b-versatile (and others)                      | Free tier               | Groq Cloud    |
| **OpenRouter**         | Hundreds of models (many free)                            | Free tier available     | OpenRouter    |
| **Ollama** (local)     | qwen2.5-coder:7b, qwen2.5-coder:14b, devstral-small-2:24b | Free (runs on your GPU) | This PC       |
| **Claude** (Anthropic) | Claude Max                                                | Subscription            | Anthropic     |

**Ollama** runs on your AMD GPU using Vulkan. Models stay on your machine -- nothing leaves the network. The Optiplex can also use it as a thin client (requests go over LAN to this PC's GPU). Three coding models are installed:
- `qwen2.5-coder:7b` (4.7 GB) -- fast, good for simple codegen
- `qwen2.5-coder:14b` (9.0 GB) -- better quality, used as codegen fallback
- `devstral-small-2:24b` (15 GB) -- Mistral's coding model, largest/strongest

**How fallback works:** If the primary model 503s or errors, the dispatcher tries the next model in the chain. Example for boardbound test generation: Codestral -> Ollama qwen:14b -> Gemini Pro -> Gemini Flash -> Mistral Large. It walks the chain until one succeeds.

---

## Model routing (free-model engine)

### Default routing (most projects)

| Task class                                             | Primary model             | Fallback chain                                         |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------ |
| explore, audit, research                               | Gemini 2.5 Pro            | -> Gemini 2.5 Flash -> Mistral Large                   |
| tests_gen, refactor                                    | Codestral Latest          | -> Gemini 2.5 Pro -> Gemini 2.5 Flash -> Mistral Large |
| docs_gen                                               | Mistral Large             | -> Gemini 2.5 Pro -> Gemini 2.5 Flash                  |
| plan, design, architecture, clinical, security, safety | **Skipped** (claude_only) | Returns to Claude engine                               |

### Per-project routing (complex projects get custom chains)

Some projects have specific needs, so they get custom model assignments:

| Project           | explore         | audit     | tests-gen               | docs-gen         | Why                                                                                     |
| ----------------- | --------------- | --------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| **boardbound**    | Flash (cheaper) | Pro       | Codestral -> Ollama 14b | Mistral -> Flash | Well-structured code, Flash suffices for exploration. Ollama as local codegen fallback. |
| **combo**         | Pro             | Pro       | Codestral -> Ollama 14b | Mistral          | Clinical formulas need the stronger model for everything.                               |
| **shortless-ios** | Pro             | Pro       | (not available)         | Pro -> Mistral   | Swift needs the stronger model. No test-gen (Swift project, dispatcher uses npm test).  |
| **wilderness**    | (default)       | (default) | (default)               | (default)        | Standard routing works fine.                                                            |
| **all sandboxes** | (default)       | (default) | (default)               | (default)        | Standard routing.                                                                       |

**Forbidden models:** `gemini-3-pro-preview` (bills Google Cloud credits).

---

## Audit scorecard

### Done (27 numbered + 4 unnumbered fixes + 3 bug fixes + 2 features = 36 items)

| ID  | What                                                            | Commit           |
| --- | --------------------------------------------------------------- | ---------------- |
| S-3 | Path traversal defense (realpath + trailing sep)                | `324531a`        |
| S-4 | Windows case-insensitive path compare                           | `324531a`        |
| S-5 | Env allowlist strips API keys from subprocesses                 | `324531a`        |
| S-9 | Windows reserved device name rejection (CON/PRN/LPT)            | `324531a`        |
| S-6 | Selector post-call allowlist validation                         | Verified in-code |
| S-7 | Security scanner (scan.mjs, 13 secret + 8 code patterns)        | `4d6307a`        |
| S-8 | Weekly npm audit for supply chain monitoring                    | `6aa86d5`        |
| C-1 | Cross-family audit (Gemini <-> Mistral)                         | `5d99988`        |
| C-2 | Clinical gate 3-file cap removed                                | `78f7625`        |
| C-3 | H1 push-url ceremony override                                   | `78f7625`        |
| C-4 | Weekly `git fsck` on rotation projects                          | `4d6307a`        |
| C-5 | Task-class fallback chain on 503/5xx                            | `4e1f22c`        |
| I-1 | Gemini native JSON mode for selector                            | `50a155c`        |
| I-2 | Per-provider free-tier rate limiting                            | `93e9207`        |
| I-3 | Selector outcome memory (I-3 feedback loop)                     | `5d99988`        |
| I-4 | API call timeouts (withTimeout 60s wrapper)                     | `4d6307a`        |
| R-1 | ajv schema validation on LLM output                             | `5d99988`        |
| R-2 | Hanging test timeout + process-tree kill                        | Prior session    |
| R-3 | Named mutex (replaces PID file)                                 | `f5d67b0`        |
| R-4 | GitHub Gist sync (replaces OneDrive junction)                   | `b626d21`        |
| R-5 | JSONL log rotation (7-day retain, reverse-read)                 | `4d6307a`        |
| R-6 | Pre-commit hook: ASCII enforcement on .ps1                      | `5d99988`        |
| R-7 | Stale .git/index.lock cleanup at startup                        | `f5074c1`        |
| --  | Counter-bug fix (countTodayRuns predicate)                      | `d2b71b5`        |
| --  | Selector hot-fix (Gemini thinking ate token budget)             | `1889d60`        |
| --  | Mistral import fix                                              | Prior session    |
| --  | ajv dependency install                                          | Prior session    |
| --  | libuv crash fix (setImmediate drain)                            | `ae254c0`        |
| --  | Selector src/ hard-filter (prevents impossible task picks)      | `9e4c66f`        |
| --  | Error visibility (all paths write JSONL + last-run + gist)      | `09e692c`        |
| --  | Dual-engine auto mode (`-Engine auto`, budget-adaptive routing) | `ac5b7ef`        |
| --  | Stale worktree cleanup (auto/* branches > 7 days)               | `12c8da7`        |

### Open (2 -- deferred, need infrastructure)

| ID  | What                                    | Blocker                       |
| --- | --------------------------------------- | ----------------------------- |
| S-1 | Execution sandbox for generated code    | Needs WSL2 or Windows Sandbox |
| S-2 | Network isolation for test subprocesses | Needs WSL2 or Windows Sandbox |

### Optional / low-priority

| Item               | What                                               | Notes                                                                                                                                 |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| I-4 reconciliation | Swap `withTimeout` to native `AbortSignal.timeout` | Works fine as-is. Native would properly abort HTTP handles instead of leaking them, but the libuv fix mitigates the leak consequence. |

---

## Current runtime state

| Setting              | Value                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `dry_run`            | `false` (live)                                                                             |
| `paused`             | `false`                                                                                    |
| Engine mode          | **Auto** (`-Engine auto`): Claude when budget allows, free models otherwise                |
| Scheduled task       | `BudgetDispatcher-Node` (fires every 20 min with `-Engine auto`)                           |
| Old Claude task      | `ClaudeBudgetDispatcher` (disabled, superseded by auto mode)                               |
| Activity gate        | 20 min idle required                                                                       |
| Max runs/day         | 50                                                                                         |
| Projects in rotation | **11** (4 real repos + 5 greenfield sandboxes + 2 infrastructure sandboxes)                |
| Model providers      | **5** -- Gemini, Mistral, Groq, OpenRouter, Ollama (local GPU)                             |
| Ollama               | Running locally, Vulkan (AMD GPU), 3 models, LAN-accessible on port 11434                  |
| Per-project routing  | boardbound, combo, shortless-ios have custom model chains                                  |
| Gist sync            | Active ([gist link](https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf)) |
| Budget estimate      | Refreshed on every firing (even free-model runs)                                           |
| Worktree cleanup     | Auto/* worktrees older than 7 days removed at startup                                      |
| Error visibility     | All failure paths update JSONL + last-run.json + gist (`09e692c`)                          |
| System tray          | `bin/BudgetDispatcher.exe` -- auto-starts on login, green/yellow/red health dot            |
| Toast notifications  | Windows desktop notifications on dispatch complete (success/error)                         |
| Dashboard            | `localhost:7380` -- 6-tab web UI, auto-opens Chrome, scheduled task health card            |

---

## What to expect

### What happens when you walk away

Every 20 minutes, the dispatcher wakes up and:

1. **Checks if you're idle** (20 min since last keyboard/mouse). If you're active, it goes back to sleep.
2. **Picks a project** from the 11 in rotation. It favors projects that haven't been worked on recently.
3. **Picks a task** (audit, explore, tests-gen, docs-gen, research, etc.) based on the project's state and roadmap.
4. **Routes to a model.** Per-project rules pick the best model. If that model 503s, it walks the fallback chain. Local Ollama models are available as fallbacks even when cloud APIs are down.
5. **Does the work** in a temporary git worktree (isolated copy, can't break your main branch).
6. **Commits the result** to an `auto/` branch. Never pushes, never merges to main.
7. **Logs everything** to JSONL + gist (visible from your laptop).
8. **Sends a toast notification** so you see what happened when you come back.

**For real projects** (combo, boardbound, wilderness, shortless-ios): the dispatcher audits code, writes tests, improves docs, and maps architecture. It never modifies clinical formulas, deploys, or deletes files.

**For greenfield sandboxes** (dnd-game, worldbuilder, etc.): the dispatcher progressively builds the project from nothing. Early cycles research and plan. Later cycles scaffold code and implement features. Each cycle reads STATE.md to know what was done last time.

### How the two engines divide the work

Both engines share the same projects, the same config, and the same 20-minute schedule:

- **Free-model engine** handles the volume -- explore, audit, docs, test gen, refactoring. Runs when budget is tight (most of the time). Costs nothing. Can use 5 providers (Gemini, Mistral, Groq, OpenRouter, Ollama).
- **Claude engine** handles the hard stuff -- architecture reviews, security audits, design decisions, clinical domain work. Runs when `dispatch_authorized=true` (budget has headroom).

The budget estimate is refreshed on every firing (even free-model runs), so auto mode always has current data. When the monthly budget resets or usage drops below pace, auto mode starts selecting Claude automatically.

---

## Quick reference

**Open the dashboard:** Double-click the green tray icon, or right-click > "Open Dashboard", or run `node scripts/dashboard.mjs`.

**Switch engines:** Right-click tray icon > pick an engine. Or use the dashboard or CLI.

**Pause everything:** Right-click tray icon > "Pause". Or create `config/PAUSED`. Or set `"paused": true` in `config/budget.json`.

**Dispatch now:** Right-click tray icon > "Dispatch Now". Or use the dashboard button.

**Manual test (bypasses activity gate):**
```bash
GEMINI_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GEMINI_API_KEY','User')") \
MISTRAL_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('MISTRAL_API_KEY','User')") \
node scripts/dispatch.mjs
```

**Check last run:** `cat status/budget-dispatch-last-run.json`

**Check from laptop:** [Gist](https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf)

**Rebuild tray app:** `scripts\build-tray.cmd` (uses csc.exe built into Windows, no installs needed)

**View recent log:** `tail -5 status/budget-dispatch-log.jsonl | node -e "process.stdin.on('data',d=>d.toString().split('\\n').filter(Boolean).forEach(l=>{try{console.log(JSON.parse(l))}catch{}}))"`

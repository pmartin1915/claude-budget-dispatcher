# Dispatcher Status & Engine Guide

> Last updated: 2026-04-16 (Part 8 session)

---

## What this system does

The **claude-budget-dispatcher** fires every 20 minutes via Windows Task Scheduler. When you've been idle for 20+ minutes, it picks a project and task from your rotation, does bounded work (tests, audits, docs, codegen), commits to a throwaway `auto/` branch, and logs the result. You review and merge (or discard) later.

There are **two engines** that can run the pipeline. They share the same wrapper (`run-dispatcher.ps1`), the same config (`config/budget.json`), the same activity gate, and the same projects. They differ in what does the thinking.

---

## The Two Engines

### Engine A: Claude-oversighted (`-Engine claude`)

| | |
|---|---|
| **Scheduled task** | `ClaudeBudgetDispatcher` (currently **disabled**) |
| **Entry point** | `run-dispatcher.ps1 -Engine claude` -> `claude -p < tasks/budget-dispatch.md` |
| **Who thinks** | Claude Max (your Anthropic subscription) |
| **Cost per run** | ~$0.20-1.00 in Claude Max tokens |
| **Budget gate** | Required. `estimate-usage.mjs` checks weekly/monthly headroom before firing. Only runs when you're under-pace on your subscription. |
| **Activity gate** | Required. 20 min idle. |
| **How it picks work** | Claude reads each project's STATE.md and DISPATCH.md, reasons about what to do, then either does the work itself (Branch A) or delegates to a free model via PAL (Branch B). |
| **Audit model** | Claude audits Claude (same family -- shared-blind-spot risk, but mitigated by Claude's strong judgment) |
| **Safety model** | Claude is in the loop for every decision. Human-equivalent judgment on edge cases. |
| **Best for** | Complex tasks: architecture reviews, multi-file refactors, clinical domain work, design decisions, anything in the `claude_only` list. |

**Why you want this engine:** It uses your subscription tokens that would otherwise expire unused. It handles the hard stuff -- design, security, architecture -- that free models aren't trusted with. The budget gate ensures it only fires when you have headroom to spare.

**Current state:** Disabled. To re-enable, activate the `ClaudeBudgetDispatcher` scheduled task in Task Scheduler. **Do not enable both engines simultaneously** -- they'd race on the mutex and double-bill.

---

### Engine B: Free-model (`-Engine node`)

| | |
|---|---|
| **Scheduled task** | `BudgetDispatcher-Node` (currently **active, firing every 20 min**) |
| **Entry point** | `run-dispatcher.ps1 -Engine node` -> `node scripts/dispatch.mjs` |
| **Who thinks** | Gemini 2.5 Pro/Flash, Mistral Large, Codestral (all free tier) |
| **Cost per run** | $0.00 |
| **Budget gate** | Skipped (free tier = no budget to track) |
| **Activity gate** | Required. 20 min idle. |
| **How it picks work** | `selector.mjs` sends project context to Gemini Flash, which returns a structured JSON pick. `router.mjs` maps the task to a model. |
| **Audit model** | Cross-family: if Gemini generated the code, Mistral audits it (and vice versa). No shared blind spots. |
| **Safety model** | Schema validation (ajv), path-escape checks, env allowlisting, clinical gate, security scanner -- explicit guards because there's no Claude judgment in the loop. |
| **Best for** | High-frequency mechanical work: test generation, docs, code exploration, audits, refactoring. Runs unlimited times per day at zero cost (rate-limit permitting). |

**Why you want this engine:** It's free and unlimited. Rate limits are the only constraint, and the C-5 fallback chain (shipped this session) means a 503 on one model just rolls to the next. It can run 50+ times a day without touching your subscription.

**Current state:** Active. `dry_run: false`. First live dispatch completed successfully this session (roadmap-review on sandbox-workflow-enhancement, Gemini 2.5 Pro, 53 seconds).

---

## Side-by-side comparison

| Concern | Claude engine | Free-model engine |
|---|---|---|
| Scheduled task | Selected by auto mode when budget allows | Selected by auto mode when budget is tight |
| Fires every | 20 min | 20 min |
| Cost | ~$0.20-1.00/run | $0.00/run |
| Budget gate | Yes (protects subscription) | No (nothing to protect) |
| Activity gate | Yes (20 min idle) | Yes (20 min idle) |
| Selector | Claude reasoning | Gemini 2.5 Flash (structured JSON) |
| Worker | Claude Max | Gemini/Mistral/Codestral |
| Fallback on 503 | N/A (single model) | Walks candidate chain (C-5) |
| Cross-family audit | No (Claude audits Claude) | Yes (Gemini <-> Mistral) |
| Schema validation | No (trusts Claude output) | Yes (ajv on all LLM output) |
| Security scanner | No | Yes (scan.mjs, 13 secret + 8 code patterns) |
| `claude_only` tasks | Can do them | Skips them (returns to Claude) |
| Max runs/day | 50 (budget-gated) | 50 (config limit, but no cost pressure) |
| Commits to | `auto/` branches | `auto/` branches |
| Pushes to origin | Never | Never |

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

**Force a specific engine:**
```powershell
# Override auto mode for testing:
.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine node    # force free models
.\scripts\run-dispatcher.ps1 -RepoRoot . -Engine claude  # force Claude (budget gate still applies)
```

---

## Model routing (free-model engine)

| Task class | Primary model | Fallback chain |
|---|---|---|
| explore, audit, research | Gemini 2.5 Pro | -> Gemini 2.5 Flash -> Mistral Large |
| tests_gen, refactor | Codestral Latest | -> Gemini 2.5 Pro -> Gemini 2.5 Flash -> Mistral Large |
| docs_gen | Mistral Large | -> Gemini 2.5 Pro -> Gemini 2.5 Flash |
| plan, design, architecture, clinical, security, safety | **Skipped** (claude_only) | Returns to Claude engine |

**Forbidden models:** `gemini-3-pro-preview` (bills Google Cloud credits).

---

## Audit scorecard

### Done (27 numbered + 4 unnumbered fixes + 3 bug fixes + 2 features = 36 items)

| ID | What | Commit |
|---|---|---|
| S-3 | Path traversal defense (realpath + trailing sep) | `324531a` |
| S-4 | Windows case-insensitive path compare | `324531a` |
| S-5 | Env allowlist strips API keys from subprocesses | `324531a` |
| S-9 | Windows reserved device name rejection (CON/PRN/LPT) | `324531a` |
| S-6 | Selector post-call allowlist validation | Verified in-code |
| S-7 | Security scanner (scan.mjs, 13 secret + 8 code patterns) | `4d6307a` |
| S-8 | Weekly npm audit for supply chain monitoring | `6aa86d5` |
| C-1 | Cross-family audit (Gemini <-> Mistral) | `5d99988` |
| C-2 | Clinical gate 3-file cap removed | `78f7625` |
| C-3 | H1 push-url ceremony override | `78f7625` |
| C-4 | Weekly `git fsck` on rotation projects | `4d6307a` |
| C-5 | Task-class fallback chain on 503/5xx | `4e1f22c` |
| I-1 | Gemini native JSON mode for selector | `50a155c` |
| I-2 | Per-provider free-tier rate limiting | `93e9207` |
| I-3 | Selector outcome memory (I-3 feedback loop) | `5d99988` |
| I-4 | API call timeouts (withTimeout 60s wrapper) | `4d6307a` |
| R-1 | ajv schema validation on LLM output | `5d99988` |
| R-2 | Hanging test timeout + process-tree kill | Prior session |
| R-3 | Named mutex (replaces PID file) | `f5d67b0` |
| R-4 | GitHub Gist sync (replaces OneDrive junction) | `b626d21` |
| R-5 | JSONL log rotation (7-day retain, reverse-read) | `4d6307a` |
| R-6 | Pre-commit hook: ASCII enforcement on .ps1 | `5d99988` |
| R-7 | Stale .git/index.lock cleanup at startup | `f5074c1` |
| -- | Counter-bug fix (countTodayRuns predicate) | `d2b71b5` |
| -- | Selector hot-fix (Gemini thinking ate token budget) | `1889d60` |
| -- | Mistral import fix | Prior session |
| -- | ajv dependency install | Prior session |
| -- | libuv crash fix (setImmediate drain) | `ae254c0` |
| -- | Selector src/ hard-filter (prevents impossible task picks) | `9e4c66f` |
| -- | Error visibility (all paths write JSONL + last-run + gist) | `09e692c` |
| -- | Dual-engine auto mode (`-Engine auto`, budget-adaptive routing) | `ac5b7ef` |
| -- | Stale worktree cleanup (auto/* branches > 7 days) | `12c8da7` |

### Open (2 -- deferred, need infrastructure)

| ID | What | Blocker |
|---|---|---|
| S-1 | Execution sandbox for generated code | Needs WSL2 or Windows Sandbox |
| S-2 | Network isolation for test subprocesses | Needs WSL2 or Windows Sandbox |

### Optional / low-priority

| Item | What | Notes |
|---|---|---|
| I-4 reconciliation | Swap `withTimeout` to native `AbortSignal.timeout` | Works fine as-is. Native would properly abort HTTP handles instead of leaking them, but the libuv fix mitigates the leak consequence. |

---

## Current runtime state

| Setting | Value |
|---|---|
| `dry_run` | `false` (live) |
| `paused` | `false` |
| Engine mode | **Auto** (`-Engine auto`): Claude when budget allows, free models otherwise |
| Scheduled task | `BudgetDispatcher-Node` (fires every 20 min with `-Engine auto`) |
| Old Claude task | `ClaudeBudgetDispatcher` (disabled, superseded by auto mode) |
| Activity gate | 20 min idle required |
| Max runs/day | 50 |
| Projects in rotation | `sandbox-workflow-enhancement`, `sandbox-canary-test` |
| Gist sync | Active ([gist link](https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf)) |
| Budget estimate | Refreshed on every firing (even free-model runs) |
| Worktree cleanup | Auto/* worktrees older than 7 days removed at startup |
| Error visibility | All failure paths update JSONL + last-run.json + gist (`09e692c`) |

---

## What's next

### Auto mode (active now)

The dispatcher runs in `-Engine auto` mode. Every firing refreshes the budget estimate and picks the right engine:
- **Budget has headroom** (`dispatch_authorized=true`): Claude engine handles the run, including `claude_only` tasks (plan, design, architecture, clinical, security)
- **Budget is tight** (`dispatch_authorized=false`): Free-model engine handles the run with Gemini/Mistral/Codestral

Every audit finding that applies to the free-model engine is shipped. The only remaining items (S-1/S-2 sandbox isolation) are infrastructure-gated on WSL2 and would add defense-in-depth for generated test code -- not a blocker for normal operation.

**What to expect on your next idle window:**
- Budget estimate refreshed (zero LLM cost)
- Auto mode selects the appropriate engine
- Selector picks a viable task (explore, audit, research, roadmap-review, or codegen on projects with source files)
- Worker calls the selected model; if one 503s, falls back to the next (free-model engine only)
- Result committed to an `auto/` branch in the sandbox project
- Log entry written, gist synced for laptop visibility
- Stale worktrees older than 7 days cleaned up automatically

**What you can do to expand it:**
- Add more projects to `projects_in_rotation` in `config/budget.json`
- Add source code to `sandbox-workflow-enhancement/src/` to unlock codegen/docs/test tasks on that project
- The free-model engine has no cost ceiling -- rate limits are the only constraint, and fallback handles those
- Claude engine activates automatically when your subscription budget has headroom

### Both engines together (auto mode -- shipped Part 8)

Both engines work together via `-Engine auto` (budget-adaptive routing):
- **Free-model engine** handles the volume -- explore, audit, docs, test gen, refactoring. Runs when budget is tight (most of the time). Costs nothing.
- **Claude engine** handles the hard stuff -- architecture reviews, security audits, design decisions, clinical domain work. Runs when `dispatch_authorized=true` (budget has headroom).

The budget estimate is refreshed on every firing (even free-model runs), so the auto mode always has current data. When the monthly budget resets or usage drops below pace, auto mode starts selecting Claude automatically.

---

## Quick reference

**Manual test (bypasses activity gate):**
```bash
GEMINI_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GEMINI_API_KEY','User')") \
MISTRAL_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('MISTRAL_API_KEY','User')") \
node scripts/dispatch.mjs
```

**Pause everything:** Create `config/PAUSED` or set `"paused": true` in `config/budget.json`.

**Check last run:** `cat status/budget-dispatch-last-run.json`

**Check from laptop:** [Gist](https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf)

**View recent log:** `tail -5 status/budget-dispatch-log.jsonl | node -e "process.stdin.on('data',d=>d.toString().split('\\n').filter(Boolean).forEach(l=>{try{console.log(JSON.parse(l))}catch{}}))"`

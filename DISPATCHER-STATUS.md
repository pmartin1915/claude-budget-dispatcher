# Dispatcher Status & Engine Guide

> Last updated: 2026-04-15 (Part 7 session)

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
| Scheduled task | `ClaudeBudgetDispatcher` (disabled) | `BudgetDispatcher-Node` (active) |
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

Both engines use the same mutex (`Global\claude-budget-dispatcher`), so they can't run simultaneously. To switch:

**Run free-model only (current setup):**
```powershell
# In Task Scheduler:
# BudgetDispatcher-Node = Enabled
# ClaudeBudgetDispatcher = Disabled
```

**Run Claude only:**
```powershell
# In Task Scheduler:
# BudgetDispatcher-Node = Disabled
# ClaudeBudgetDispatcher = Enabled
```

**Run both in alternation (future possibility):**
Not yet implemented. Would require the scheduled tasks to interleave (e.g., Claude fires at :00/:40, Node fires at :20) or a wrapper that picks the engine per-run based on budget headroom. The mutex prevents races, but you'd want intentional scheduling.

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

### Done (27 numbered + 4 unnumbered fixes + 3 bug fixes = 34 items)

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
| Active engine | Free-model (`BudgetDispatcher-Node`) |
| Claude engine | Disabled (`ClaudeBudgetDispatcher`) |
| Activity gate | 20 min idle required |
| Max runs/day | 50 |
| Projects in rotation | `sandbox-workflow-enhancement`, `sandbox-canary-test` |
| Gist sync | Active ([gist link](https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf)) |
| Error visibility | All failure paths update JSONL + last-run.json + gist (`09e692c`) |
| Last live dispatch | 2026-04-15 ~22:24 local, `roadmap-review` on `sandbox-workflow-enhancement`, Gemini 2.5 Pro, success |

---

## What's next

### Free-model engine (active now)

The free-model engine is fully operational. Every audit finding that applies to it is shipped. The only remaining items (S-1/S-2 sandbox isolation) are infrastructure-gated on WSL2 and would add defense-in-depth for generated test code -- not a blocker for normal operation.

**What to expect on your next idle window:**
- Selector picks a viable task (explore, audit, research, roadmap-review, or codegen on projects with source files)
- Worker calls Gemini/Mistral/Codestral; if one 503s, falls back to the next
- Result committed to an `auto/` branch in the sandbox project
- Log entry written, gist synced for laptop visibility

**What you can do to expand it:**
- Add more projects to `projects_in_rotation` in `config/budget.json`
- Add source code to `sandbox-workflow-enhancement/src/` to unlock codegen/docs/test tasks on that project
- The free-model engine has no cost ceiling -- rate limits are the only constraint, and fallback handles those

### Claude engine (disabled, ready to re-enable)

The Claude engine hasn't been touched since the original implementation. All the hardening work (S-3 through R-7) applies to the free-model engine. The Claude engine's safety relies on Claude's in-loop judgment rather than explicit guards.

**To start using your subscription headroom:**
1. Enable `ClaudeBudgetDispatcher` in Task Scheduler
2. Disable `BudgetDispatcher-Node` (or set up alternation -- see below)
3. The budget gate (`estimate-usage.mjs`) will only allow runs when you have weekly/monthly headroom

**What the Claude engine can do that the free engine can't:**
- `plan`, `design`, `architecture` tasks (reserved as `claude_only`)
- `clinical` and `security` tasks on clinical-gated projects
- Complex multi-file reasoning that benefits from Claude's judgment
- Tasks where you want human-equivalent decision-making in the loop

### Future: running both engines

The ideal end state is both engines working together:
- **Free-model engine** handles the volume -- explore, audit, docs, test gen, refactoring. Runs often, costs nothing.
- **Claude engine** handles the hard stuff -- architecture reviews, security audits, design decisions, clinical domain work. Runs less often, only when budget allows.

This could be implemented as:
1. **Time-sliced:** Free-model fires at :16 and :56, Claude fires at :36 (when budget allows)
2. **Budget-adaptive:** A single wrapper checks headroom. If flush, use Claude. If tight, use free models.
3. **Task-routed:** Free-model engine returns `claude_only` tasks to a queue; Claude engine picks them up on its next firing.

None of this is built yet. The mutex prevents races, so the simplest version is just manual toggling in Task Scheduler based on how your month is going.

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

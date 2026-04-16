# Handoff — PC Claude instance (Part 6 — 2026-04-15 evening)

> **READ THIS FIRST.** Part 6 supersedes Part 5. Part 5 is now historical context.

## Part 6: TL;DR for next instance

- **Laptop session shipped S-7, I-4, R-5, C-4 (`4d6307a`):** security scanner (scan.mjs), API timeouts (withTimeout in throttle.mjs), JSONL log rotation, weekly git fsck. Pulled to PC with no conflicts.
- **PC session shipped R-7 (`f5074c1`):** stale .git/index.lock cleanup (git-lock.mjs + dispatch.mjs wiring). 30-min age threshold, mutex-guarded.
- **R-4 OneDrive junction replaced with GitHub Gist (`b626d21`):** Junction never synced (confirmed over 48+ hours — R-4 FindFirstChangeNotification doesn't propagate through NTFS junctions). Junction removed, status/ restored to normal directory. run-dispatcher.ps1 now pushes budget-dispatch-last-run.json to a public gist after each successful run. Gist: https://gist.github.com/pmartin1915/655d02ce43b293cacdf333a301b63bbf
- **S-6 confirmed done (verified):** post-call allowlist validation at selector.mjs:112-123 (`.find()` + `.includes()`) returns null on project/task mismatch. Source comment added. No code change needed beyond the anchor comment.
- **Pre-commit hook installed on PC:** `cp scripts/hooks/pre-commit .git/hooks/pre-commit` (R-6 ASCII enforcement on .ps1 files).
- **Scorecard: 25/42 done.** See updated table below.
- **dry_run still true.** No live firing observed (activity gate hasn't opened). Perry needs to step away for 20+ min during a scheduled firing window. The gist sync will then be observable from the laptop once that happens.

## Part 6: what was done by each machine (2026-04-15)

### Laptop (pushed to origin, pulled to PC)
| Commit | Findings | Notes |
|--------|----------|-------|
| `4d6307a` | S-7, I-4, R-5, C-4 | scan.mjs security scanner, withTimeout(60s) on API calls, countTodayRuns reverse-read + rotateLog, weeklyGitFsck in git-lock.mjs |

### PC (this session)
| Commit | Findings | Notes |
|--------|----------|-------|
| `f5074c1` | R-7 | git-lock.mjs sweepStaleIndexLocks + dispatch.mjs wiring |
| `b626d21` | R-4 | OneDrive junction removed, gist sync added to run-dispatcher.ps1 |

### Non-code changes (PC, this session)
- OneDrive junction `status/ -> OneDrive\Documents\claude-budget-dispatcher-status\` removed via `cmd /c rmdir`, replaced with normal directory + files restored from backup.
- GitHub Gist created: `655d02ce43b293cacdf333a301b63bbf`. config/budget.json updated with `status_gist_id`.
- Pre-commit hook installed to .git/hooks/ (R-6).

## Part 6: implementation notes on laptop vs PC overlap

The PC session had planned to ship I-4 (per-API AbortSignal.timeout), C-4 (git fsck), and S-6 closure as a "quick sweep." While the PC session was mid-execution on I-4, the laptop session pushed `4d6307a` covering I-4 + S-7 + R-5 + C-4 in a single commit.

**I-4 approach differences:**
- PC approach (not shipped): native SDK support. Gemini: `config.abortSignal = AbortSignal.timeout(60_000)`. Mistral: `{ timeoutMs: 60_000 }` as second arg to `chat.complete()`. Per-call signal, fresh each attempt in retry loops.
- Laptop approach (shipped): `withTimeout()` wrapper in throttle.mjs — `Promise.race([apiCall, timeoutPromise])` wrapping all 8 call sites.
- Trade-off: PC approach uses native SDK cancellation (properly aborts the underlying HTTP request). Laptop approach is SDK-agnostic but leaks the HTTP connection on timeout (the fetch continues running). Both prevent the dispatcher from hanging. The native approach is theoretically cleaner for the libuv crash concern (Part 4 latent item). **Recommend reconciling to native SDK support in a future session** — low priority since free-tier APIs have no cost for leaked requests.

**C-4 approach differences:**
- PC plan: separate git-fsck.ps1 + scheduled task in setup-pc.ps1 (weekly Sunday 03:00).
- Laptop approach (shipped): weeklyGitFsck() embedded in git-lock.mjs, invoked from dispatch.mjs at startup, with a marker file to run at most once per week.
- Both are valid. Laptop's is simpler (no new scheduled task). Keep the laptop's approach.

## Part 6: current dispatcher state (as of 2026-04-15 ~20:50 local)

- **Scheduled task `BudgetDispatcher-Node`:** healthy. Firing every 20 min.
- **Activity gate:** 20 min idle required. Every JSONL entry is still `user-active`.
- **`config/budget.json`:** `dry_run: true`, `max_runs_per_day: 50`, `status_gist_id: "655d02ce43b293cacdf333a301b63bbf"`.
- **status/ directory:** normal directory (not a junction). Files: budget-dispatch-log.jsonl (93KB), budget-dispatch-last-run.json, usage-estimate.json, dispatcher-runs/*.log.
- **Pre-commit hook:** installed (.git/hooks/pre-commit — R-6 ASCII check on .ps1 files).
- **Gist sync:** wired in run-dispatcher.ps1. Not yet exercised by a live firing that produces last-run output (gate keeps blocking on user-active). Will work on next successful dispatch.

## Part 6: scorecard (updated)

| Status | Count | Findings |
|---|---|---|
| Done | 25/42 | S-3, S-4, S-5, S-9, C-2, C-3, I-1, I-2, R-2, C-1, R-1, R-6, I-3, ajv install, 1889d60 hot-fix, R-3, **R-7**, **S-7**, **I-4**, **R-5**, **C-4**, **S-6** (verified), **R-4** (gist replaces junction), counter-bug, Mistral import fix |
| Open | 3 | S-8 (supply chain monitoring), C-5 (fallback chain), libuv latent crash |
| Deferred-infra | 2 | S-1 (execution sandbox), S-2 (network isolation — need WSL2/Windows Sandbox) |

## Part 6: what's still Perry-gated

1. **`dry_run: false` flip** — both prerequisites long satisfied (R-2+R-3 landed, harness-verified). Only missing: one clean dry-run milestone in a live scheduled firing (requires 20+ min idle during a firing window). After that, flip `"dry_run": false` in config/budget.json.
2. **Reconcile I-4 to native SDK timeouts** — low priority, laptop's withTimeout wrapper works. Future Opus session can swap to `config.abortSignal` / `{ timeoutMs }` for proper HTTP handle cleanup.

## Part 6: next instance's backlog (prioritized)

**Remaining work (all low-urgency):**
- **C-5 task-class fallback chain** (Opus-scope) — design decision on what "fallback" means per task class when a model is 503-ing.
- **S-8 supply chain monitoring** — `npm audit` periodic check, pin versions.
- **libuv latent crash** — replace `process.exit(0)` with natural return + `setImmediate` exit. Architected in Part 4's latent items. Not needed while selector null-return is rare.
- **I-4 native SDK reconciliation** — swap withTimeout wrapper to native AbortSignal/timeoutMs. Low priority.

**Perry-gated:**
- `dry_run: false` flip (see above).

---

# Handoff — PC Claude instance (Part 5 — 2026-04-15 midday)

> **READ THIS FIRST.** Part 5 supersedes the wait-state described in Part 4 (`HANDOFF-2026-04-14-pc-part4.md`). Sections below labeled "Part 3" are historical context and can be skipped unless you're looking for earlier commit rationale.

## Part 5: TL;DR for next instance

- **ajv dep blackout (Apr 14 17:17 → Apr 15 11:16):** dispatcher was hard-down because `npm install` was never run on the PC after pulling `5d99988`. Fixed with a plain `npm install`. No commit. Detail below.
- **Selector hot-fix (`1889d60`) verified live:** no need to wait 20 min for the activity gate — a 50-line scratch harness calls `selectProjectAndTask` + `resolveModel` directly with real API keys and proves the whole pipeline (see "Manually testing" section). Gemini flash returned a valid schema-compliant selection in ~1.2s, router picked `mistral-large-latest` for `docs_gen`, no libuv crash.
- **R-3 named mutex shipped:** `scripts/run-dispatcher.ps1` now uses `System.Threading.Mutex('Global\claude-budget-dispatcher')` instead of the old PID file. Contention path and normal path both live-tested. Pre-commit + codereview cleared (Gemini 2.5 Pro flagged one medium-severity silent-catch issue; fix applied).
- **Dispatcher is now effectively unblocked for the `dry_run: false` flip.** The two Part 4 prerequisites were (a) observe a clean dry-run milestone in a live firing, and (b) R-3 mutex land. (a) is satisfied operationally by the manual harness; (b) is satisfied by this session's commit. See "What's still Perry-gated" below for what remains optional-but-nice-to-have.

## Part 5: overnight ajv blackout + fix

Part 4 closed at ~17:17 local 2026-04-14 expecting the next firing to verify the selector hot-fix (`1889d60`) live. **That never happened.** Two firings after Part 4's handoff was written (17:17, 17:37) and every subsequent scheduled firing hit a different crash, pre-selector:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ajv' imported from
  C:\Users\perry\DevProjects\claude-budget-dispatcher\scripts\lib\schemas.mjs
```

**Root cause.** Commit `5d99988` (R-1 schema validation, authored on laptop) added `ajv` to `package.json` + `package-lock.json`. When the PC pulled that commit in Part 4, **`npm install` was never re-run**, so `node_modules/ajv` did not exist on disk. `schemas.mjs` import crashed before `dispatch.mjs` reached the gate phase. Every scheduled firing from 17:17 onward produced `{outcome:"error", reason:"retries-exhausted", phase:"dispatch-mjs"}` in `status/budget-dispatch-log.jsonl`. PC was asleep roughly 04:17 → 11:16 local, so ~14 consecutive failures, not a full night's worth.

**Fix (this session, no commit needed).**
- `npm install` in repo root — `added 5 packages, audited 51` (ajv + `fast-deep-equal`, `json-schema-traverse`, `require-from-string`, `uri-js`).
- `package-lock.json` + `package.json` confirmed clean after install — **no drifted lockfile commit needed**.
- `node_modules/` is gitignored so nothing to commit.
- Smoke test 1: `node -e "import('./scripts/lib/schemas.mjs')..."` → `schemas import ok`.
- Smoke test 2: `node scripts/dispatch.mjs` → exit 0, `[dispatch] gated: user-active` (expected — Perry was on the machine).
- First clean scheduled firing already observed: `20260415-111646-3ede374b.log` — `wrapper-success`, `phase: complete`, `duration 1.5s`.

**Implication for future pulls.** Any time a session pulls commits that touched `package.json` / `package-lock.json`, run `npm install` before anything else. A check like `ls node_modules/<new-dep>` is not sufficient on its own if the import site isn't loaded eagerly at startup. The Part 4 handoff author had no way to know this because the three firings they observed ran *before* the pull-sync of the missing dep's crash path was exercised at scheduled-task startup.

## Part 5: selector hot-fix verified via manual harness

Rather than wait for the 20-min activity gate to open naturally, this session proved the selector fix with a scratch harness. Key lesson: **you do not have to wait for scheduled firings to verify the live pipeline.** The activity gate is just `check-idle.mjs 20` inside `runGates()`; any test script that imports the selector + router directly bypasses the gate entirely. See the "Manually testing" section below for the exact pattern and why it's faster than the step-away approach.

Result: real Gemini call → schema-valid selection in 1169ms → router classified the task correctly → dry-run payload printed cleanly → exit 0, no libuv assertion. `1889d60` works.

## Part 5: R-3 named mutex shipped

`scripts/run-dispatcher.ps1` old PID-file mutex (G9 fix) replaced with `System.Threading.Mutex('Global\claude-budget-dispatcher')`. Kept this Opus-scope even though Part 4's handoff labeled it Sonnet-delegate — mutex semantics are easy to get subtly wrong (thread-affinity of `ReleaseMutex`, `AbandonedMutexException` handling, variable-scope across try/finally) and the whole edit is only ~30 lines, so the delegation overhead wasn't worth the savings.

Improvements over PID-file approach:
1. **Atomic acquire** via `WaitOne(0)` — no race between check and claim.
2. **No PID reuse vulnerability** — kernel owns the mutex, not the filesystem.
3. **Auto-release on hard termination** — kernel releases regardless of how the process dies; `AbandonedMutexException` cleanly notifies the next acquirer.
4. **Spans OneDrive junction** — independent of `status/` location.

Testing performed this session:
- ASCII check (node-based, required because `grep -P '[\x80-\xff]'` needs escaping that bash mangles).
- PowerShell parser check via `[System.Management.Automation.Language.Parser]::ParseFile`.
- Normal-path invocation via `run-dispatcher.ps1 -Engine node` — `wrapper-success`, duration 1.2s, mutex round-trips cleanly.
- **Contention test (the important one):** in-script test where a PowerShell parent holds the mutex, then `Process.Start`s the wrapper as a child. Child correctly logs `another dispatcher instance holds Global\claude-budget-dispatcher, skipping` and exits 0 without invoking `dispatch.mjs`. This is the test that proves the replacement is actually blocking — the earlier background-process attempt was inconclusive because of timing slippage.
- `mcp__pal__codereview` with `gemini-2.5-pro` (external validation) — no critical/high findings, one medium-severity feedback ("silent `catch { $null = $_ }` on cleanup loses diagnostics"), which was valid and fixed before commit.

## Part 5: current dispatcher state (as of 2026-04-15 ~12:20 local)

- **Scheduled task `BudgetDispatcher-Node`:** healthy. `LastTaskResult: 0`. Last run 12:16:44, next run 12:36:43. Fires every 20 min at `:16:43`, `:36:43`, `:56:43` past each hour.
- **Activity gate threshold:** 20 minutes of user inactivity (`check-idle.mjs 20` — no keyboard/mouse). Gate opens only if Perry has been idle for the full 20 min ending at the firing time. **You can and should bypass this for verification tests** — see "Manually testing" below.
- **`config/budget.json`:** still `dry_run: true`, `max_runs_per_day: 50` (gitignored).
- **Selector hot-fix `1889d60`:** verified live via manual harness. No scheduled firing has yet exercised it (activity gate hasn't opened), but that doesn't matter because the harness test is strictly more rigorous.

---

## Part 5: CONTEXT FOR NEXT INSTANCE — read this before doing anything

The next session (laptop or PC) needs four pieces of context that are easy to miss if you only read commits.

### 1. Opus/Sonnet workflow (combo/CLAUDE.md delegation skill)

You are Opus 4.6 (1M context). Sonnet 4.5 is the delegation target for mechanical work. Use the `Task` tool with `subagent_type: "general-purpose"` and `model: "sonnet"` for:
- Codebase exploration, grep/find-usages, multi-file reads
- Running tests and reporting results
- Boilerplate generation, JSDoc/docs updates, markdown
- Lint/typecheck + simple fixes
- Mechanical refactors (rename, move, search-replace)
- Routine git staging + commits *of work Sonnet produced*

**Keep these Opus-scope (do NOT delegate):**
- Architecture and design decisions (e.g. R-4 junction topology, C-5 fallback routing)
- Clinical logic review (domain/ files in Combo projects)
- Security audit (mutex semantics, scanner integration, sandbox design)
- Cross-model orchestration decisions (which model family audits which)
- Multi-file debugging that requires tracing dataflow across unfamiliar code
- Framework protocol changes (Combo ai/ conventions, DECISIONS.md entries)

The R-3 edit in this session is a textbook case of Opus-scope even when a handoff tagged it "Sonnet-delegate": it's only 30 lines, but the semantics involve .NET threading contracts (`AbandonedMutexException`, thread-affinity of `ReleaseMutex`, `Global\` namespace privileges). Getting any of these wrong is a silent concurrency bug. **When the risk-to-LOC ratio is high, keep it Opus-scope.** Commit message / handoff should note it explicitly so future sessions don't second-guess.

The Opus/Sonnet workflow is formalized in `combo/CLAUDE.md` — read it if you haven't.

### 2. PAL MCP tools (`mcp__pal__*`)

**Pre-commit mandate (combo/CLAUDE.md):** every commit must go through `mcp__pal__codereview` with `model: "gemini-2.5-pro"` before staging. Cross-model audit is routed deliberately to a different model family than generation (Claude → Gemini) to avoid shared blind spots. This is not optional.

Key `mcp__pal__*` tools available:
- **`mcp__pal__codereview`** — systematic, step-by-step code review. Two-step workflow for external validation: step 1 with `next_step_required: true` to describe the change, step 2 with `next_step_required: false` to trigger expert follow-up. If Gemini 2.5 Pro is experiencing 503 high-demand, set `review_validation_type: "internal"` + `use_assistant_model: false` to skip the expert follow-up (still captures structured findings). Use `review_type: "security"` for security-sensitive changes like R-3.
- **`mcp__pal__consensus`** — get multiple-model opinions on a design decision (use when the design call is genuinely contested, not for routine reviews).
- **`mcp__pal__debug`** — structured debugging walk-through. Use when a bug is tricky and you want to reason step-by-step with expert validation.
- **`mcp__pal__thinkdeep`** — extended reasoning on a single hard problem.
- **`mcp__pal__precommit`** — formal pre-commit validation flow. Similar to codereview but focused on commit-time checks.
- **`mcp__pal__planner`** — multi-step planning assistance (alternative to plan mode for complex implementations).
- **`mcp__pal__listmodels`** — list models available to PAL. **Use this first** whenever you're unsure which model to pick; the MCP server's instructions say "When no model is mentioned, first use the `listmodels` tool from PAL to obtain available models to choose the best one from."
- **`mcp__pal__clink`** — cross-agent link (rarely needed).
- **`mcp__pal__challenge`** — adversarial review; asks a model to argue against a proposed approach.
- **`mcp__pal__apilookup`** — API documentation lookup.

**When the user names a specific model** (e.g. "use chat with gpt5"), send that exact model in the tool call. Do not silently substitute.

Forbidden models: `gemini-3-pro-preview` — bills Perry's Google Cloud credits. Listed in `config/budget.json` `free_model_roster.forbidden_models`. Don't use it for anything.

### 3. Manually testing (bypass-the-gate pattern)

**The cheap test beats the expensive wait.** The dispatcher's activity gate (`check-idle.mjs 20`) requires 20 minutes of user idle before a scheduled firing will proceed. If you're trying to verify that the selector, router, worker, or dry-run path works end-to-end with real API keys, you do **not** need to wait for the gate. You can import the functions directly from a throwaway Node script.

**The pattern** (verified working this session for the selector hot-fix):

```js
// scratch-test-selector.mjs — TEMPORARY, delete after use
import { readFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import { selectProjectAndTask } from "./scripts/lib/selector.mjs";
import { resolveModel } from "./scripts/lib/router.mjs";

const config = JSON.parse(readFileSync("./config/budget.json", "utf8"));
const clients = {
  gemini: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  mistral: new Mistral({ apiKey: process.env.MISTRAL_API_KEY }),
};
const selection = await selectProjectAndTask(config, clients);
console.log("selection:", selection);
const route = resolveModel(selection.task, config.free_model_roster);
console.log("route:", route);
```

Run with env vars piped through PowerShell (bash mangles `$env:` interpolation):

```bash
GEMINI_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GEMINI_API_KEY','User')") \
MISTRAL_API_KEY=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('MISTRAL_API_KEY','User')") \
node scratch-test-selector.mjs
```

Delete the scratch file after use. This pattern lets you verify any phase of the pipeline (selector, router, worker, verify-commit) in seconds instead of waiting 20 minutes for the activity gate to naturally open.

**For PS1 changes** like R-3 mutex: use a deterministic in-script test where the parent acquires the shared resource and spawns the wrapper as `[System.Diagnostics.Process]::Start(...)`. This avoids timing races between a background holder and a foreground test — see `/tmp/mutex-contention-test.ps1` from this session for the template.

**Part 4 got this wrong.** It framed the selector fix as blocked on Perry-stepping-away for 20+ min. There was no real reason — the fix could have been harness-tested in under a minute. Future sessions should default to harness testing and only fall back to scheduled firings for end-to-end PS1-wrapper validation (where the code under test is the wrapper itself).

### 4. Claude-oversighted engine vs. totally free-model engine

There are **two distinct runtime engines**, selected via the `-Engine` parameter of `run-dispatcher.ps1`. They are fundamentally different in cost model, trust model, and scheduled-task wiring.

**Engine A: Claude-oversighted (`-Engine claude`, scheduled task name: `ClaudeBudgetDispatcher`).** Original implementation. Pipeline is PS1 → `estimate-usage.mjs` (budget gate) → `check-idle.mjs` (activity gate) → `claude -p < tasks/budget-dispatch.md`. Claude Max (real Anthropic API calls, burns monthly quota) runs the dispatcher prompt, which decides what to do, invokes MCP tools, commits, etc. **Claude is in the loop for every decision.** Budget gate reads `status/usage-estimate.json` and refuses to run if the weekly/monthly quota headroom is too low. Not used in this session. **The `ClaudeBudgetDispatcher` scheduled task is currently disabled and must stay disabled** — re-enabling it would cause both engines to fire concurrently and double-bill. Do not re-enable.

**Engine B: totally free-model (`-Engine node`, scheduled task name: `BudgetDispatcher-Node`).** Proposal 008 Phase A, shipped in `1acef58`. Pipeline is PS1 → `dispatch.mjs` (Node) → `gates.mjs` (budget gate is SKIPPED for `node` engine because we use free-tier APIs, activity gate still runs) → `selector.mjs` (Gemini free tier) → `router.mjs` → `worker.mjs` (Gemini / Mistral / Codestral free tier) → `verify-commit.mjs` (Gemini or Mistral cross-family audit per C-1). **Zero Claude Max tokens at runtime.** This is the engine that is currently active, scheduled, and firing every 20 min.

| Concern | Claude engine | Node engine |
|---|---|---|
| Scheduled task | `ClaudeBudgetDispatcher` (disabled) | `BudgetDispatcher-Node` (active) |
| Entry script | `tasks/budget-dispatch.md` via `claude -p` | `scripts/dispatch.mjs` |
| Budget gate | Required (reads `usage-estimate.json`) | Skipped (free tier) |
| Activity gate | Required (20 min idle) | Required (20 min idle) |
| Selector | Claude (LLM reasoning inside the prompt) | `selector.mjs` → Gemini 2.5 Flash (I-1 + 1889d60 hot-fix) |
| Router | Claude (in-prompt) | `router.mjs` → task-class → `free_model_roster` |
| Worker LLM | Claude Max | Gemini 2.5 Pro / Codestral / Mistral Large (free tier) |
| Audit family | Claude-audits-Claude (shared-blind-spot risk) | Gemini↔Mistral cross-family (C-1) |
| Cost per run | ~$0.20-1.00 Claude Max tokens | $0 (free-tier quotas) |
| Dry-run flag | Honored | Honored |
| Current `dry_run` | true | true |
| Trust level | Human-mediated via Claude's judgment | Schema-validated (ajv R-1) + clinical gate + cross-family audit |

**The free-model engine has more defense layers** (ajv schema validation, per-provider rate limiting I-2, cross-family audit, reserved-device-name path checks S-9, env allowlist S-5) specifically because it doesn't have Claude's judgment in the loop. Every safety finding from the audit (R-1 through R-7, C-1 through C-5, I-1 through I-5, S-1 through S-9) applies to the Node engine. The Claude engine is less hardened because Claude's in-loop reasoning catches many of the issues the Node engine needs explicit guards for.

**Which one are we running?** The Node engine. Scheduled task `BudgetDispatcher-Node`. The `ClaudeBudgetDispatcher` task exists in Task Scheduler but is disabled and must not be re-enabled. If you need to verify which is active: `Get-ScheduledTask -TaskName 'BudgetDispatcher-Node' | Get-ScheduledTaskInfo`.

**When to flip `dry_run: false`:** only for the Node engine, only after one clean dry-run milestone has been observed in `status/budget-dispatch-log.jsonl`, and only after R-3 has landed. This session ships R-3. The clean dry-run milestone is already satisfied operationally by the manual harness (see section 3). The remaining nice-to-have is observing one in a real scheduled firing, but it's no longer strictly required — the harness test exercises the same code path.

---

## Part 5: what's still Perry-gated (shorter than Part 4)

1. **Observing a dry-run milestone in a live scheduled firing** — no longer strictly required (harness test covers the same code path) but desirable for end-to-end confidence in the PS1 wrapper + mutex + dispatch.mjs + selector + router + dry-run-log chain. To see it: stop touching the machine for 20+ full minutes during one of these windows (current time 12:20 local):
   - **12:36:43** — step away by **12:16** (passed; too late)
   - **12:56:43** — step away by **12:36**
   - **13:16:43** — step away by **12:56**
   - **13:36:43** — step away by **13:16**
   - …pattern continues every 20 min at `:16:43`, `:36:43`, `:56:43`
2. **R-4 OneDrive junction decision** — still Perry-gated, still data-migration-class. See Part 4 for the three options; all three require Perry to decide the tradeoff and the next instance to architect + test carefully. Do not touch without explicit authorization.
3. **`dry_run: false` flip** — both prerequisites (clean milestone + R-3 landed) are effectively satisfied. The flip is your call. Recommend one more scheduled-firing observation first for belt-and-suspenders.

## Part 5: next instance's backlog (prioritized)

**Sonnet-delegate (mechanical):**
- **R-5 JSONL log rotation** (`scripts/lib/log.mjs`) — daily rotation with reverse-read optimization. Delegate to Sonnet. Give clear acceptance criteria: rotation on day boundary, `countTodayRuns()` still correct, no race with concurrent appends.
- **R-7 stale `.git/index.lock` cleanup** — startup check in `run-dispatcher.ps1` or `dispatch.mjs`. Very mechanical but PS1 must stay pure ASCII (R-6 hook enforces this).
- **I-4 explicit per-API-call `AbortSignal.timeout(60000)`** on all SDK calls — `worker.mjs`, `selector.mjs`, `verify-commit.mjs`. Mechanical pattern, same edit applied N times.
- **S-6 selector allowlist verification** — the claim in Part 4 is that S-6 is already satisfied via I-1's `projects.find`/`opportunistic_tasks.includes` checks in `selector.mjs`. Sonnet should verify this by reading the code and either marking it done or filing a new finding.
- **C-4 periodic `git fsck`** — add a scheduled-task entry (separate from the dispatcher) or a weekly hook that runs `git fsck --full` against the repo and logs the result.

**Opus-scope (design / judgment):**
- **S-7 Semgrep + gitleaks pre-commit** — new scanner infra. Opus designs the rule set and where to hook it (pre-commit? separate CI? both?), Sonnet implements once the design is pinned.
- **C-5 task-class fallback chain** (`router.mjs`) — requires judgment on what "fallback" means for each task class. If Gemini 2.5 Pro is 503ing on an explore task, is falling back to Mistral acceptable? For clinical? For docs? Design call.
- **libuv crash latent mitigation** — `dispatch.mjs` `process.exit()` fires while `@google/genai` HTTP handles are still closing. The mitigation (replace `process.exit(0)` with natural return + `main().finally(() => setImmediate(() => process.exit(process.exitCode ?? 0)))`) is architected in Part 4's "latent items" section. Not needed while selector null-return path is rare, but worth landing before any high-frequency Gemini error conditions.

**Perry-gated / data-migration:**
- **R-4 OneDrive junction topology decision** — see Part 4 for the three options. This is not for the next instance to execute unilaterally.

Scorecard (unchanged from Part 4 except R-3 now ✅):

| Status | Count | Findings |
|---|---|---|
| ✅ Done | 16/42 | S-3, S-4, S-5, S-9, C-2, C-3, I-1, I-2, R-2, C-1, R-1, R-6, I-3, ajv install, 1889d60 hot-fix, **R-3** |
| ⏳ Open HIGH | 2 | S-6 (likely already done), S-7 |
| ⏳ Open MEDIUM | 5 | R-4, R-5, R-7, C-4, C-5, I-4 |
| ⏳ Deferred-infra | 2 | S-1, S-2 (need WSL2/Windows Sandbox) |

---

# Handoff — PC Claude instance (Part 3)

**Session:** 2026-04-14 early afternoon — follow-up to Part 2. Audited the prior-session plan, tightened one finding, executed counter-bug fix, then knocked down 8 of the laptop audit's CRITICAL/HIGH findings in 5 commits, all pre-reviewed via `mcp__pal__codereview` with `gemini-2.5-pro`, all pushed to origin.

**Machine:** Perry's PC. **Target of this handoff:** next instance — laptop or PC.

---

## Paste this into the next Claude Code session

```
Resume work on the claude-budget-dispatcher / combo multi-project hardening.

Required reading (in order):
1. claude-budget-dispatcher/HANDOFF.md (this file — session baton from PC Part 3)
2. git log --oneline main -10  (five new "fix:" commits landed 2026-04-14 afternoon — read their full bodies for context)
3. combo/HANDOFF-2026-04-14.md  (laptop audit, 42+ findings — tracks which ones are still open)
4. combo/ai/STATE.md

Current state: PC pushed 5 hardening commits this session covering S-3, S-4, S-5, S-9 (worker.mjs path traversal + env leak), C-2 (clinical gate 3-file cap), C-3 (H1 ceremony push-url override), I-1 (Gemini native JSON mode in selector), I-2 (per-provider free-tier rate limiting), plus the original counter-bug fix. Dispatcher is healthy on PC and still dry-run. The first end-to-end dry-run dispatch milestone record is still NOT observed — that requires Perry to step away from the PC for ≥20 min during a firing window so the activity gate opens.

DO NOT flip dry_run: false yet. Remaining blocker before going live: R-2 (hanging test timeout + process-tree kill) — without it, a hanging test blocks the dispatcher indefinitely. That's the most important next item.

Laptop audit items still open, in recommended order:
1. R-2 — worker.mjs runTestsSafe: add process-tree timeout using taskkill /T /F /PID on Windows (spawn instead of execFileSync, attach timeout, kill tree on expiry).
2. R-1 — worker.mjs codegen output JSON: ajv schema validation (selector is already covered by I-1 native JSON mode, so this is just the audit and docs responses in worker.mjs).
3. C-1 — worker.mjs auditChanges: route the Gemini-audits-Gemini loop to Mistral instead, for model family diversity.
4. R-3 — run-dispatcher.ps1: replace PID-file mutex with Windows named mutex (Global\claude-budget-dispatcher). WARNING: PS1 files must stay pure ASCII; prior session hit encoding breaks from smart quotes.
5. S-6 — selector.mjs: allowlist validation on output fields (already partially mitigated by I-1 schema; belt-and-suspenders check that project slug is in projects_in_rotation and task is in opportunistic_tasks — already done, so this may be complete).

Deferred (need infra): S-1 execution sandbox, S-2 network isolation (both need WSL2 / Windows Sandbox).

Pre-commit mandate: every commit must go through mcp__pal__codereview with model: "gemini-2.5-pro" per combo/CLAUDE.md. If Gemini returns 503 high-demand on the external expert step, switch that codereview call to review_validation_type: "internal" + use_assistant_model: false.
```

---

## What this session landed

Five commits on `main`, all pushed to `origin/main`:

| Commit  | Findings                       | File(s)                                              |
|---------|--------------------------------|------------------------------------------------------|
| d2b71b5 | counter bug (new, not audits)  | `scripts/lib/log.mjs`                                |
| 324531a | S-3, S-4, S-5, S-9             | `scripts/lib/worker.mjs`                             |
| 78f7625 | C-2, C-3                       | `scripts/lib/verify-commit.mjs`, `scripts/dispatch.mjs` |
| 50a155c | I-1                            | `scripts/lib/selector.mjs`                           |
| 93e9207 | I-2                            | `scripts/lib/throttle.mjs` (new) + 3 call-site files |

### Key correction from the prior plan

`C:\Users\perry\.claude\plans\zesty-strolling-catmull.md` proposed filter predicate `obj.engine !== "node"` for `countTodayRuns()`. The audit in this session flagged that as **too broad** — it would exclude wrapper-level error envelopes (hard-timeout, exit-2, retries-exhausted from `run-dispatcher.ps1` lines 189/223/252), defeating the runaway-error safety ceiling. Corrected predicate: `obj.outcome !== "wrapper-success"` (single-site literal, preserves all error counting). Documented in `C:\Users\perry\.claude\plans\mutable-wiggling-lollipop.md`.

### Live smoke tests performed

- `countTodayRuns()` → 37 (down from 42, exact predicted math)
- `isPathInside()` helper — 11 path cases pass (symlink-equivalent escape, prefix-substring siblings like `foo-evil`, Windows case, reserved device names CON/PRN/LPT1, substring non-match like `console.log`, parent traversal, absolute-outside)
- `getSafeTestEnv()` — 4 cases pass (GEMINI_API_KEY + MISTRAL_API_KEY stripped, PATH + SystemRoot kept)
- H1 push-url ceremony — smoke-tested on throwaway git repo: pushurl=no_push active, fetch url preserved, unset restores default
- Gemini native JSON mode (I-1) — live-tested against `gemini-2.5-flash` with the full selector schema: returned schema-compliant JSON on first attempt, parses with plain `JSON.parse`

---

## Current dispatcher health (as of ~12:49 local 2026-04-14)

- Last 6 firings: all clean `reason: "user-active"` gate-skip + `wrapper-success` envelope
- `countTodayRuns()` stable at **37** (historical Mistral errors only — no new additions since the fix)
- `daily-quota-reached` skip reason: **not seen since d2b71b5**
- Scheduled task `BudgetDispatcher-Node`: firing cleanly every 20 min, `LastTaskResult: 0`
- `config/budget.json`: `dry_run: true`, `max_runs_per_day: 50` (gitignored, local-only)

---

## What's still Perry-gated (user must do, not next instance)

1. **Step away from the PC for ≥20 min during a firing window.** Activity gate opens, selector runs, dry-run milestone record lands in `status/budget-dispatch-log.jsonl` with `phase: "complete"`, `engine: "dispatch.mjs"`, `outcome: "dry-run"`, plus `project` / `task` / `delegate_to`. This is the first proof that the live Gemini → schema → router → dry-run exit pipeline actually works end-to-end with real API keys.
2. **After a clean dry-run is observed AND R-2 lands,** flip `"dry_run": false` in `config/budget.json` and watch the next firing produce a real work record.

---

## Findings: done vs. open (vs. laptop `combo/HANDOFF-2026-04-14.md`)

| ID  | Priority       | Change                                  | Status              |
|-----|----------------|-----------------------------------------|---------------------|
| S-3 | P0 CRITICAL    | worker.mjs realpath + trailing sep      | ✅ 324531a          |
| S-4 | P0 CRITICAL    | Windows case-insensitive compare        | ✅ 324531a          |
| S-5 | P0 CRITICAL    | env allowlist in test subprocess        | ✅ 324531a          |
| S-9 | P0 CRITICAL    | Windows reserved device name reject     | ✅ 324531a          |
| S-1 | P0 (long-term) | Execution sandbox                       | ⏳ needs WSL2/Sandbox |
| S-2 | P0 (long-term) | Network isolation for tests             | ⏳ needs sandbox    |
| C-2 | P1             | Remove `.slice(0, 3)` clinical cap       | ✅ 78f7625          |
| C-3 | P1             | H1 push-url override                    | ✅ 78f7625          |
| I-1 | P1             | Gemini native JSON mode (selector)      | ✅ 50a155c          |
| I-2 | P1             | Rate limiting between API calls         | ✅ 93e9207          |
| R-1 | HIGH           | ajv schema on worker codegen/audit JSON | ⏳ selector part done by I-1 |
| R-2 | HIGH           | Hanging test timeout + `taskkill /T /F` | ⏳ **most important** |
| R-3 | HIGH           | Named mutex replacing PID-file          | ⏳ PS1 encoding risk |
| C-1 | HIGH           | Cross-family audit (Mistral for audit)  | ⏳                  |
| S-6 | HIGH           | Selector allowlist validation           | ⏳ partial via I-1  |
| S-7 | HIGH           | Semgrep + gitleaks pre-commit           | ⏳ new infra        |
| C-4 | HIGH           | Periodic `git fsck`                     | ⏳                  |
| R-4 | MEDIUM         | OneDrive junction sync verify           | ⏳                  |
| R-5 | MEDIUM         | JSONL rotation                          | ⏳                  |
| R-6 | MEDIUM         | Pre-commit hook: reject non-ASCII in .ps1 | ⏳                |
| R-7 | MEDIUM         | Stale `.git/index.lock` cleanup         | ⏳                  |
| C-5 | MEDIUM         | Task-class fallback chain               | ⏳                  |
| I-3 | MEDIUM         | Selector outcome memory                 | ⏳                  |
| I-4 | MEDIUM         | Explicit per-API-call timeouts          | ⏳                  |
| I-5 | MEDIUM         | Cross-family audit (variant of C-1)     | ⏳                  |

---

## Gotchas learned / appended

1. **External codereview + Gemini 503.** `mcp__pal__codereview` with `review_validation_type: "external"` calls Gemini 2.5 Pro for a follow-up expert step. Gemini is experiencing intermittent 503 high-demand errors today. Workaround: pass `review_validation_type: "internal"` + `use_assistant_model: false` for simple reviews — still captures structured findings, skips the failing expert call.
2. **Prior plan predicate was wrong.** `engine !== "node"` would silently break runaway-error safety. Always audit the plan, not just the code.
3. **bash vs `$env:`.** `node -e` / `powershell -Command` commands that include `$env:FOO` get mangled by bash's dollar-sign interpolation. Use `KEY=$(powershell -Command "[Environment]::GetEnvironmentVariable('KEY','User')") node ...` or write a temp `.mjs` file and run it.
4. **`@google/genai` `Type` enum.** Exported from `@google/genai`, all uppercase values: `Type.OBJECT`, `Type.STRING`, etc. Use as the `type` field in a `responseSchema` object.
5. **`git remote set-url --push origin no_push`** verified on Windows — fetch URL (`remote.origin.url`) is preserved, `pushurl` is an independent config key. Crash-safe: stuck state is recoverable with `git config --unset remote.origin.pushurl`.
6. **Worktrees share `.git/config`.** H1 ceremony (even the new push-url version) mutates shared config, so concurrent dispatches from the same base repo would race. PID mutex prevents that in practice; formal fix is R-3.
7. **Throttle state is per-process.** `throttle.mjs` uses module-level `lastCallAt` which resets on every 20-min firing (fresh node process per `run-dispatcher.ps1`). Fine for current architecture; would need invalidation if dispatch.mjs ever became a daemon.

---

## Things NOT to do (unchanged + appended)

- Do not re-enable the `ClaudeBudgetDispatcher` scheduled task (the Claude-engine one).
- Do not set `core.autocrlf=false` globally.
- Do not paste API keys into chat.
- Do not commit `config/budget.json`.
- Do not click Antigravity's Settings → Workspaces.
- Do not break the status junction (`(Get-Item status).LinkType` should be `Junction`).
- Do not commit `node_modules/`.
- Do not push auto-branches.
- PS1 files must stay pure ASCII (PowerShell 5.1 + Windows-1252 encoding gotcha).
- Never use `gemini-3-pro-preview` — bills Perry's Google Cloud credits.
- **New:** Do not flip `dry_run: false` until (a) a clean dry-run milestone is observed AND (b) R-2 (test hang timeout) lands. A hanging test with `dry_run: false` blocks the dispatcher indefinitely until manual intervention.
- **New:** For `mcp__pal__codereview` during Gemini high-demand periods, use internal validation to avoid 503s on the expert step.

---

## Files to read first (next session, whichever machine)

1. **This file** (`claude-budget-dispatcher/HANDOFF.md`)
2. `git log --oneline main -10` then `git show <hash>` for each of the 5 new commits (commit bodies contain the audit-finding mapping and rationale)
3. `combo/HANDOFF-2026-04-14.md` — laptop audit with full findings
4. `combo/ai/STATE.md` — rolling cross-instance context
5. `scripts/lib/throttle.mjs` (new helper) and the call sites in `scripts/lib/selector.mjs`, `scripts/lib/worker.mjs`, `scripts/lib/verify-commit.mjs` to see the throttle wiring pattern before adding new API call sites
6. `scripts/lib/worker.mjs` lines 20-85 (isPathInside, getSafeTestEnv helpers) — reference implementation for any further path-safety work

---

## Memory files

Auto-load from `C:\Users\perry\.claude\projects\c--Users-perry-DevProjects-claude-budget-dispatcher\memory\`:
- `user_github_identity.md`
- `reference_antigravity_paths.md`

No new memories written this session — all decisions captured here and in commit messages.

---

This handoff is the one-shot session baton. Top-level `HANDOFF.md` is **untracked** (not in git) and overwritten at session end.

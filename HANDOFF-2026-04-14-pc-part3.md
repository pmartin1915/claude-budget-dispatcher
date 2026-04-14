# Handoff — PC Claude instance (Part 3)

**Session:** 2026-04-14 early afternoon — follow-up to Part 2. Audited the prior-session plan, tightened one finding, executed counter-bug fix, then knocked down 8 of the laptop audit's CRITICAL/HIGH findings in 5 commits, all pre-reviewed via `mcp__pal__codereview` with `gemini-2.5-pro`, all pushed to origin.

**Machine:** Perry's PC. **Target of this handoff:** next instance — laptop or PC.

> This file is the **tracked, git-pullable** copy of the session baton. The untracked `HANDOFF.md` at repo root is a mirror that gets overwritten each PC session.

---

## Paste this into the next Claude Code session

```
Resume work on the claude-budget-dispatcher / combo multi-project hardening.

Required reading (in order):
1. claude-budget-dispatcher/HANDOFF-2026-04-14-pc-part3.md (this file — session baton from PC Part 3)
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

1. **This file** (`claude-budget-dispatcher/HANDOFF-2026-04-14-pc-part3.md`)
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

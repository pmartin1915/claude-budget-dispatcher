# Handoff — PC Claude instance (Part 4)

**Session:** 2026-04-14 late afternoon — follow-up to Parts 2/3 + laptop Session 16. Pulled the laptop's R-2/C-1/R-1/R-6/I-3 commits, installed the pre-commit ASCII hook, investigated a live selector crash that surfaced when the activity gate first opened, isolated the root cause with direct Gemini SDK experiments, and shipped a hot-fix. One commit landed: `1889d60`.

**Machine:** Perry's PC. **Target of this handoff:** next instance — laptop or PC.

> This is the tracked, git-pullable session baton. Pull and read it on any machine via `git pull origin main` then open this file.

---

## Paste this into the next Claude Code session

```
Resume work on the claude-budget-dispatcher / combo multi-project hardening.

Required reading (in order):
1. claude-budget-dispatcher/HANDOFF-2026-04-14-pc-part4.md (this file — session baton from PC Part 4)
2. git log --oneline main -15  (use `git show <hash>` for the relevant commits; commit bodies carry rationale)
3. combo/CLAUDE.md  (Opus 4.6 / Sonnet 4.5 delegation rules — Opus handles architecture, clinical, security, cross-model orchestration; Sonnet handles exploration, tests, docs, mechanical refactors, lint/typecheck, boilerplate. Use Task tool with subagent_type="general-purpose" + model: "sonnet" for mechanical work.)
4. combo/HANDOFF-2026-04-14.md  (laptop audit, 42+ findings — scorecard below tracks current state)
5. combo/ai/STATE.md + combo/ai/DECISIONS.md

Pre-commit mandate (combo/CLAUDE.md): every commit must go through mcp__pal__codereview with model: "gemini-2.5-pro". Cross-model audit is deliberately routed to a different model family than generation to avoid shared blind spots. If Gemini 2.5 Pro is experiencing 503 high-demand (intermittent today), use review_validation_type: "internal" + use_assistant_model: false on the codereview call to skip the expert follow-up.

Current state: selector hot-fix (1889d60) just landed. Activity gate finally opened earlier today but the first three selector firings hit a thinking-truncation bug — fixed and pushed. The first end-to-end dry-run milestone record has NOT yet been observed. Perry should step away for 20+ min during a firing window to verify the fix works live. Do not flip dry_run: false until a clean milestone is observed.

Remaining work (prioritized, see scorecard in this handoff for full table):

**Opus-scope (architect + decide):**
- R-4 OneDrive junction topology decision — investigation done, data-migration-class fix needed. Three options documented in this handoff.
- libuv crash latent — dispatch.mjs process.exit() fires while @google/genai HTTP handles are still closing. With the selector fix in place the null-return path is rarely hit, but recurrence mitigation is architected here.
- S-7 Semgrep + gitleaks pre-commit — new scanner infra. Opus architects, Sonnet implements.
- C-5 task-class fallback chain (router.mjs) — requires judgment on task-class routing.

**Sonnet-delegate (mechanical, use Task tool with model: "sonnet"):**
- R-3 named mutex in run-dispatcher.ps1 — PS1 edit replacing PID file. WARNING: PS1 must stay pure ASCII (R-6 pre-commit hook enforces this, so Sonnet errors will be caught).
- R-5 JSONL log rotation (log.mjs) — daily rotation with reverse-read optimization.
- R-7 stale .git/index.lock cleanup — startup check in run-dispatcher.ps1 or dispatch.mjs.
- I-4 explicit per-API-call AbortSignal.timeout(60000) on all SDK calls — worker.mjs, selector.mjs, verify-commit.mjs.
- S-6 selector allowlist verification — selector.mjs already has projects.find/opportunistic_tasks.includes checks (post-I-1). Sonnet should verify S-6 is already satisfied; if so, mark it done in combo/HANDOFF-2026-04-14.md.

After each change, run mcp__pal__codereview with gemini-2.5-pro per mandate, then commit + push. One commit per finding where possible for bisectability.

Before flipping dry_run: false, you must (a) observe one clean dry-run milestone record in status/budget-dispatch-log.jsonl with phase:"complete", engine:"dispatch.mjs", outcome:"dry-run", project, task, delegate_to — AND (b) confirm no libuv crash in the run log for that firing.
```

---

## What this session landed

| Commit  | Scope                                 | File(s)                                              |
|---------|---------------------------------------|------------------------------------------------------|
| `1889d60` | Selector hot-fix: flash + thinking budget + defensive guards | `scripts/lib/selector.mjs`, `scripts/lib/extract-json.mjs` |

Also: pulled laptop commits `3f8796a` (R-2) and `5d99988` (C-1/R-1/R-6/I-3), installed `.git/hooks/pre-commit` from `scripts/hooks/pre-commit`.

### Root cause of the selector crash

The activity gate opened on the PC for the first time today. Three firings actually ran the selector. **All three failed** with:

```
[selector] JSON parse failed: Cannot read properties of undefined (reading 'match')
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

exit code `-1073740791` (0xC0000409, Windows STATUS_STACK_BUFFER_OVERRUN — libuv assertion fires during shutdown).

Isolated via direct Gemini SDK experiments on `gemini-2.5-flash`:

| Config                                    | Response             | Status |
|-------------------------------------------|----------------------|--------|
| maxTokens=500, **thinking enabled** (default)    | text length **48**, truncated mid-string at `"task": "test` | **BUG** — matches production |
| maxTokens=500, `thinkingConfig: { thinkingBudget: 0 }` | text length **189**, full schema-compliant JSON | **WORKING** |
| gemini-2.5-pro + `thinkingBudget: 0`      | `400 INVALID_ARGUMENT: "Budget 0 is invalid. This model only works in thinking mode."` | **pro blocks the fix** |

Thinking reasoning tokens count against `maxOutputTokens`. With a 500-token cap, thinking eats the budget before the JSON closes, returning a truncated string. `JSON.parse` fails, fallback `extractJson` crashes on `.match()` of undefined, `process.exit(0)` fires while the @google/genai SDK's HTTP handles are mid-close → libuv assertion.

### Fixes in `1889d60`

- **Default selector model:** `gemini-2.5-pro` → `gemini-2.5-flash`. Flash supports `thinkingBudget: 0`, has better free-tier rate limits (less 503-prone), and the selector task is structured enough that pro's reasoning value is marginal.
- **Conditional `thinkingConfig: { thinkingBudget: 0 }`** applied only when the model name includes "flash". Users who override `selector_model` back to pro in budget.json need to raise `selector_max_tokens` to 2000+ to avoid the truncation path.
- **`callGeminiWithRetry` guards against undefined/empty `response.text`** and treats it as a retryable transient error, exhausting the retry ladder before throwing.
- **`selector.mjs` defensive check on `responseText`** before parse.
- **`extract-json.mjs` throws a clear error on non-string/empty input** instead of the opaque `.match()` crash — protects all future callers.

### Live verification

- 7 `extractJson` smoke cases (undefined / null / empty / no-JSON / bare / embedded / fenced) — all pass.
- End-to-end `selectProjectAndTask()` call with a real Gemini client + sandbox `projects_in_rotation` config → returned complete schema-valid `{project, task, reason, projectConfig}` object.

---

## Current dispatcher health (as of ~17:17 local 2026-04-14)

- **Pre-commit hook installed** and executable at `.git/hooks/pre-commit`.
- **Activity gate has been opening.** Last 3 firings produced actual selector calls — not just user-active skips. That means Perry has been stepping away. The selector fix in `1889d60` should now produce the first dry-run milestone on the next open gate.
- `countTodayRuns()` drift expected: the 3 failed selector firings logged as `outcome: "skipped"` with `reason: "selector-failed"`, so they're NOT counted against the daily quota (per the counter fix from `d2b71b5`).
- Scheduled task `BudgetDispatcher-Node` firing cleanly every 20 min.
- `config/budget.json`: `dry_run: true`, `max_runs_per_day: 50` (gitignored).

---

## What's still Perry-gated

1. **One more step-away during a firing window** to verify `1889d60` produced a real milestone record.
2. **Verify the JSONL log** shows `phase: "complete"`, `engine: "dispatch.mjs"`, `outcome: "dry-run"`, plus `project` / `task` / `delegate_to` on that record.
3. **Verify no libuv crash** in `status/dispatcher-runs/<ts>-<runid>.log` for that firing. If libuv recurs, escalate — see "latent items" below.
4. **R-4 OneDrive junction decision** — data-migration-class change, not something the next instance should execute without Perry's explicit direction. See investigation below.
5. **After (1)-(3) succeed AND R-3 lands,** flip `"dry_run": false`.

---

## Junction investigation (R-4)

```
PS> Get-Item C:\Users\perry\DevProjects\claude-budget-dispatcher\status

Name     : status
LinkType : Junction
Target   : C:\Users\perry\OneDrive\Documents\claude-budget-dispatcher-status
FullName : C:\Users\perry\DevProjects\claude-budget-dispatcher\status
```

Current topology: **junction in the repo pointing into OneDrive**. Writes through the junction DO land physically in the OneDrive folder on disk, but `FindFirstChangeNotification` (which OneDrive uses for real-time sync watch) doesn't propagate through NTFS junctions — OneDrive's sync watcher never gets change events, so files don't sync to the laptop until OneDrive's periodic rescan eventually catches them (or never, if the rescan is disabled).

The laptop reports that `claude-budget-dispatcher-status/` never appeared in OneDrive on the laptop side, which means rescan isn't working either on this setup.

**Options** (Opus decision, Perry-gated):

1. **Invert the topology:** move real data to live inside OneDrive, have the repo's `status/` be a symlink (not a junction) pointing into OneDrive. Symlinks propagate `FindFirstChangeNotification` events properly. Requires: copy data out of current junction, delete junction, create new symlink, verify sync. Risk: if OneDrive doesn't like tracking a symlink target, data could be lost; test on a scratch dir first.
2. **Drop the junction entirely:** update `scripts/lib/log.mjs` `STATUS_DIR` constant to point directly at `C:\Users\perry\OneDrive\Documents\claude-budget-dispatcher-status`, make the repo's `status/` a real empty directory (gitkeep), and have the dispatcher write outside the repo. Cleanest approach but changes the file-layout contract.
3. **Accept the limitation:** document that cross-machine status sync is unreliable via OneDrive. Use git push/pull of a status branch, or switch to a different sync mechanism (Syncthing, Dropbox Selective Sync, direct SSH copy). No code change; operational change.

None of these are mechanical — all require Perry to decide the tradeoff and the next instance to architect + test carefully. Do not attempt without explicit authorization.

---

## Findings scorecard (vs. laptop `combo/HANDOFF-2026-04-14.md` — 42 total)

| ID  | Priority | Change                                    | Status                                    |
|-----|----------|-------------------------------------------|-------------------------------------------|
| S-3 | P0 CRIT  | worker.mjs realpath + trailing sep        | ✅ `324531a` (PC)                         |
| S-4 | P0 CRIT  | Windows case-insensitive compare          | ✅ `324531a` (PC)                         |
| S-5 | P0 CRIT  | env allowlist in test subprocess          | ✅ `324531a` (PC)                         |
| S-9 | P0 CRIT  | Windows reserved device name reject       | ✅ `324531a` (PC)                         |
| S-1 | P0 LT    | Execution sandbox                         | ⏳ needs WSL2/Windows Sandbox              |
| S-2 | P0 LT    | Network isolation for tests               | ⏳ needs sandbox                           |
| C-2 | P1       | Remove `.slice(0, 3)` clinical cap        | ✅ `78f7625` (PC)                         |
| C-3 | P1       | H1 push-url override                      | ✅ `78f7625` (PC)                         |
| I-1 | P1       | Gemini native JSON mode (selector)        | ✅ `50a155c` (PC) + `1889d60` (bug-fix)    |
| I-2 | P1       | Per-provider rate limiting                | ✅ `93e9207` (PC)                         |
| R-2 | HIGH     | Test hang timeout + `taskkill /T /F`      | ✅ `3f8796a` (laptop)                     |
| C-1 | HIGH     | Cross-family audit (Mistral audits Gemini)| ✅ `5d99988` (laptop)                     |
| R-1 | HIGH     | ajv schema on worker codegen/audit JSON   | ✅ `5d99988` (laptop)                     |
| R-6 | HIGH     | Pre-commit hook: reject non-ASCII in .ps1 | ✅ `5d99988` (laptop) + installed on PC    |
| I-3 | HIGH     | Selector sees recent outcomes             | ✅ `5d99988` (laptop)                     |
| R-3 | HIGH     | Named mutex replacing PID-file            | ⏳ **Sonnet-delegate, PS1 encoding risk** |
| S-6 | HIGH     | Selector allowlist validation             | ⏳ **likely already done via I-1**        |
| S-7 | HIGH     | Semgrep + gitleaks pre-commit             | ⏳ Opus architects, Sonnet implements     |
| C-4 | HIGH     | Periodic `git fsck`                       | ⏳ Sonnet-delegate                         |
| R-4 | MEDIUM   | OneDrive junction sync                    | ⏳ **investigation done, Perry decision** |
| R-5 | MEDIUM   | JSONL rotation                            | ⏳ Sonnet-delegate                         |
| R-7 | MEDIUM   | Stale `.git/index.lock` cleanup           | ⏳ Sonnet-delegate                         |
| C-5 | MEDIUM   | Task-class fallback chain                 | ⏳ Opus-scope                              |
| I-4 | MEDIUM   | Explicit per-API-call `AbortSignal.timeout` | ⏳ Sonnet-delegate                       |
| I-5 | MEDIUM   | Cross-family audit variant                | ⏳ partial via C-1                         |

**Done total: 15/42.** **Open HIGH: 4** (R-3, S-6, S-7, C-4). **Open MEDIUM: 5.** **Deferred-infra: 2** (S-1, S-2).

### Latent items (not in the audit)

- **libuv assertion crash on `process.exit`.** Fires when `dispatch.mjs` calls `process.exit(0)` while `@google/genai`'s HTTP keep-alive handle is still closing. Observed in two of three attempts on `run_id ee7ec5b7`. With the selector hot-fix in `1889d60`, the null-return path that triggers this is rarely hit, so it's unlikely to recur. **If it does:** the mitigation is to replace `process.exit(0)` calls in dispatch.mjs cold paths with natural `return` + a `main().finally(() => setImmediate(() => process.exit(process.exitCode ?? 0)))` wrapper to let handles drain before force-exit.

---

## Opus/Sonnet workflow reminder (combo/CLAUDE.md)

You are Opus 4.6. Delegate these to Sonnet via `Task` tool with `subagent_type: "general-purpose"` and `model: "sonnet"`:
- Codebase exploration, grep, find-usages
- Running tests + reporting results
- Boilerplate generation
- JSDoc / markdown / docs updates
- Lint / typecheck + simple fixes
- Mechanical refactors (rename, move, search-replace)
- Routine git staging + commits *of work Sonnet produced*

Keep for yourself (Opus):
- Architecture and design decisions (R-4 junction decision, C-5 fallback routing)
- Clinical logic review (not active this session — no domain/ touches)
- Security audit (R-3 mutex semantics, S-7 scanner integration)
- Cross-model orchestration (when to use which model for audit)
- Multi-file debugging (the selector hot-fix was Opus work — good call by Part 4)
- Framework protocol changes

Post-change audit: **always run `mcp__pal__codereview` with `model: "gemini-2.5-pro"`** before committing. Route to Gemini deliberately — different family than Opus (Anthropic), avoids shared blind spots. Fallback if 503: switch to `review_validation_type: "internal"` + `use_assistant_model: false`.

---

## Gotchas (cumulative, all sessions)

1. **Gemini 2.5 Pro intermittent 503 "high demand"** — affects both production selector calls and `mcp__pal__codereview` external validation. Workaround for codereview: internal validation. Workaround for selector: switched default model to flash in `1889d60`.
2. **Gemini 2.5 Pro + thinking mode + small maxOutputTokens = truncated response.** Root cause of this session's crash. Use flash or raise token cap to 2000+.
3. **`gemini-2.5-pro` rejects `thinkingBudget: 0`** with `INVALID_ARGUMENT`. Flash accepts it. Any disable-thinking logic must be conditional on model name.
4. **`extractJson(undefined)` threw "reading 'match'" opaquely.** Now guarded with a clear input check — protects all callers.
5. **Prior-plan audit caught a wrong predicate** (counter filter `engine !== "node"` would have silently broken runaway-error safety). Always audit the plan, not just the code.
6. **`$env:` in bash-invoked PowerShell commands gets mangled** by bash's dollar-sign interpolation. Use `KEY=$(powershell -Command "...")` pattern or write to a temp `.mjs`/`.ps1` file and invoke it.
7. **`@google/genai` Type enum** — exported uppercase: `Type.OBJECT`, `Type.STRING`. Use as `type` field in `responseSchema`.
8. **`git remote set-url --push origin no_push`** verified on Windows — fetch URL preserved, pushurl is independent. Crash-recovery: `git config --unset remote.origin.pushurl`.
9. **Worktrees share `.git/config`** — the H1 ceremony (even the push-url variant from C-3) mutates shared config. PID mutex is the cross-cutting mitigation; R-3 formalizes that.
10. **`throttle.mjs` state is per-process.** Resets on every 20-min firing. Intentional — documented.
11. **OneDrive junction sync** — `FindFirstChangeNotification` doesn't propagate through NTFS junctions. Current topology is backwards-for-sync. R-4 decision required.
12. **Node/libuv assertion on `process.exit`** — fires if SDK HTTP handles are mid-close. Use natural return + `setImmediate` for cold paths to avoid; latent today, monitor.

---

## Things NOT to do (binding, cumulative)

- Do not re-enable the `ClaudeBudgetDispatcher` scheduled task (the Claude-engine one).
- Do not set `core.autocrlf=false` globally.
- Do not paste API keys into chat.
- Do not commit `config/budget.json`.
- Do not click Antigravity's Settings → Workspaces.
- Do not break the status junction without a tested recovery plan (R-4 decision required first).
- Do not commit `node_modules/`.
- Do not push auto-branches.
- PS1 files must stay pure ASCII. `scripts/hooks/pre-commit` enforces this now; don't bypass with `--no-verify`.
- Never use `gemini-3-pro-preview` — bills Perry's Google Cloud credits.
- Do not flip `dry_run: false` until (a) one clean dry-run milestone is observed AND (b) R-3 mutex has landed AND (c) no libuv crash recurs in the observed firing.
- For `mcp__pal__codereview` during Gemini 2.5 Pro high-demand periods, use `review_validation_type: "internal"` + `use_assistant_model: false`.
- Do not restore `gemini-2.5-pro` as the selector default without also raising `selector_max_tokens` to 2000+ (see gotcha 2).

---

## Files to read first (next session, whichever machine)

1. **This file**
2. `git log --oneline main -15` then `git show 1889d60` for the hot-fix rationale
3. `combo/CLAUDE.md` — Opus/Sonnet delegation + PAL audit mandate
4. `combo/HANDOFF-2026-04-14.md` — full laptop audit with 42 findings
5. `combo/ai/STATE.md` + `combo/ai/DECISIONS.md`
6. `scripts/lib/selector.mjs` — see the new thinkingConfig/flash default and the retry guard
7. `scripts/lib/worker.mjs` lines 20-85 + throttle wiring — reference patterns for any new API call sites
8. `status/dispatcher-runs/<latest>-<runid>.log` — check if the next firing produces a clean dry-run milestone

---

## Memory files

Auto-load from `C:\Users\perry\.claude\projects\c--Users-perry-DevProjects-claude-budget-dispatcher\memory\`:
- `user_github_identity.md`
- `reference_antigravity_paths.md`

No new memories written this session. All decisions captured here and in commit bodies.

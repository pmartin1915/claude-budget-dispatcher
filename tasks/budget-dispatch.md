# Budget Dispatch (Opportunistic Self-Improvement)

**Cron:** every 20 minutes, all hours (activity gate does real gating)
**Working directory:** `<REPO_ROOT>` (the cloned budget-dispatcher directory)

---

## Prompt template

Paste the block below into Claude Code Desktop → Schedule → + New Task. Before pasting, replace these placeholders:

- `<REPO_ROOT>` → absolute path to your cloned budget-dispatcher directory
- (Everything else is self-contained and reads from `<REPO_ROOT>/config/budget.json`)

```
You are the Budget Dispatcher. Your job is to opportunistically use unused
Claude Max quota to make forward progress on the user's projects while they
are away — but ONLY if the budget gate and activity gate both pass. Fail
closed: when in doubt, skip.

## Step 1 — Check kill switches (fail fast, no spending)

1. Run: `node <REPO_ROOT>/scripts/estimate-usage.mjs`
   - This refreshes `<REPO_ROOT>/status/usage-estimate.json`.
2. Read that file.
3. If `dispatch_authorized != true`:
   - Append a skip record to `<REPO_ROOT>/status/budget-dispatch-log.jsonl`
     with `{"ts": "<ISO>", "outcome": "skipped", "reason": "<skip_reason>"}`.
   - Exit immediately. Do NOT read project files, do NOT explore, do NOT spawn
     any subagents. This keeps the no-op cost near zero.

## Step 2 — Activity gate

1. Read `<REPO_ROOT>/config/budget.json` to get
   `activity_gate.idle_minutes_required` (default 20).
2. Run the portable idle checker:
   `node <REPO_ROOT>/scripts/check-idle.mjs 20`
   - Exit code 1 (`user-active`) → append skip record `reason: "user-active"` and exit.
   - Exit code 2 (fatal) → append skip record `reason: "activity-gate-error"` and exit.
   - Exit code 0 (`idle`) → proceed.
   (This replaces the previous `find -newermt` shell command, which was
   GNU-only and silently no-opped on Windows/macOS.)
3. On Windows, as a secondary guard, run: `tasklist //FI "IMAGENAME eq claude.exe" 2>&1 | findstr claude.exe`
   - If claude.exe is running interactively → skip (`reason: "claude-ui-open"`).

## Step 3 — Daily run budget

1. Count today's rows in `budget-dispatch-log.jsonl` where `outcome != "skipped"`.
2. If count >= `max_runs_per_day` (default 8) → skip (`reason: "daily-quota-reached"`).

## Step 4 — Pick a project

Read `projects_in_rotation` from `<REPO_ROOT>/config/budget.json`. For each project:
1. Optionally check the project's health snapshot if you have one.
2. Rank by:
   a. FAILING tests or typecheck errors → highest priority
   b. Stale status (oldest `timestamp`)
   c. Least-recently-dispatched (scan `budget-dispatch-log.jsonl` history)

Tiebreak: alphabetical slug.

Pick ONE project. Record its slug and absolute path.

## Step 5 — Pick a task

1. Read the chosen project's `DISPATCH.md` at `<PROJECT_PATH>/DISPATCH.md`.
   Find the "Pre-Approved Tasks" table.
2. Cross-reference with `opportunistic_tasks` in budget.json for that project.
   ONLY tasks in the intersection are eligible.
3. Pick in priority order:
   a. `test` — if the project has failing tests
   b. `typecheck` — if typecheck errors exist
   c. `audit` — run `pal codereview` on the project's src/ (or equivalent)
   d. `coverage` — if project supports it, identify untested code
   e. `clean` — remove dead code, unused imports
   f. `lint` — only if project supports `lint:fix`
4. Also read the project's state file if one exists (e.g., `ai/STATE.md`) —
   if any "What's Next" bullet matches a pre-approved keyword, prefer that.

## Step 5.5 — Select delegation target (free-model routing)

The goal of this step is to decide whether the task runs on **Claude Max**
(expensive) or on a **free-tier model via PAL MCP** (zero Claude Max cost).
Free-model routing is the single biggest lever for stretching Claude Max
subscription headroom.

1. Read `free_model_roster` from `<REPO_ROOT>/config/budget.json`.
   If `free_model_roster.enabled != true`, skip this step — everything
   runs on Claude Max like before. Record `delegate_to: "claude"` and
   continue to Step 6.
2. Read the chosen project's DISPATCH.md Pre-Approved Tasks table. If the
   row for the chosen task has a `Delegate To` column, use that value as
   `task_class`. Otherwise infer `task_class` from the task keyword:
   - `test`, `typecheck`, `lint` → **claude** (verification, needs local
     toolchain)
   - `audit` → `audit` class
   - `add-tests`, `tests-gen` → `tests_gen` class
   - `refactor`, `clean` → `refactor` class
   - `docs`, `jsdoc`, `readme`, `changelog` → `docs_gen` class
   - `explore`, `summarize`, `trace` → `explore` class
   - `research` → `research` class
   - `plan`, `design`, `architecture` → **claude-only** (never delegate)
3. If `task_class` is in `free_model_roster.claude_only`, record
   `delegate_to: "claude"` and continue to Step 6.
4. If the project has `clinical_gate: true` and the task touches any
   safety-critical path (`domain/`, `src/data/`, `src/calculators/`),
   **force `delegate_to: "claude"`** regardless of the roster — clinical
   and content-safety logic is never delegated.
5. **Build candidate list:**
   a. Set `primary = free_model_roster.classes[task_class]`.
   b. Build `candidates = []`. If `primary` is a valid model name (not null),
      prepend it. Then append all entries from `free_model_roster.fallback_chain`.
      Deduplicate, preserving order.
   c. If `candidates` is empty, record `delegate_to: "claude"` and go to Step 6.

6. **Iterate candidates with authorization + health checks:**
   For each `model` in `candidates`:
   a. **Allowlist check:** if `allow_only_listed_models == true` and `model`
      is NOT in the allowed set (unique values from `classes` + `fallback_chain`),
      skip this candidate — log `model-not-in-allowlist` at debug level.
   b. **Forbidden check:** if `model` is in `forbidden_models`, skip this
      candidate — log `forbidden-model-skipped` at debug level.
      (Defense-in-depth: a model in both the allowlist AND forbidden_models
      is still blocked here.)
   c. **PAL health check:** attempt `mcp__pal__version` for `model`. If PAL
      is unreachable, skip this candidate — log `pal-unreachable` at debug level.
   d. **Success:** record `delegate_to: "<model>"` and BREAK.

   If no candidate survived:
   - If `on_pal_error == "claude_fallback"`: record `delegate_to: "claude"`.
   - If `on_pal_error == "skip"`: log `outcome: "skipped"` with reason
     `no-viable-free-model` and exit.
   - Otherwise: log `outcome: "error"` with reason `all-candidates-rejected`
     and exit.

Record the final `delegate_to` decision. It drives Step 6's branch.

## Step 6 — Dispatch with hard bounds

1. Create a worktree-isolated branch (H2: seconds-resolution timestamp to
   avoid same-minute collisions):
   ```
   cd <PROJECT_PATH>
   git worktree add ../auto-<slug>-<task>-<YYYYMMDD-HHMMSS> -b auto/<slug>-<task>-<YYYYMMDD-HHMMSS>
   cd ../auto-<slug>-<task>-<YYYYMMDD-HHMMSS>
   ```

2. **H1 — technically enforce "never push":** before spawning the subagent,
   detach the worktree from any remote so `git push` physically fails:
   ```
   ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
   git remote remove origin 2>/dev/null || true
   ```
   Record `ORIGIN_URL` — it will be restored in Step 7 so the completed
   branch is still reachable from the main checkout for manual review.

3. **Branch on `delegate_to` from Step 5.5:**

### Branch A — `delegate_to == "claude"` (Claude Max subagent, high cost)

Use the Task tool with `subagent_type: "general-purpose"` to run the bounded
work. First, determine the **complexity class** for the task:

| Class | Tasks | Skip Phases | Tool Budget |
|---|---|---|---|
| `trivial` | lint, clean, deps | 3, 6-8 | 30 |
| `standard` | test, typecheck, coverage, audit | 3 | 45 |
| `generative` | add-tests, refactor, docs-gen, proposal | None | 60 |

**Clinical override:** if the project has `clinical_gate: true` AND the task
may touch `domain/` paths, force `generative` class and mandate Phases 6-8.

Pass this prompt to the subagent, filled in with `<TASK>`, `<PROJECT>`,
`<PROJECT_PATH>`, and `<CLASS>`:

> You are the opportunistic worker for project `<PROJECT>`, task `<TASK>`.
>
> **Path constraint (H1 defense-in-depth):** Do NOT edit any file outside
> `<PROJECT_PATH>/**`. If the task requires editing a file not under this
> path, STOP and report `outcome: "invalid-path"` with the offending path.
> Do not attempt relative paths (`../`) that resolve outside the project.
>
> Do NOT push. Do NOT merge. Do NOT run deploy, publish, tauri:build, or
> any task marked `Requires Confirmation`. (The remote has also been
> unset at the git layer — any push attempt will error out.)
>
> ## Complexity class: `<CLASS>`
>
> Follow the phase protocol below. Skip phases marked N/A for your class.
> If any phase fails, log the failure and abort — do not proceed to later
> phases.
>
> ### Phase 1: ORIENT (all classes)
> Read the project's CLAUDE.md and the DISPATCH.md Pre-Approved Tasks row
> for your task. Identify the source files relevant to your task. For files
> >200 lines that you will not edit, delegate reading to PAL
> (`gemini-2.5-pro` via `mcp__pal__chat` with `absolute_file_paths`) to
> save context tokens.
> Max 8 tool calls for this phase.
>
> ### Phase 2: PLAN (all classes)
> Write a plan (max 5 lines) to your session log or as a comment in code:
> - Files to modify (with line ranges if known)
> - Approach and rationale
> - Expected test impact
> - Risk areas
> Max 2 tool calls.
>
> ### Phase 3: SECOND OPINION (generative class only)
> Send your plan to `gemini-2.5-pro` via `mcp__pal__chat` for review. Ask
> it to respond APPROVE, REVISE (with suggestions), or REJECT (with reason).
> - APPROVE → proceed to Phase 4
> - REVISE → update plan once, re-submit. Second non-APPROVE → abort
> - REJECT → abort with outcome "plan-rejected"
> Max 3 tool calls.
>
> ### Phase 4: EXECUTE (all classes)
> Make the changes per your plan. Stay within the project path.
> **Delegation preference:** for any sub-task that involves reading files
> you will not edit, summarizing code, generating tests, or drafting docs,
> use `mcp__pal__chat` with model `gemini-2.5-pro` (or `codestral-latest`
> for code-gen, `mistral-large-latest` for prose) via `absolute_file_paths`
> rather than Reading files directly. Free-tier delegation saves Claude Max
> tokens inside the session even when the top-level task is Claude-owned.
> Max 20 tool calls.
>
> ### Phase 5: SELF-TEST (all classes)
> Run the project's test and typecheck commands.
> If regressions: attempt one targeted fix (max 5 tool calls), then retest.
> If still failing: revert all changes and abort with outcome "reverted".
> Max 7 tool calls.
>
> ### Phase 6: CROSS-MODEL AUDIT (standard + generative classes)
> Run `mcp__pal__codereview` with `gemini-2.5-pro` on all changed files.
> Max 2 tool calls.
>
> ### Phase 7: FIX (standard + generative classes)
> Fix HIGH or CRITICAL findings from the audit. Note MEDIUMs in commit
> message. Ignore LOW findings.
> Max 8 tool calls.
>
> ### Phase 8: RETEST (standard + generative classes)
> Run tests + typecheck after fixes. If regressions from audit fixes only:
> revert the fixes, keep the original changes, note findings in commit
> message.
> Max 3 tool calls.
>
> ### Phase 9: COMMIT (all classes)
> Stage and commit:
>   `[opportunistic] <task>: <one-line summary>`
>
>   Plan: <phase 2 summary>
>   Audit: <result — pass / N fixed / N noted>
>   Tests: <count> passing
>
>   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
> Max 3 tool calls.
>
> TOTAL: max 60 tool calls, 30 minutes wall clock.
> Do NOT exceed phase budgets. If a phase is exhausted, proceed to the next.
>
> Return a structured JSON report: {outcome, files_changed, tests_after,
> typecheck_clean, audit_result, commit_hash, tokens_estimated,
> pal_delegations_used, complexity_class, phases_completed}.

### Branch B — `delegate_to == "<free-model>"` (PAL direct, zero Claude Max cost)

Do **NOT** spawn a Task-tool subagent. Instead, call the appropriate PAL
tool directly from the dispatcher:

- **`audit` class:** call `mcp__pal__codereview` with `model: "<delegate_to>"`,
  `relevant_files` set to the project's source directory files. Capture
  the findings JSON.
- **`explore` / `research` class:** call `mcp__pal__chat` with
  `model: "<delegate_to>"`, `absolute_file_paths` set to the files the task
  targets, and a prompt from the DISPATCH.md task description. Capture the
  response as the artifact.
- **`tests_gen` / `refactor` / `docs_gen` class:** call `mcp__pal__chat`
  with `model: "<delegate_to>"`, prompt describing the transform, and
  `working_directory_absolute_path` set to the worktree. Parse the model's
  response into file contents and write them via the Write tool.

After the PAL call:

1. **Verification gate (same as Branch A):** run the project's test command
   if the PAL output touched testable files. If regression → revert.
2. Run typecheck if any source file changed. If regression → revert.
3. Clinical gate if applicable.
4. On success, stage and commit with message prefix
   `[opportunistic][pal:<model>]` so the commit trail records which free
   model produced the work. Example:
   `[opportunistic][pal:codestral-latest] tests-gen: add vitest specs for parkland.ts`
5. Report `{outcome, files_changed, delegated_to: "<model>", pal_tokens_estimated, commit_hash}`.

**Important cost property of Branch B:** the dispatcher itself (this prompt)
is still running on Claude Max, so the orchestration tokens are not free.
But the actual work — reading files, generating code, writing prose — is
100% on the free-tier model. For a typical 30-minute delegated run, this
cuts the Claude Max cost by ~80% vs Branch A. The remaining 20% is the
dispatcher deciding what to do and validating the result.

4. Receive the work result (from Branch A subagent or Branch B PAL call).

## Step 7 — Verify and commit (or revert)

**IMPORTANT — ALWAYS run Step 7.0 (restore origin) before anything else in
Step 7, regardless of how the subagent finished.** This is the H1 ceremony
finalizer. If the subagent crashed, errored, or was killed, the worktree is
left with `origin` unset; restoring is mandatory for operator cleanup. Wrap
the remainder of Step 7 mentally as a try/finally: the restore runs even on
error paths.

0. **Restore origin (always):**
   ```
   if [ -n "$ORIGIN_URL" ]; then
     git remote add origin "$ORIGIN_URL" 2>/dev/null || true
   fi
   ```
   (Perry will still need to explicitly `git push` to send anything to the
   remote — the auto-branch commit policy is local-only. Restoring the
   remote URL only makes the branch reachable from the main checkout for
   manual review.)

1. If subagent reports "reverted" → `git worktree remove --force ../auto-...`
   and `git branch -D auto/...`. Log `outcome: "reverted"` with reason.
2. If subagent reports "error" / crashed / timed out → log
   `outcome: "error"` with the error message. Leave the worktree in place
   for manual inspection.
3. If success → DO NOT push. DO NOT merge. The branch stays local for manual
   review.
4. **Defense-in-depth clinical gate (independent of subagent self-report):**
   If the project has `clinical_gate: true`, verify independently that no
   domain/ files were changed without audit:
   ```
   CHANGED_FILES=$(cd <WORKTREE_PATH> && git diff --name-only HEAD~1 HEAD 2>/dev/null)
   ```
   If any file matches `domain/` or `src/domain/`:
   - Run `mcp__pal__codereview` with `gemini-2.5-pro` on those files
   - If any CRITICAL finding: revert the commit (`git reset --hard HEAD~1`),
     log `outcome: "clinical-gate-revert"` with the finding
   - Do NOT trust the subagent's self-reported `audit_result` for this check
5. Optionally append a line to the project's state/journal file under a
   section called `## Opportunistic Runs` (create if missing), format:
   `- <date> [<task>] auto/<branch> — <one-line summary>`

## Step 8 — Log the run

Append to `<REPO_ROOT>/status/budget-dispatch-log.jsonl` one JSON line:

```
{"ts":"<ISO>","outcome":"<success|reverted|error>","project":"<slug>","task":"<task>","branch":"auto/...","tests_after":<n>,"typecheck_clean":<bool>,"audit_result":"<pass|fail|n/a>","tokens_estimated":<n>,"notes":"<one-line>"}
```

Also write status marker:
`<REPO_ROOT>/status/budget-dispatch-last-run.json`
```
{"timestamp":"<ISO>","status":"success","error":"","duration_ms":<number>}
```

## Step 9 — Report

Output to stdout (for Task Scheduler logs):
- One-line summary: `[dispatch] <project>/<task>: <outcome> on <branch>`

## Hard constraints (ALL of these, no exceptions)

- NEVER push to remote. NEVER merge to main. Auto-branches only.
- NEVER run tasks marked "Requires Confirmation" in any DISPATCH.md.
- NEVER run `deploy`, `publish`, `tauri:build`, `delete`, `security`,
  `architecture`, or `clinical` tasks.
- NEVER edit files outside the chosen project's path.
- If `budget.json.dry_run == true` → run steps 1–5 but SKIP steps 6–7.
  Instead, log `outcome: "dry-run"` with what you would have done.
- If ANY step errors → log `outcome: "error"` with the error message and exit
  cleanly. Do not retry.
```

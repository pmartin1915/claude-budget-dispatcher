# Handoff -- Part 19 (2026-04-18 18:30 UTC) -- Selector starvation fix + cowork integration

> **READ THIS FIRST.** Part 19 supersedes Parts 15-18 for current state. This session shipped a hotfix for selector starvation (commit `f868484`) and inherited 6 cowork commits (+1278 lines of new code, including a three-state health model, Analytics tab, ntfy alerting, schema validation, deep research prompt, per-provider timeouts, audit hardening). 5 greenfield sandboxes also got pushed to GitHub as public repos.

## Part 19: TL;DR

- **Shipped:** Selector rotation fix in commit `f868484`. Root cause was worker/verify-commit losing `project`/`task` fields on non-success outcomes, making 47/50 overnight skips invisible to the selector. Fix touches `dispatch.mjs`, `context.mjs`, `selector.mjs` (all hot-path). Self-healing — no manual intervention needed; rotation should unstick within ~200 minutes as other projects populate `last_attempted` for the first time.
- **Inherited from cowork (while Perry was away):** 6 commits, +1278 lines. Three-state health model (down/idle/healthy), cross-machine fleet view in dashboard (complements Part 18's gist-side sync), Analytics tab with skip-reason/activity/heatmap/model stats, ntfy.sh alerting on health state transitions, per-provider timeout config, config schema validation (budget.schema.json, 27 new unit tests), audit hardening (credential stripping, DNS rebinding guard), deep research audit prompt doc, open-dashboard.cmd taskbar shortcut.
- **5 greenfield sandboxes pushed to GitHub as public.** All now at `github.com/pmartin1915/extra-sub-standalone-<slug>`. Each started from a single scaffold commit. Laptop can clone them going forward.
- **Open Question 1 effectively resolved.** The "greenfield sandboxes never dispatched" problem was the starvation bug in disguise — selector was picking `sandbox-biz-app` repeatedly but those skips weren't being recorded with project fields. Post-fix, the rotation should reach all greenfields naturally.
- **Open Question 2 unchanged.** Boardbound date-sensitive vitest failures still block non-audit dispatches on that repo.

## Part 19: State check (2026-04-18 18:30 UTC / 13:30 CDT)

| Check | Result |
|---|---|
| Health | `idle` (three-state model: "no work found in 22.9h" -- alive, rotating, just skipping) |
| Last success | 2026-04-17T19:13:25Z wilderness/audit (pre-Part-18) |
| JSONL pollution canary | **10** (unchanged from Part 17) |
| Pre-commit hook | matches `scripts/hooks/pre-commit` |
| `node --check` all .mjs | clean (21 files incl. new alerting.mjs + test files) |
| Dashboard | 200 OK, 11 projects + Analytics tab + Fleet tab both live |
| Fleet files (local) | `fleet-perrypc.json` only |
| Fleet files (gist) | same -- laptop never ran the wrapper while away |
| combo auto/* | 15 (unchanged -- no successful dispatches overnight) |
| Local ahead of origin | 1 commit (`f868484`) not yet pushed |

## Part 19: The overnight starvation (what we actually saw)

47 out of 50 real dispatches in the last 24 hours hit this pattern:

```
{"ts": "2026-04-18T13:12:18.976Z",
 "outcome": "skipped",
 "reason": "no-files-to-analyze",
 "worktree": {"path": ".../auto-sandbox-biz-app-research-...",
              "branch": "auto/sandbox-biz-app-research-..."},
 "phase": "complete"}
```

Notable: **no `project` field, no `task` field at the top level** — only the worktree branch name encoded `sandbox-biz-app` and `research`.

- 47 skips of sandbox-biz-app + research
- 2 skips for user-active
- 1 selector-failed

Without project/task fields, three things broke in the selector feedback loop:
1. `getRecentOutcomes` (context.mjs:169) filters on `obj.project === slug && obj.task`. Every skip was invisible.
2. `getLastDispatchTime` (context.mjs:104) only counts success outcomes. Biz-app's `last_dispatched` stayed "never" forever.
3. The selector saw: "biz-app never attempted, 10 other projects also never attempted" — Rule 3 tiebreaker kept picking biz-app (alphabetically first or just Gemini-flash deterministic at temp=0).

## Part 19: The fix (commit f868484)

**Three files, all hot-path, gemini-2.5-pro codereviewed with zero critical/high findings.**

### scripts/dispatch.mjs:256-267

```javascript
appendLog({
  ...finalResult,
  // Always carry project/task from selection on ALL outcomes (success,
  // reverted, skipped-from-worker). verify-commit early-returns the raw
  // workResult on non-success, and worker's no-files-to-analyze skip
  // lacks these fields -- which left the selector's recent_outcomes
  // blind and caused single-project starvation (Part 19).
  project: selection.project,
  task: selection.task,
  phase: "complete",
  engine: "dispatch.mjs",
  duration_ms: Date.now() - startMs,
});
```

Spread order: `finalResult` first so its fields are preserved, then `selection.project`/`task` override if the spread lacked them. For success outcomes verify-commit already sets these same values — no conflict.

### scripts/lib/context.mjs (new helper)

```javascript
function getLastAttemptTime(slug, logPath) {
  // ... mirrors getLastDispatchTime but drops outcome==="success" requirement
  if (obj.project === slug && obj.ts) return obj.ts;
}
```

New field `last_attempted` plumbed into `buildProjectContext` return value alongside existing `last_dispatched` (success-only, kept for Rule 2).

### scripts/lib/selector.mjs buildSelectorPrompt

Project block now shows both timestamps:
```
- Last successful dispatch: 2026-04-17T19:13:25.628Z
- Last attempted (any outcome): never
```

Rule 3 updated:
```
3. Least-recently-ATTEMPTED (any outcome, not just success) -> tiebreaker.
   "never" ranks as more stale than any timestamp -- always prefer a
   never-attempted project when Rule 1/2 are tied.
```

New Rule 7b:
```
7b. Avoid tasks that were SKIPPED 3+ consecutive times with the SAME reason
    (e.g. "no-files-to-analyze") -- the outcome is deterministic and will
    keep skipping. Pick a different task for that project, or a different
    project entirely.
```

## Part 19: Self-healing expectation

Immediately after `f868484` ships:
- All projects read as `last_attempted = "never"` (pre-fix skips lack project field → invisible to the new logic).
- The selector's Rule 3 is told "never ranks more stale than any timestamp."
- Gemini-flash should rotate through the 10 never-attempted projects first (roughly 200 minutes at 20-min cadence during idle windows).
- Each rotation writes a project-tagged JSONL entry, populating `last_attempted` for that project.
- After ~11 dispatches, all projects have real `last_attempted` timestamps. Rule 3 can now tiebreak properly.
- Biz-app's starvation ends the moment it's no longer the only "never".

**Failure mode to watch:** if biz-app keeps getting picked 24h+ after the fix ships, something is wrong with the prompt interpretation. Check `status/dispatcher-runs/*.log` for the latest selector response — should show the new Rule 3 in the prompt and a `reason` field that references "never" or "least-recently-attempted".

## Part 19: Inventory of cowork inheritance (what the other session shipped)

Read these files before making related changes:

| File | Change | Hot-path? |
|---|---|---|
| `config/budget.schema.json` | NEW 146-line JSON Schema for budget.json validation | No |
| `docs/DEEP-RESEARCH-PROMPT.md` | NEW 161-line prompt spec | No |
| `package.json` | Updated dep or script | No |
| `scripts/dashboard.mjs` | +445 lines: Analytics tab, Fleet tab cross-machine view, three-state health banner | No |
| `scripts/dispatch.mjs` | +38 lines: checkAndAlert call in finally; other minor | **Yes** |
| `scripts/lib/__tests__/health.test.mjs` | NEW 143 lines vitest tests | No (tests) |
| `scripts/lib/__tests__/worker.test.mjs` | NEW 132 lines vitest tests | No (tests) |
| `scripts/lib/alerting.mjs` | NEW 123 lines: ntfy.sh push on health state transitions | **Yes** (new) |
| `scripts/lib/gates.mjs` | +3 lines | **Yes** |
| `scripts/lib/git-lock.mjs` | +5 lines | **Yes** |
| `scripts/lib/health.mjs` | +30 lines: three-state down/idle/healthy model | **Yes** |
| `scripts/lib/provider.mjs` | +34 lines: per-provider timeouts | **Yes** |
| `scripts/lib/worker.mjs` | +44 lines: audit hardening (credential stripping, DNS rebinding guard) | **Yes** |
| `scripts/open-dashboard.cmd` | NEW 6-line taskbar shortcut | No |

The **hot-path list now expands**:

`dispatch.mjs`, `worker.mjs`, `verify-commit.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`, `selector.mjs`, `context.mjs`, `run-dispatcher.ps1`, `scripts/lib/health.mjs`, `scripts/lib/fleet.mjs`, **`scripts/lib/alerting.mjs`** (new), **`scripts/lib/gates.mjs`**, **`scripts/lib/git-lock.mjs`**.

A **dedicated audit pass on the cowork changes is recommended** for a future session — +1278 lines is a lot of new surface area, and some features (ntfy alerting, credential stripping in worker) have real security implications that deserve scrutiny.

## Part 19: Greenfield sandboxes now on GitHub

Created public repos during this session:

- `github.com/pmartin1915/extra-sub-standalone-biz-app`
- `github.com/pmartin1915/extra-sub-standalone-game-adventure`
- `github.com/pmartin1915/extra-sub-standalone-dnd-game`
- `github.com/pmartin1915/extra-sub-standalone-sand-physics`
- `github.com/pmartin1915/extra-sub-standalone-worldbuilder`

Each has exactly one scaffold commit from 2026-04-16. The laptop can now clone these going forward. **Config is still local-only** (`config/budget.json` is gitignored and paths are machine-specific), so setting up the laptop to dispatch to these projects requires: (a) cloning to `c:\Users\perry\DevProjects\sandbox\extra-sub-standalone-<slug>` on the laptop, (b) copying budget.json config, (c) no further code work.

## Part 19: Open questions -- state

1. ~~**Greenfield sandboxes never dispatched.**~~ **Effectively resolved** by Part 19. The starvation bug was the cause; fix is in. Monitor for ~24h post-push to confirm rotation reaches each greenfield at least once.
2. **Boardbound date-sensitive vitest failures** — UNCHANGED. `tests-gen`/`refactor`/`fix` will still revert. Surgical fix recommended: `vi.useFakeTimers()` in boardbound repo. Out of scope for dispatcher.
3. ~~**Cross-machine status board.**~~ **SHIPPED** (Part 18 gist-side, cowork session dashboard-side).
4. **NEW: Consolidate context.mjs log I/O (MEDIUM -- future refactor).** Gemini 2.5-pro flagged during Part 19 codereview: `getLastDispatchTime`, `getLastAttemptTime`, and `getRecentOutcomes` each independently read the JSONL log. For a 10k+ entry log, this is 3× redundant I/O per selector call. Current performance is acceptable (selector runs ~once per 20 min, and log is only 762 lines), but a single-pass helper returning `{lastDispatch, lastAttempt, recentOutcomes}` would be cleaner. **Recommended for a future session, not this one.**
5. **NEW: Audit the cowork changes.** 1278 lines, some with security implications (ntfy alerting sends plaintext HTTP by default; worker audit hardening involves credential-stripping regex that could be bypassed). Pass a systematic review before extending those subsystems.

## Part 19: New canaries + checks

All Part 18 invariants still apply. Additions:

```bash
# Selector rotation is NOT stuck on one project:
tail -200 status/budget-dispatch-log.jsonl | grep -oE 'auto/[a-z-]+-[a-z-]+' | sort | uniq -c | sort -rn
# Expected: multiple projects picked. If one project dominates >80% for
# >24h post-f868484, the fix isn't working -- check selector prompt output
# in dispatcher-runs/*.log.

# Post-fix: skip entries carry project/task:
tail -5 status/budget-dispatch-log.jsonl | grep '"outcome":"skipped"' | head -1
# Expected: fields "project" and "task" present at top level (not just
# nested in worktree.branch).

# Health state is one of {healthy, idle, down}, not just healthy/down:
node -e 'console.log(JSON.parse(require("fs").readFileSync("status/health.json","utf8")).state)'
# Expected: "healthy" during normal ops, "idle" during long user-active
# windows, "down" only on real failures. If you see "down" during a
# quiet weekend, that's the old two-state output -- re-run health.mjs.
```

## Part 19: Things NOT to do

All Parts 14-18 restrictions still apply. Additions from this session:

- Do not revert the project/task attachment at `dispatch.mjs:256-267` without also reverting the corresponding `context.mjs` and `selector.mjs` changes — all three are coupled. A partial revert would re-introduce starvation OR make the selector confused by orphaned signals.
- Do not rely on `last_dispatched` alone for rotation decisions going forward. Use `last_attempted` — `last_dispatched` is kept only for Rule 2 (staleness) and dashboard display.
- Do not change Rule 3 wording without checking that "never ranks as more stale than any timestamp" is preserved — that's the key guidance the selector needs when rotating across first-time projects.
- Do not start extending the cowork features (Analytics tab, alerting, schema validation) without first reading the corresponding commits in detail. A drive-by edit without context has a high chance of breaking something.

---

# Handoff -- Part 18 (2026-04-17 21:20 UTC) -- Fleet.json gist sync shipped

> **READ THIS FIRST.** Part 18 supersedes Parts 15-17 for current state. This session shipped Open Question 3 (cross-machine fleet.json gist sync) in commit `2af0429`. Parts 15-17 below remain authoritative for invariants, failure modes, and open questions 1-2.

## Part 18: TL;DR

- **Shipped:** Per-machine `fleet-<hostname>.json` snapshot synced to the status gist on every wrapper run. Four files touched: new `scripts/lib/fleet.mjs`, ~34 lines in `scripts/run-dispatcher.ps1` finally block, `.gitignore`, plus a CRLF hardening in `scripts/lib/health.mjs`.
- **Why this, not `status.mjs`:** Part 16 flagged wiring `status.mjs` into `dispatch.mjs` as a 144-comments/day flood risk on Issue #1. The fleet.json approach is the "lighter touch" alternative it recommended — no issue noise, no gh API rate pressure, visible from any machine via `gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet-<hostname>.json`.
- **Audit discipline held.** Gemini 2.5-pro codereview returned one HIGH-flagged finding (CRLF split) that turned out to be empirically NOT a correctness bug (JSON.parse treats `\r` as whitespace per ECMA-404, and all 752 real JSON lines parse fine). I applied the `/\r?\n/` change anyway as defensive hardening — removes a latent dependency on JSON.parse's whitespace tolerance. One LOW finding (COMPUTERNAME null-guard) fixed mid-review. Severity disagreement documented here so a future instance doesn't over-react if Gemini flags the same pattern.
- **Open questions 1 and 2 remain open.** Q1 (greenfield sandboxes zero dispatches) unchanged since Part 16. Q2 (boardbound date-sensitive tests) unchanged.

## Part 18: State check (2026-04-17 21:20 UTC)

| Check | Result |
|---|---|
| Local health | `healthy (ok)`, last success 19:13Z wilderness, consecutive_errors=0, hours_since_success ~2.0h |
| JSONL pollution canary | **10** (Part 16 Bug B fix still holding) |
| Pre-commit hook | matches `scripts/hooks/pre-commit` |
| `node --check` all .mjs | clean (including new fleet.mjs) |
| Dashboard | 200 OK, 11 projects in Fleet tab |
| combo auto/* branches | 15 (unchanged from Part 17 — user-active window has been suppressing real dispatches) |
| Git log | `2af0429` on top of `bfe8e17`, NOT pushed yet |

## Part 18: What shipped (commit 2af0429)

### scripts/lib/fleet.mjs (NEW)

Mirrors the proven [scripts/lib/health.mjs](scripts/lib/health.mjs) CLI pattern. `computeFleet(logPath, machineName)` reads the JSONL log and returns two pairs of "last" fields:

- `last_run_*` (ts / outcome / engine / wrapper_duration_sec) — most recent JSONL entry, any outcome. Shows "is this machine alive, when did it last check in."
- `last_dispatch_*` (project / task / outcome / ts) — most recent entry with `outcome === "success"` AND a populated `project`. Shows "last time this machine actually committed code."

The separation matters: a machine that's been skipping user-active all day is idle, not dead. A merged single-field-set would hide that distinction.

CLI: `node scripts/lib/fleet.mjs <logPath> <outPath> [machineName]`. Hostname defaults to `os.hostname().toLowerCase()`; explicit override supported for DESKTOP-XXXX collision cases.

### scripts/run-dispatcher.ps1 (edited — hot-path)

Inserted a fleet-compute-then-gist-sync block in the `finally` at lines ~733-763, immediately after the existing health gist sync. Pattern is line-for-line parallel to the health.json flow already there since Part 15.

Key guardrails applied — each one a pattern a reviewer should check on any future hot-path edit:
- No case-collision: new locals (`$fleetScript`, `$machineName`, `$fleetFile`, `$fleetOut`) don't case-match any script-scope var. Part 16 Bug B.
- `gh gist edit $gistId -a $fleetFile`: always `-a`, never positional. Part 16 Bug A.
- Write-Log routes to per-run `.log` only. JSONL pollution canary holds at 10.
- `${LASTEXITCODE}` uses `${var}` form. Part 15 guardrail #4.
- PS1 stays pure ASCII. R-6.
- `$env:COMPUTERNAME` null-guarded — `if ($env:COMPUTERNAME) { ... } else { 'unknown' }`. Would propagate out of the finally if it threw, masking the dispatcher's real outcome and skipping mutex release.

### scripts/lib/health.mjs (edited — hot-path, defensive)

`parseLines` now splits on `/\r?\n/` instead of `"\n"`. Behavior on the current log is identical (verified: only `computed_at` and `hours_since_success` time-driven fields differ between pre- and post-fix output). See Part 18 TL;DR for the severity disagreement with Gemini.

### .gitignore (one line)

Added `status/fleet-*.json` under the runtime-state block.

## Part 18: New invariant -- fleet.json canary

Add these to the cold-start checklist:

```bash
# After the first successful wrapper run on a new machine, a fleet-<hostname>.json must appear.
ls status/fleet-*.json
# Expected: one file per machine that has run the wrapper since Part 18 shipped.

# The file must parse and have the expected shape:
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('status/fleet-$(hostname).json','utf8')), null, 2))"
# Expected keys: machine, last_run_*, last_dispatch_*, computed_at

# Cross-machine view:
gh gist view 655d02ce43b293cacdf333a301b63bbf
# Expected: health.json, budget-dispatch-last-run.json, fleet-<hostname>.json for each machine.
```

**Failure mode:** If a machine runs the wrapper (verified via updated `budget-dispatch-last-run.json` ts) but no fleet file appears, check the per-run .log for `fleet.mjs exited` or `fleet compute error` warnings. Most likely cause: COMPUTERNAME unset (guard falls back to `fleet-unknown.json`) or fleet.mjs syntax regression (pre-commit hook should have caught this).

## Part 18: Expanded hot-path list

Add `scripts/lib/fleet.mjs` to the Part 15/17 hot-path enumeration. Full list for reference:

`dispatch.mjs`, `worker.mjs`, `verify-commit.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`, `selector.mjs`, `context.mjs`, `run-dispatcher.ps1`, `scripts/lib/health.mjs`, **`scripts/lib/fleet.mjs`**.

Any change to these files MUST pass `mcp__pal__codereview` with `gemini-2.5-pro` before commit.

## Part 18: Second-machine first-run checklist

First time Part 18 code runs on a new machine (e.g. laptop, Optiplex) — verify this sequence:

1. `git pull` → must include commit `2af0429` (`feat: fleet.json per-machine gist sync + harden parseLines CRLF`).
2. Pre-commit hook install: `cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`.
3. Trigger one wrapper run (user-active window is fine — skip still writes fleet snapshot): `powershell -File scripts/run-dispatcher.ps1 -RepoRoot "$(pwd)" -Engine node`.
4. Verify local file: `ls status/fleet-*.json` — should see one file for this hostname.
5. Verify remote: `gh gist view 655d02ce43b293cacdf333a301b63bbf` should list `fleet-<thishostname>.json`.
6. Canary: `grep -c '^\[' status/budget-dispatch-log.jsonl` — MUST still be 10 (not 11+).

If step 4 produces `fleet-unknown.json`, COMPUTERNAME was unset. Investigate the environment (it's always set under Windows in practice; Task Scheduler inherits it). If step 5 fails with `unsure what file to edit`, that's Part 16 Bug A recurring — the code should use `-a`, not positional.

## Part 18: Open questions -- current state

Q3 shipped. Q1 and Q2 remain open exactly as described in [Part 16 Q1-Q2 section below](#part-16-open-questions----state-and-recommended-approach).

1. **Greenfield sandboxes still at zero auto/* branches.** User-active skips have dominated the rotation since Part 17. Recommended path per Part 16: wait 24h → trace selector → soft STATE.md bias → hard `never_dispatched_bonus`. Starting point is observation, not code.
2. **boardbound date-sensitive vitest failures** unaddressed. Audits succeed; `tests-gen`/`refactor`/`fix` will still revert. Recommended: surgical `vi.useFakeTimers()` fix in the boardbound repo, not the dispatcher.

## Part 18: Things NOT to do

All Parts 14-17 restrictions still apply. Additions from this session:

- Do not rename or relocate `scripts/lib/fleet.mjs` — `run-dispatcher.ps1` looks for it at that exact path.
- Do not change the `fleet-<hostname>.json` naming scheme without also updating the gist manually — old files would persist as orphaned entries until deleted.
- Do not write a single merged `fleet.json` across machines — the per-file race-free model is deliberate. Part 18 TL;DR explains why.
- Do not push `2af0429` to origin without Perry's say-so.

---

# Handoff -- Part 17 (2026-04-17 20:35 UTC) -- Audit checkpoint + Opus/Sonnet workflow

> **READ THIS FIRST.** Part 17 supersedes Part 16 for current state. No code changed this session. Part 17 is an audit checkpoint confirming Part 16's fixes are holding 1h+ post-ship, a refreshed `HANDOFF-PROMPT.md`, and a codified Opus/Sonnet + PAL MCP workflow. Read Part 16 below for the three open questions; read Part 15 below that for the invariant protocol and guardrails -- both still authoritative.

## Part 17: TL;DR

- **No code changes.** This session ran the Part 15 invariant audit as a fresh instance, rewrote the stale `HANDOFF-PROMPT.md` (was Part 12-era), and prepended this checkpoint.
- **Part 16 fixes are verifiably holding.** 0 new JSONL pollution since `d909901`; the gist status-file sync is working (first time since Part 15).
- **Correction to Part 16's handoff narrative:** the "4-second race" between the last polluted line and the commit was wrong. Actual commit time is `19:29:11Z`, last polluted line is `19:13:26Z` -- real margin is ~16 minutes. Conclusion (fix holding) is unchanged.
- **3 open questions unchanged.** No progress this session; Part 16's ranked recommendations still stand.

## Part 17: State check (2026-04-17 20:35 UTC)

| Check | Result |
|---|---|
| Local health | `healthy (ok)`, last success 19:13Z on `wilderness`, consecutive_errors=0, hours_since_success 1.31 |
| Gist sync | `health.json` + `budget-dispatch-last-run.json` both match local; last-run ts 20:32:16Z |
| JSONL pollution | **10** polluted lines total (Part 16 said 7 at write-time; 3 more accumulated at 12:52 / 13:12 / 13:32 / 13:52 / 14:13 local before `d909901` shipped at 14:29:11 local). All pre-fix. |
| Post-commit runs | 14:32 / 14:52 / 15:12 / 15:32 Z scheduled + ≥4 user-active skips 19:32-20:32Z -- all clean, **zero new pollution** |
| Pre-commit hook | installed, matches `scripts/hooks/pre-commit` |
| Scheduled task | `BudgetDispatcher-Node` `LastTaskResult=0`, `NextRun 15:52 local` |
| Project rotation (last 100 entries) | `combo`×2, `wilderness`×1, `shortless-ios`×1, `boardbound`×1. 5 sandboxes still at **zero** dispatches -- Open Question 1 unchanged |
| Git log | `ee46587` on top of `d909901`, both on `origin/main` |

## Part 17: New pollution canary

Add this to the cold-start checklist: `grep -c '^\[' status/budget-dispatch-log.jsonl` → **must stay 10**. Growth = regression of Part 16 Bug B (a `finally` block in `run-dispatcher.ps1` writing to the JSONL log instead of the per-run `.log`). The next instance should treat an 11th polluted line as an immediate incident, not a warning.

## Part 17: New guardrail -- Opus/Sonnet workflow + PAL MCP audit gate

The dispatcher has a 23h-outage precedent (Part 15). Hot-path regressions are high-blast-radius; plan-before-implement is non-optional for any change to the files listed in Part 15 guardrail #3 (now expanded -- see Part 16 line 99). Adopt:

- **Opus 4.7 (1M ctx)** for plan mode, audits, handoff writing, `mcp__pal__codereview` orchestration, and any change touching hot-path files. The 1M context is worth its cost when reasoning across multiple `scripts/lib/*.mjs` files at once.
- **Sonnet 4.6** for the mechanical implementation phase after `ExitPlanMode`. Faster and cheaper for straightforward edits. Switch back to Opus for the pre-commit review pass.
- **`mcp__pal__codereview` with `gemini-2.5-pro`** is the final gate before any hot-path commit. Fallback to `review_validation_type: "internal"` only when Gemini 503s. Part 15's audit found 5 real issues (secret leak, IFS shell bug, over-narrow extension whitelist, PowerShell `${var}:` interpolation, cache-miss perf) before they shipped; the gate earns its keep.
- **`mcp__pal__consensus`** is the right tool for the 3 open questions -- each is a judgment call (wait-vs-bias, surgical-vs-config, issue-comments-vs-fleet.json). Don't guess; ask 2-3 models.

Full paste-ready briefing is in `HANDOFF-PROMPT.md` (rewritten this session). See Part 16 below for open-question detail, Part 15 below that for invariants and guardrails.

## Part 17: Open questions -- no movement

All 3 remain open exactly as ranked in Part 16. No new data changes the recommendations:

1. Greenfield sandboxes still at zero auto/* branches. Selector rotation hasn't exhausted the 4 established projects yet (only 5 real dispatches total since Part 15 shipped).
2. boardbound date-sensitive vitest failures unaddressed -- audits succeed; `tests-gen`/`refactor`/`fix` will still revert.
3. Cross-machine status board not wired; `status.mjs` unused by `dispatch.mjs`.

---

# Handoff -- Part 16 (2026-04-17 19:35 UTC) -- Audit followup + open-questions brief

> Superseded by Part 17 for current state. Kept for the three open-question briefs and the failure-modes table updates -- both still authoritative.

## Part 16: TL;DR

**This session:** ran the Part 15 invariant audit, found two composing bugs in `scripts/run-dispatcher.ps1` that survived Part 15, fixed both in commit `d909901`, pushed to `origin/main`. All six invariants green post-fix. No regressions. No work done on the Part 15 open questions -- they are summarized below for the next instance.

**The two bugs (fixed, documented for pattern recognition):**
1. `scripts/run-dispatcher.ps1:710` -- positional `gh gist edit $gistId $statusFile` was violating Part 15 guardrail #8 (multi-file gist needs `-a`). Every dispatch emitted `gist sync error: unsure what file to edit`. The sister health.json call on line 723 was correct; status file had just never been updated on the gist since Part 15 shipped. Fix: add `-a`.
2. `scripts/run-dispatcher.ps1:683` -- local `$logFile` case-collided with script-scope `$LogFile` from line 87 (PowerShell variables are case-insensitive). After that line, every `Write-Log` in the `finally` block wrote `[timestamp] [warn] ...` text into `status/budget-dispatch-log.jsonl` instead of the per-run `.log`. 7 non-JSON lines accumulated; consumers (`health.mjs`, `dashboard.mjs`) already swallow parse errors so no functional break. Fix: dropped the redundant local, reused existing script-scope `$DispatcherLog` from line 88, added a 3-line comment documenting the case-insensitivity trap.

Both audited with `mcp__pal__codereview` + `gemini-2.5-pro` before commit -- no issues found.

**State check (2026-04-17 19:35 UTC):**
- Health: **healthy** (last success 19:13Z on `wilderness`, hours_since_success 0.30)
- 11 projects in rotation; `combo`, `boardbound`, `shortless-ios`, `wilderness` all had successful audit dispatches in the last hour (first time since Part 14 that the Optiplex/PC fleet was actually producing commits).
- Pre-commit hook installed and matching; `node --check` clean across 21 `.mjs`; dashboard HTTP 200; auto/* branches growing in combo (15).
- **The 5 greenfield sandboxes still have zero auto/* branches.** See open question 1.

## Part 16: Open questions -- state and recommended approach

These were Part 15's "open questions" and remain open after this session. Each block below is self-contained -- a next instance can pick any one and run.

### 1. Greenfield sandboxes have never been dispatched

**State:** 5 sandbox projects in [config/budget.json:139-172](config/budget.json#L139-L172) (`sandbox-biz-app`, `sandbox-game-adventure`, `sandbox-dnd-game`, `sandbox-sand-physics`, `sandbox-worldbuilder`). Each has `DISPATCH.md`, `ai/STATE.md`, `ROADMAP.md` (confirmed this session). None has `src/`.

**Why they could be picked:** [scripts/lib/context.mjs:52-80](scripts/lib/context.mjs#L52-L80) accepts any project with a `DISPATCH.md` (they all have one) and filters their opportunistic_tasks to drop tasks in `NEEDS_SRC` (`docs-gen`, `tests-gen`, `session-log`, `jsdoc`, `add-tests`, `refactor`, `clean`). What's left for each sandbox: `explore`, `research`, `audit`, `self-audit`, `roadmap-review` -- all valid, all in the rotation config. Also confirmed: [scripts/lib/selector.mjs](scripts/lib/selector.mjs) rule 6 explicitly says "pick explore, research, audit, self-audit, or roadmap-review" for `has_source_files: false` projects -- so the prompt does NOT exclude them.

**Why they haven't been picked yet:** Hypothesis, not verified. The selector is a Gemini call with full project STATE.md for every rotation entry. The 4 established projects (`combo`, `boardbound`, `shortless-ios`, `wilderness`) each have rich STATE.md with concrete issues that outrank "empty scaffold" under rules 1-3 (failing tests / stale status / least-recently-dispatched). Only four real dispatches have happened since the Part 15 fix shipped (combo 16:23, boardbound 17:13, shortless-ios 17:33, wilderness 19:13), so the rotation hasn't yet exhausted the "established" set.

**Recommended approach for next instance:**
1. **Do nothing for 24h first** -- the selector rule 3 (least-recently-dispatched tiebreaker) should eventually rotate to sandboxes once the 4 established slugs all have recent successes. Verify with `tail -100 status/budget-dispatch-log.jsonl | grep -o '"project":"[^"]*"' | sort | uniq -c`.
2. If still zero sandbox dispatches after 24h, capture a selector trace. Easiest method: temporarily set `SELECTOR_DEBUG=1` (no such flag exists; add one that logs the full prompt and response to `status/selector-trace.log`). Inspect the prompt -- confirm sandboxes appear in the `## Projects` block; inspect the response `reason` -- confirm sandboxes are being evaluated but losing on rule priority.
3. If the selector is starving them, soft fix: bias each sandbox's `ai/STATE.md` with a concrete "next step" (e.g., "audit the scaffold and document the first slice of scope"). That gives rule 2 something to bite on.
4. Hard fix (only if 2-3 fail): add a `never_dispatched_bonus: true` field and a selector rule "if a project has never been dispatched, prefer it over any project dispatched in the last 6h unless rule 1 applies". This is a prompt-engineering change, not a code change.

**Risk:** Low. Selector is a gated Gemini call with free-tier tokens. Experimenting doesn't cost Claude budget. But keep the audit discipline -- if you change [scripts/lib/selector.mjs](scripts/lib/selector.mjs) or [scripts/lib/context.mjs](scripts/lib/context.mjs), both are hot-path per Part 15 guardrail #3.

### 2. boardbound date-sensitive test failures

**State:** Part 15's verify-commit fix made `audit` dispatches succeed on boardbound (docs-only skip of `npm test`). But `tests-gen`, `refactor`, `fix` still run the full vitest suite ([package.json](../../boardbound/package.json) -- `"test": "vitest run"`). Two tests are known-failing due to date/time sensitivity. Any non-audit dispatch on boardbound will revert with `final-test-failure`.

**What's needed, scoped small to large:**
1. **Surgical (recommended):** `cd /c/Users/perry/DevProjects/boardbound && npm test 2>&1 | grep -A 3 -i "FAIL\|expected"` to identify the 2 tests. Patch them to mock `Date.now()` / `new Date()` via `vi.useFakeTimers(); vi.setSystemTime(...)`. One PR, no dispatcher change.
2. **Config-based:** Add `test_exclude_patterns: ["**/date-sensitive.test.ts"]` to the boardbound entry in `config/budget.json`. Teach [scripts/lib/verify-commit.mjs](scripts/lib/verify-commit.mjs) to pass `--exclude` to vitest when running in a worktree. More invasive; creates config drift between dispatcher-view and dev-view of the test suite.
3. **Two-tier test script:** Add `npm run test:dispatch` to boardbound's package.json that runs a stable subset. Have verify-commit prefer it when present. Cleanest long-term but the pattern must propagate to every project.

**Recommendation:** Option 1. Two tests, one PR, no dispatcher risk. Only fall back to 2 or 3 if the failing tests turn out to test date/time semantics as business logic (e.g., weekly-board regeneration by real wall-clock date) rather than incidental currentness.

**Risk:** Low. The fix is in the dev repo, not the dispatcher. If you break boardbound's tests, dispatches revert -- they don't corrupt anything.

### 3. Cross-machine status board (Issue #1) -- no instance uses it yet

**State:** [scripts/status.mjs](scripts/status.mjs) shipped in Part 14. Mature: `checkin`, `checkout`, `conflict`, `read`, `tasks`, `check` subcommands. Posts structured comments to `pmartin1915/claude-budget-dispatcher` issue #1. Zero code paths in `dispatch.mjs` call it today. Gap: nothing records which machine ran which dispatch.

**Naive wiring concern:** Current dispatcher cadence is every 20 min from Task Scheduler. Wiring `checkin` + `checkout` to every wrapper invocation = 144 comments/day on issue #1, most of them user-active skips. That floods the board and makes real events invisible.

**Recommended wiring:**
- Call `checkin` from [scripts/dispatch.mjs](scripts/dispatch.mjs) **only after** the user-active/budget gates pass (Phase 1/2), right before invoking the delegate. Reason: we only want a record of dispatches that actually touched code.
- Call `checkout` from the same place at end-of-phase-5 on `outcome: success` OR `outcome: reverted`. Include the project slug, task class, commit hash (or "reverted -- <reason>"), and wrapper duration.
- Do NOT call on `skipped` / user-active. That keeps the board to 5-15 comments/day matching real dispatch count.
- Spawn `status.mjs` as a child process with `spawn` + `detached: true` + `unref()` -- the dispatcher must not block on a gh API call for a status comment. Failures should log to `console.error` (goes to per-run .log, not JSONL -- remember Bug B pattern).

**Alternative (lighter touch):** Skip issue comments entirely. Write `status/fleet.json` with `{ machine, last_dispatch_ts, last_project, last_task, last_outcome }` per machine and sync it to the existing gist as a new file. Dashboard reads it on load. No issue noise, no gh rate limiting, visible on any machine via `gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet.json`. This actually aligns better with Part 15's health.json pattern.

**Recommendation:** Build the lighter-touch fleet.json sync first (4 lines of code added to the existing gist sync block in `run-dispatcher.ps1`, matching the health.json pattern). Keep `status.mjs` as the "explicit human check-in when doing cross-machine coordination" tool it was built for. Don't wire it into the dispatch loop.

**Risk:** Medium. If you spawn `status.mjs` from dispatch.mjs and it hangs, the dispatcher hangs. The detached+unref pattern mitigates but doesn't eliminate. The fleet.json alternative has zero new failure modes -- the gist sync is already in place and proven in this session.

### 4. Separate API keys per machine

**State:** [config/budget.json:87-91](config/budget.json#L87-L91) declares providers (`groq`, `openrouter`, `ollama`) with `env_key` names. Dispatcher reads from `process.env` at runtime. No code change needed to split keys -- just a different `[Environment]::SetEnvironmentVariable(...)` on each machine. Perry is planning to do this for rate-limit isolation on the Optiplex; no dispatcher-side work required.

**Action for next instance:** None unless Perry asks. If he does: confirm each machine's env vars via `Get-ChildItem env:GROQ_API_KEY, env:OPENROUTER_API_KEY, env:GEMINI_API_KEY, env:MISTRAL_API_KEY` and verify the keys are distinct per machine. No code ships.

### 5. Gist ID visible in repo

**State:** [config/budget.json:178](config/budget.json#L178) has `status_gist_id: 655d02ce43b293cacdf333a301b63bbf`. Gist is public-readable. No credentials leak, but anyone with the ID can monitor dispatch state + health.

**Action for next instance:** None unless scope grows to include sensitive data. Flagged for awareness. If you add a new file to the gist sync, confirm it contains no secrets, no API responses, no stderr (Part 15 guardrail #2).

## Part 16: What still applies from Part 15

All of the following are unchanged and still authoritative:

- **Invariant checks** (Part 15 "What the next instance MUST audit"). All 6 pass as of 19:35 UTC. Re-run them before touching code.
- **Failure modes table** (Part 15). Add two rows from this session:
  | Failure | Tell | Root cause | Fix |
  |---|---|---|---|
  | Every run logs `gist sync error: unsure what file to edit` | `tail -5 status/budget-dispatch-log.jsonl` shows `[warn] gist sync error ...` lines mixed with JSON | Positional `gh gist edit <id> <file>` on a multi-file gist | Use `gh gist edit <id> -a <file>` |
  | Non-JSON lines appearing in `budget-dispatch-log.jsonl` | `grep -c "^\[" status/budget-dispatch-log.jsonl` > 0 | A local variable in `run-dispatcher.ps1` case-collides with a script-scope `$Var` (PowerShell is case-insensitive) | Rename local, OR reuse the script-scope var; add a comment at the collision site |
- **Guardrails** (Part 15 "Be paranoid about these"). All 8 still apply. Guardrail #8 (gist `-a` flag) is now enforced on both known call sites -- any new `gh gist edit` call must follow the same pattern.
- **Ops reference** (Part 15 "Quick ops reference"). Unchanged.

## Part 16: Audit discipline -- carry this forward

The Part 15 process (implement → `mcp__pal__codereview` with `gemini-2.5-pro` → commit) caught three classes of bugs last session and zero issues in this session's review. Zero is not a waste: it's the confirmation that the fix is minimal and the surrounding code is clean. Keep the gate. Hot-path files per Part 15 guardrail #3 -- `verify-commit.mjs`, `dispatch.mjs`, `worker.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`, plus `run-dispatcher.ps1` and `selector.mjs`/`context.mjs` based on this session's findings -- always audit before commit.

---

# Handoff -- Part 15 (2026-04-17) -- Hardening session

> Superseded by Part 16 for current state and open-questions brief. Kept below for the invariant protocol, failure-modes table, and guardrails -- those are still authoritative.

## Part 15: TL;DR

**The dispatcher broke for 23+ hours and nobody noticed. Fixed in this session.**

Two independent bugs conspired:
1. **worker.mjs:532 JSDoc typo** — a literal `*/` inside a `/** ... */` block closed the outer comment early, creating a parse error that broke every dispatch for 5+ hours until discovered. (Fixed.)
2. **node_modules gitignored in worktrees** — `verify-commit.mjs` runs `npm test` in the worktree, which has no `node_modules` (gitignored). For audit tasks (docs-only output), this was pointless and caused every combo audit to revert for 18+ hours with the misleading reason "final-test-failure". (Fixed — tests now skip when all changes are docs-only.)

**Four shipped fixes** (commits `24d2e88`, `23e63c2`):
1. worker.mjs:532 JSDoc reworded to remove literal `*/`
2. Pre-commit hook now runs `node --check` on every staged `.mjs` (extends existing R-6 .ps1 ASCII check)
3. Dispatcher health signal: `scripts/lib/health.mjs` + red banner on dashboard + `health.json` synced to public Gist. Visible from any machine now.
4. `verify-commit.mjs` skips `npm test` when all changed files are docs-only (md/mdx/txt/rst). Authoritative source: `getChangedFiles(worktreePath)`. Gate logic unit-tested across 9 cases including path-traversal attempt.

**Current state (2026-04-17 17:33 UTC):**
- Health: **healthy** (`gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json`)
- Last success: 17:33 (combo, boardbound, shortless-ios all produced real commits in the last hour via `--force`-ed verification dispatches)
- `dry_run: false`, auto engine, tray running, Ollama running, 11 projects in rotation
- PC LAN IP: **192.168.1.105** (Optiplex can reach Ollama at `http://192.168.1.105:11434`)

**All four fixes were audited by `mcp__pal__codereview` with `gemini-2.5-pro` before shipping.** That process caught: a critical secret-leak vector (test stderr in the public-synced log JSON return), an IFS shell bug (empty `nl` from command substitution), an over-narrow extension whitelist (inverted to docs-only blocklist), a PowerShell variable interpolation bug (`${LASTEXITCODE}:`), and a cache-miss perf concern (fixed with 60s TTL matching the existing pattern).

## Part 15: What the next instance MUST audit

Before touching any code, verify these invariants are still holding:

1. **Health is being computed and synced.** `node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json` should print `health: healthy (ok)` (or report the specific reason for "down"). Then `gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json` should match.
2. **Pre-commit hook is installed.** `ls -la .git/hooks/pre-commit` should exist and match `scripts/hooks/pre-commit` in content. If not: `cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`. On fresh clones this needs to happen manually.
3. **`node --check scripts/**/*.mjs` passes.** Any syntax error here means the dispatcher will fail every run until fixed.
4. **Fleet tab loads.** `http://localhost:7380` → Fleet tab → verify the 11 projects render with phase cells.
5. **Last dispatch was real.** Check `status/budget-dispatch-last-run.json` timestamp. If it's stale (>1h when PC is in use, >4h when idle-eligible), something's wrong.
6. **Auto branches are accumulating real commits.** `cd /c/Users/perry/DevProjects/combo && git branch --list 'auto/*' | wc -l` should grow over time. New entries should have commits on them (diff vs main non-empty), not be empty branches.

## Part 15: Failure modes and their tells

These are the ways the dispatcher has actually broken in production. The next instance should recognize them fast.

| Failure | Tell | Root cause | Fix |
|---|---|---|---|
| Every dispatch fails immediately with exit 1 | `SyntaxError` in dispatch logs, 15+ consecutive errors | Syntax error in any .mjs file imported by `dispatch.mjs` | Pre-commit hook now blocks this. On legacy breakage: `node --check scripts/dispatch.mjs` to find the offending file, fix syntax. |
| Every dispatch reverts with `final-test-failure` | Worktrees created but `git diff main..auto/*` is empty | Worktree has no `node_modules`, `npm test` fails | Fixed in verify-commit.mjs. If it recurs, check that the skip logic is still gating on docs-only. |
| Dispatcher "works" but no commits appear | Log shows wrapper-success but no `outcome: success` entries | Something past phase 5 is silently eating results | Read recent entries in `status/dispatcher-runs/*.log` for the last "phase 5" run |
| Dashboard shows "healthy" but nothing's happening | Health is based on LAST success, not absence of runs | If dispatcher can't even START (e.g., Task Scheduler disabled), no events hit the log | Check `Get-ScheduledTask BudgetDispatcher-Node` state via tray or powershell |
| PS1 wrapper fails silently | `status/budget-dispatch-last-run.json` stale | Non-ASCII characters in a .ps1 file (R-6) OR invalid PowerShell variable interpolation (`$var:something` reads as drive scope) | Pre-commit hook R-6 catches non-ASCII. For interpolation: always use `${var}` when followed by `:` |
| Reverts mask the real cause | JSONL log shows "final-test-failure" for everything | stderr from npm test was being discarded | Now `console.error`'d in verify-commit.mjs, goes to `status/dispatcher-runs/*.log`. Grep there first. |

## Part 15: Guardrails -- be paranoid about these

1. **Never run `rm -rf /c/Users/perry/DevProjects/auto-*`** without first confirming the dispatcher isn't currently running (it uses those paths for live worktrees). Check `Get-ScheduledTaskInfo BudgetDispatcher-Node` State first.
2. **Never add `test_stderr` or `stdout` to the JSON returned from `verifyAndCommit`.** It flows through `log.mjs` into `budget-dispatch-log.jsonl`, which (though currently gitignored) has precedent for being synced. Test output can contain API keys, paths, PII. Log via `console.error` instead — it goes to `status/dispatcher-runs/*.log` which is local-only.
3. **Be careful modifying `verify-commit.mjs`, `dispatch.mjs`, `worker.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`.** These are hot-path files. A syntax error or semantic regression takes the whole system down. The pre-commit hook catches syntax but NOT semantics. Always audit with `mcp__pal__codereview` before committing changes to these files.
4. **PowerShell + `:` after a variable name** is a drive-scope reference unless you use `${var}:`. Common bug in `run-dispatcher.ps1`.
5. **Shell `$(printf '\n')` returns empty** because command substitution strips trailing newlines. For a literal newline in POSIX sh, use a quoted literal:  
   ```sh
   nl='
   '
   ```
6. **`/* */` inside a `/** ... */` JSDoc block** is always a parse error. The middle `*/` closes the outer comment. Use "line or block comments" in prose instead.
7. **Worktrees don't share `node_modules`.** Anything that runs `npm test` or similar in a worktree needs either: a skip condition (current solution), or a bootstrap step (junction to main, or `npm ci`). Don't quietly add another such command without thinking about this.
8. **Gist sync is idempotent via `gh gist edit -a <file>`.** Do NOT use positional `gh gist edit <id> <file>` — when the gist has multiple files, it errors with "unsure what file to edit".

## Part 15: Open questions for the next instance

- **Greenfield projects still haven't been dispatched.** 5 sandboxes (biz-app, game-adventure, dnd-game, sand-physics, worldbuilder) were scaffolded in Part 13 but none have had a successful dispatch yet. With the verify-commit fix, they should start getting picked up — but only once the selector rotates to them. Monitor overnight to confirm.
- **boardbound's 2 date-sensitive test failures.** Now that `npm test` is correctly gated, audits on boardbound succeed. But `tests-gen`, `refactor`, `fix` still run the full suite, which will fail. Separate fix needed: either repair the tests or filter them out of the suite that runs during verify.
- **Secret gist URL is in the repo.** `config/budget.json` has `status_gist_id: 655d02ce43b293cacdf333a301b63bbf`. The gist is public-readable (no secret), but anyone with the ID can see dispatch state and (future) health info. Not a credential leak, but worth noting if you grow to include more sensitive data.
- **Separate API keys per machine.** Perry plans to use distinct Gemini/Mistral/Groq keys on the Optiplex for rate-limit isolation and blast-radius containment. The dispatcher reads from environment variables; no code change needed, just a different `[Environment]::SetEnvironmentVariable(...)` on each machine.
- **Cross-machine status board (Issue #1).** `scripts/status.mjs` was shipped in Part 14 (laptop) but no instance has actually used it yet. Next instance should consider wiring check-in/check-out into dispatch.mjs startup so we have a record of which machine ran which dispatch.

## Part 15: Quick ops reference

```bash
# Force a dispatch to test changes
node scripts/dispatch.mjs --force --dry-run    # inspect, no commit
node scripts/dispatch.mjs --force              # real dispatch

# Check health
node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json

# View remote health from any machine
gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json

# Restart dashboard
powershell -Command "Get-NetTCPConnection -LocalPort 7380 -State Listen | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }; Start-Sleep 1; Start-Process node -ArgumentList 'scripts/dashboard.mjs' -WorkingDirectory 'c:\Users\perry\DevProjects\claude-budget-dispatcher' -WindowStyle Hidden"

# Install pre-commit hook (first-time setup on new clones)
cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

---

# Handoff -- Laptop Claude instance (Part 14 -- 2026-04-16) -- superseded by Part 15

> Historical. Part 15 supersedes this section; read it first. Kept below for continuity.

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

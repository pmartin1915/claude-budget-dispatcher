# Handoff — Resume budget-dispatcher on Perry PC (2026-04-21)

**Audience:** The next Claude Code session running on perrypc.
**Previous operator:** Claude Opus 4.7 (PC), coordinating with Opus 4.6 (laptop).
**Last activity:** 2026-04-21 late morning / afternoon UTC.

---

## 1. Pull first

```powershell
cd C:\Users\perry\DevProjects\claude-budget-dispatcher
git pull origin main
```

You should land at or past commit `f280468` (structural task-class diversity enforcement). Verify:

```powershell
npm test          # 114/114 pass
node --check scripts/lib/selector.mjs scripts/lib/context.mjs
```

---

## 2. What's on main (most recent first)

| Commit | What |
|---|---|
| `e20d725` | Dashboard: PWA manifest + desktop-pinning scripts (laptop) |
| `f280468` | **Selector task-class diversity enforcement** — 3-layer fix for the "9 proposals in a row" problem (laptop) |
| `8a3f0c0` | **Repo rename** — `claude-budget-dispatcher` → `budget-dispatcher` (laptop) |
| `a96053a` | Fleet dashboard HTML for GitHub Pages (laptop) |
| `0ba2f30` | **Shared config fixes**: `auto_pr: true` fleet-wide + `selector_max_tokens: 2000` (PC — fixed issues surfaced by neighbor smoke test) |
| `660192b` | 23 unit tests for value ledger + merge tracker (laptop) |
| `12ed84b` | Merge-rate feedback wired into selector prompt (laptop) |
| `2f693cf` | Merge tracker: `scripts/track-merges.mjs` + `npm run track-merges` (laptop) |
| `eef9682` | Value ledger: `lines_added`/`lines_removed` captured in JSONL (laptop) |
| `9124f32` | **Quota bump 8 → 20** + inject real date into worker prompts (PC) |
| `79517c8` | **Selector cooldown filter** — prevents back-to-back same-project picks (PC) |

### What the three-layer diversity fix does (`f280468`)

1. **Task-class cooldown (structural):** if a task class was used 2+ times in the last 8 dispatches, those tasks are REMOVED from the allowed list BEFORE the LLM sees them. Configurable via `task_class_repeat_limit` in shared.json.
2. **Diversity hint in prompt:** recent dispatches shown as "do NOT repeat" list.
3. **Post-selection warning:** logs if LLM picks a repeat anyway.

This stacks with the **project-level cooldown** (`79517c8`, 20-min per-project) for defense in depth. The project cooldown stops a single project from being re-picked; the task-class cooldown stops a single *task type* (proposal, self-audit, etc.) from dominating across projects.

---

## 3. Verify operational

```powershell
# Dry-run. Should log task-class cooldown messages if recent dispatches exist.
# Should NOT pick "proposal" if proposal was used 2+ times in last 8 cycles.
node scripts\dispatch.mjs --force --dry-run

# Fleet gist (all three machines in one shot)
gh gist view 655d02ce43b293cacdf333a301b63bbf

# Scheduled task
Get-ScheduledTask -TaskName 'BudgetDispatcher-Node' | Select-Object TaskName, State
```

Expected healthy baseline:
- `health.json`: `state: healthy` or `idle` (both are normal; idle = no successes in N hours but no errors either)
- `consecutive_errors: 0` on perrypc's fleet entry
- Scheduled task: `Ready`

---

## 4. Current fleet state (snapshot at handoff write)

| Machine | Fleet entry age | consecutive_errors | State |
|---|---|---|---|
| **perrypc** | Fresh (recent) | 0 | Healthy. PC is at ~19/20 daily quota; 1 slot left before reset at 2pm CT Thursday |
| **desktop-tojgbg2** | 2.5h stale | 2 (STALE — yesterday's env errors) | Working. Neighbor's 07:28 manual `--force` produced a verified branch on origin (`auto/sandbox-biz-app-audit-20260421072855`). Fleet entry will refresh on the next scheduled success. |
| **perryslenovo** | 3 days stale | n/a | Not dispatching. Currently in dev session (writing the dashboard and task-class diversity code). Expected to stay stale until it resumes scheduled cycles. |

**Overall health:** HEALTHY. System is working. The stale fleet entries are information lag, not brokenness.

---

## 5. Open PRs (dispatcher auto-opened, awaiting Perry review)

| PR | Recommendation |
|---|---|
| [worldbuilder #1](https://github.com/pmartin1915/extra-sub-standalone-worldbuilder/pull/1) — research | **MERGE** — Actionable: proposes JSON schemas, STYLE_GUIDE.md, test strategy, breakdown of STATE.md into atomic tasks. Real scaffolding research for a greenfield project. |
| [workflow-enhancement #8](https://github.com/pmartin1915/extra-sub-standalone-workflow-enhancement/pull/8) — explore | **UP TO YOU** — Well-written architectural summary of the dispatcher. Duplicates existing docs. Merge as a "Gemini-eye-view" artifact or close as noise. |

14 duplicate PRs from the pre-cooldown selector fixation were already closed this morning (+ branches deleted). The `merge-tracker.json` records those closed-unmerged outcomes, so the selector will learn to downweight those task classes.

---

## 6. Optional: add real projects to rotation

This is the single biggest diversity unlock. Without real projects, the rotation is sandbox-heavy and Gemini produces meta-analyses of scaffolds. Adding real projects with `test` and `typecheck` tasks gives it concrete pass/fail signals.

Edit `config/local.json` (gitignored, per-machine) — add these entries to `projects_in_rotation`:

```json
{
  "slug": "burn-wizard",
  "path": "C:/Users/perry/DevProjects/burn-wizard",
  "clinical_gate": true,
  "opportunistic_tasks": ["test", "typecheck", "audit"]
},
{
  "slug": "wilderness",
  "path": "C:/Users/perry/DevProjects/wilderness",
  "clinical_gate": false,
  "opportunistic_tasks": ["test", "typecheck", "audit"]
},
{
  "slug": "boardbound",
  "path": "C:/Users/perry/DevProjects/BoardBound/boardbound",
  "clinical_gate": false,
  "opportunistic_tasks": ["test", "typecheck", "audit"]
}
```

Then:
```powershell
node scripts\migrate-to-layered-config.mjs
```

---

## 7. What happened overnight that shaped today's fixes

**The selector fixation incident (2026-04-21 00:33 → 06:33 UTC):**
The selector LLM (Gemini 2.5 Flash, later switched to 2.5 Pro) picked `sandbox-workflow-enhancement` 18 cycles in a row, generating near-duplicate PRs (7 proposals, 6 roadmap-reviews, 5 self-audits). Root cause: workflow-enhancement was the only rotation project with a content-rich `ai/ROADMAP.md` (G1-G10 goals + accepted proposals). The LLM preferred content-rich state and fabricated Rule-2-flavored justifications ("oldest last successful dispatch") while actually picking the most-recent project.

**Two-layer fix (in order):**
1. `79517c8` — **project-level 20-min cooldown** at the selector's pre-LLM filter stage. Prevents picking the same project twice in a row.
2. `f280468` — **task-class 8-cycle cooldown**. Stops the LLM from cycling through all N task types on different projects in sequence (selector can still pick three different projects, but if all three get "proposal", the fourth pick won't have "proposal" available).

**Other lessons:**
- **Gemini hallucinates dates.** PR #1 claimed "Analysis Date: 2026-04-14" (a week before generation) and worldbuilder #1 said "Report Date: 2024-10-27" (18 months ago). Fixed in `9124f32` by injecting `Today's date is YYYY-MM-DD (UTC)` at the top of every worker prompt.
- **`max_runs_per_day: 8` was too tight.** Yesterday's burst hit 18 successes in one night. Bumped to 20 in shared.json.
- **`selector_max_tokens: 500` was broken with `selector_model: gemini-2.5-pro`.** Reasoning tokens consumed the budget before JSON emitted. Neighbor surfaced this. Bumped to 2000.
- **`auto_pr` was per-machine, should be fleet-wide.** Neighbor's first successful dispatch pushed a branch but didn't open a PR. Fixed to fleet-wide in `0ba2f30`.
- **Dispatcher output accumulates new files instead of updating canonical docs.** Every `self-audit` on workflow-enhancement created a new `audit-findings-<ts>.md` rather than updating an `ai/STATE.md`. Consider a prompt change to prefer in-place updates. Laptop hasn't tackled this yet.

---

## 8. Repo rename status

- GitHub renamed to `budget-dispatcher` ✓
- PC's remote updated to new URL ✓
- Laptop + neighbor: **unknown** — they may still be on old URL via GitHub's redirect. Not urgent; push would eventually fail once redirects expire. To update from those machines:
  ```powershell
  git remote set-url origin https://github.com/pmartin1915/budget-dispatcher.git
  ```
- **Local directory still named `claude-budget-dispatcher`** on all three machines. Renaming requires re-registering the scheduled task's `-RepoRoot`. Low urgency; cosmetic.

---

## 9. DO NOT

- **Don't push without Perry saying "go" or "push".** He does pushes unless explicitly delegated in-session.
- **Don't change `shared.json` unilaterally.** It propagates to laptop + neighbor. Any edit is a fleet-wide config change and deserves explicit confirmation.
- **Don't add write-capable tasks (`clean`, `refactor`, `docs-gen`, `tests-gen`, `slot_fill`) to clinical projects.** `burn-wizard` has `clinical_gate: true` for a reason — the gate blocks writes to `domain/`, and adding write tasks defeats the purpose.
- **Don't touch `worldbuilder`.** The real `c:/Users/perry/DevProjects/worldbuilder` is under active hand-authoring (ecology/religion). NOT in rotation. Don't add it. `sandbox-worldbuilder` at a different path is the safe scaffold that IS in rotation — don't confuse them.
- **Don't use `gemini-3-pro-preview`.** In `free_model_roster.forbidden_models` for a reason (cost + quality regressions noted pre-session).
- **Don't rename the local directory** without also re-registering the scheduled task. Breaks cycles silently.
- **Don't interfere with laptop's work on the dashboard and diversity fixes.** Laptop is iterating there; stepping on those files risks merge conflicts with the next laptop push.

---

## 10. Small open items (not blocking)

1. **Scaffold-docs prompt tuning** — make Gemini UPDATE `ROADMAP.md` checkboxes in place instead of creating new `dispatch-<ts>.md` files each cycle. Would reduce PR noise dramatically but requires worker.mjs prompt changes. Laptop candidate for next session.
2. **Selector `reason` persistence** — the selector LLM's reasoning shows up in stdout but not in the final JSONL log entry. Threading it through `verifyAndCommit` would make morning incident diagnosis (like today's) one grep instead of multiple log file scans.
3. **Neighbor fleet entry is stale.** Will self-resolve when neighbor next fires a successful scheduled dispatch. Can be forced with a manual `node scripts/dispatch.mjs --force` on neighbor if you want a fresh entry immediately.
4. **3 archived log files untracked** (`status/budget-dispatch-log-archive-2026-04-{12,13,14}.jsonl`). Either commit them, delete them, or .gitignore. Harmless but clutters `git status`.

---

## 11. Memory

Session memory lives at `~/.claude/projects/c--Users-perry-DevProjects-claude-budget-dispatcher/memory/`. Relevant entries:
- Worldbuilder protected from dispatcher (do not re-enable without explicit approval)
- ntfy alerting live — do not re-prompt to set it up
- User sometimes runs two CC sessions in parallel (PC + laptop/Cowork) — branch-switches and concurrent pushes are expected; coordinate via `git pull --rebase`
- User prefers streamlined/intuitive setups over maximum coverage

Read `MEMORY.md` in that dir for the index.

---

**Bottom line for the next operator:** System is healthy, fleet is coordinated, and the two incidents from the last 24h (selector fixation, ntfy em-dash, neighbor env vars, shared.json gaps) all have landed fixes. Your job is to pick a next improvement from §10 or respond to whatever Perry asks. Don't panic about the stale fleet entries — they're information lag.

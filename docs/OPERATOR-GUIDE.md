# Operator Guide

Complete reference for installing, configuring, tuning, and troubleshooting budget-dispatcher.

---

## Theory of operation

Every 20 minutes, your scheduler runs `scripts/estimate-usage.mjs`. This Node script:

1. Walks `~/.claude/projects/**/*.jsonl` (Claude Code transcripts).
2. For each line containing a `"usage"` field, parses out `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
3. Applies weights from `config/budget.json` to compute a weighted cost per entry.
4. Buckets entries into **monthly** (since 1st of current month) and **weekly** (trailing 7 days).
5. Computes trailing-30-day cost as a **baseline** for pace comparison.
6. Checks both monthly and weekly gates — each has its own `trigger_headroom_pct` and `reserve_floor_pct`.
7. Writes `status/usage-estimate.json` with `dispatch_authorized: true|false` and a `skip_reason`.

The **dispatcher prompt** (`tasks/budget-dispatch.md`) is a separate Claude task scheduled on the same 20-min cron. It runs the estimator again (idempotent), reads the snapshot, and either:
- **Skips immediately** (gate red) → costs ~100 tokens, a single file read.
- **Dispatches work** (gate green) → picks project, picks task, spawns bounded subagent.

The **two-layer design** ensures the no-op path is essentially free. If your gate is red (as it will be most days), the dispatcher exits after reading one JSON file.

---

## Budget model math

Let:
- `T` = `monthly.target_burn_pct_per_day` (e.g., 2.5)
- `W[k]` = weight for token type `k`
- `c(m, p)` = cumulative cost in period `p` summed over all message usages `m` in that period:
  `c(p) = Σ_m (input_m × W_input + output_m × W_output + cache_create_m × W_cc + cache_read_m × W_cr)`

**Bootstrap** (converts weighted cost to percent of budget):
```
trailing30 = c(last 30 days)
cost_per_pct_point = trailing30 / (30 × T)
```
This anchors the scale: if your trailing 30 days totals X weighted units and your target is 2.5%/day (= 75% over 30 days), then `cost_per_pct_point = X / 75`.

**Monthly pace:**
```
monthly_actual_pct = c(since 1st of month) / cost_per_pct_point
days_elapsed = (now - month_start) / 86400_000
monthly_expected_pct = (days_elapsed / days_in_month) × 100
monthly_headroom = monthly_expected_pct - monthly_actual_pct
```

**Weekly pace:**
```
weekly_budget_cost = 7 × T × cost_per_pct_point
weekly_actual_pct = (c(last 7 days) / weekly_budget_cost) × 100
weekly_expected_pct = 100  (by definition, since weekly is a rolling target)
weekly_headroom = 100 - weekly_actual_pct
```

**Gate decision:**
```
monthly_reserve_ok = (monthly_actual_pct + max_opportunistic_pct_per_run) <= (100 - monthly.reserve_floor_pct)
monthly_gate = monthly_reserve_ok AND monthly_headroom >= monthly.trigger_headroom_pct

weekly_reserve_ok = (weekly_actual_pct + max_opportunistic_pct_per_run) <= (100 - weekly.reserve_floor_pct)
weekly_gate = weekly_reserve_ok AND weekly_headroom >= weekly.trigger_headroom_pct

dispatch_authorized = monthly_gate AND weekly_gate AND !paused
```

**Why anchor to trailing-30?** There's no Anthropic API for "how much of your Max quota is left this month." The only signal we have is *your own past behavior*. By treating trailing-30 as "normal," the tool is robust to whatever your actual Max tier is (Max 5x, Max 20x, etc.) — it detects *your* pace changes, not absolute quota.

**Why weekly as floor?** A single low-usage week isn't enough to unlock dispatch if the month is already heavy. But a heavy week blocks dispatch even if the month is light. This is asymmetric on purpose: it biases toward *conserving* headroom for the user's real work.

---

## Configuration reference (`config/budget.json`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paused` | bool | false | Hard halt. No dispatcher will run. |
| `dry_run` | bool | true | Dispatcher logs decisions but never creates branches. |
| `monthly.resets_on_day` | int | 1 | Day of month the billing period resets. |
| `monthly.target_burn_pct_per_day` | float | 2.5 | Your target daily burn as % of monthly budget. |
| `monthly.reserve_floor_pct` | int | 15 | Minimum monthly headroom always reserved for the user. |
| `monthly.trigger_headroom_pct` | int | 5 | Minimum below-pace delta required to trigger dispatch. |
| `weekly.rolling_days` | int | 7 | Rolling window size for the weekly gate. |
| `weekly.reserve_floor_pct` | int | 20 | Minimum weekly headroom reserved. |
| `weekly.trigger_headroom_pct` | int | 5 | Same as monthly trigger, applied to weekly headroom. |
| `weekly.is_floor` | bool | true | Documentation flag — logic always AND-gates both periods. |
| `max_opportunistic_pct_per_run` | float | 1.0 | Estimated budget impact of a single dispatched run (used for reserve math). |
| `max_runs_per_day` | int | 8 | Hard cap on non-skipped runs per UTC day. |
| `activity_gate.idle_minutes_required` | int | 20 | Minimum idle minutes (no transcript writes) before dispatching. |
| `activity_gate.no_fixed_hours` | bool | true | If true, ignore hours entirely — activity gate is the only time-based check. |
| `estimator` | string | "transcripts" | Source of usage data. Only "transcripts" implemented today. |
| `token_weights.input_tokens` | float | 1.0 | Weight for input tokens in cost math. |
| `token_weights.output_tokens` | float | 5.0 | Weight for output tokens. Output is the expensive side. |
| `token_weights.cache_creation_input_tokens` | float | 1.25 | Weight for cache creation (priced 25% premium by Anthropic). |
| `token_weights.cache_read_input_tokens` | float | 0.1 | Weight for cache reads (priced at 10% of input). |
| `projects_in_rotation[].slug` | string | — | Short name for the project (used in log/branch names). |
| `projects_in_rotation[].path` | string | — | Absolute path to the project's repo root. |
| `projects_in_rotation[].clinical_gate` | bool | false | If true, triggers `pal codereview` on any domain/ touch. |
| `projects_in_rotation[].opportunistic_tasks` | string[] | — | Allowlisted task keywords from the project's DISPATCH.md. |
| `commit_policy` | string | "local-auto-branch-only" | Enforcement marker — hardcoded in dispatcher prompt. |
| `branch_prefix` | string | "auto/" | Prefix for dispatched branches. |

---

## Per-project DISPATCH.md requirements

Each project in `projects_in_rotation` must have a `DISPATCH.md` file at its repo root with **at minimum**:

```markdown
## Pre-Approved Tasks (No Confirmation Needed)

| Task Keyword | Command | Success Criteria |
|---|---|---|
| test | <your test command> | <pass criteria> |
| typecheck | <your typecheck command> | <pass criteria> |

## Requires Confirmation (Never Auto-Execute)

- deploy
- publish
- delete
- <project-specific destructive tasks>
```

**The dispatcher will only run keywords that appear in BOTH:**
1. The project's `## Pre-Approved Tasks` table
2. `projects_in_rotation[].opportunistic_tasks` in `budget.json`

This gives you two layers of control: project-level (DISPATCH.md) and dispatcher-level (budget.json).

### Recommended Opportunistic Lane section

Add this to each project's DISPATCH.md:

```markdown
## Opportunistic Lane (Budget Dispatcher)

The budget-dispatcher may run the following pre-approved tasks
autonomously when the user is away and budget headroom exists.

**Eligible:** test, typecheck, audit, clean

**Explicitly excluded from autonomous execution:**
- deps — version bumps need human verification
- <other project-specific exclusions>

**Commit trail:** Opportunistic commits carry prefix `[opportunistic]` and
live on auto/<slug>-<task>-<date> branches that never merge to main or push
to origin.
```

---

## Scheduling

### Windows (Task Scheduler via Claude Code Desktop)

1. Open Claude Code Desktop → Schedule
2. Click `+ New Task`
3. Name: `budget-dispatch`
4. Cron: `*/20 * * * *` (every 20 min)
5. Working directory: `<REPO_ROOT>` (your cloned dispatcher)
6. Paste the entire prompt from `tasks/budget-dispatch.md` into the task body
7. Save

### macOS (launchd)

Write a plist at `~/Library/LaunchAgents/com.pmartin1915.budget-dispatcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pmartin1915.budget-dispatcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd /path/to/budget-dispatcher &amp;&amp; node scripts/estimate-usage.mjs &amp;&amp; claude -p "$(cat tasks/budget-dispatch.md)"</string>
    </array>
    <key>StartInterval</key>
    <integer>1200</integer>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/com.pmartin1915.budget-dispatcher.plist`

### Linux (systemd timer)

Create `~/.config/systemd/user/budget-dispatcher.service`:

```ini
[Unit]
Description=Claude Budget Dispatcher

[Service]
Type=oneshot
WorkingDirectory=%h/budget-dispatcher
ExecStart=/usr/bin/env node scripts/estimate-usage.mjs
ExecStart=/usr/bin/env claude -p @tasks/budget-dispatch.md
```

And `~/.config/systemd/user/budget-dispatcher.timer`:

```ini
[Unit]
Description=Run Claude Budget Dispatcher every 20 min

[Timer]
OnBootSec=5min
OnUnitActiveSec=20min

[Install]
WantedBy=timers.target
```

Enable: `systemctl --user enable --now budget-dispatcher.timer`

---

## Troubleshooting

### Estimator reports wildly wrong numbers

- Check `bootstrap.cost_per_pct_point` in the snapshot. If it's absurdly high or low, your trailing-30-day window may include outlier sessions (e.g., a single giant context compaction).
- Delete corrupt transcripts from `~/.claude/projects/*/` (risk: loses history for those sessions).

### `dispatch_authorized` is always false

Look at `skip_reason`:
- `monthly-reserve-floor-threatened` — you've already used >85% of target. Expected at end of heavy months.
- `weekly-reserve-floor-threatened` — recent heavy usage. Will clear as the rolling window advances.
- `monthly-headroom-below-trigger` — you're running almost exactly at pace. No headroom.
- `weekly-headroom-below-trigger` — same, but for the weekly window.
- `paused` — PAUSED file exists or `paused: true` in config.
- `user-active` — recent transcript write detected. Wait out the idle window.

### `auto/*` branches piling up

The dispatcher never cleans them up — that's your job during review. Periodically:

```bash
cd <YOUR_PROJECT>
git worktree list | grep auto-
# Remove worktrees older than 7 days (adapt the find command for your platform)
```

---

## Reviewing opportunistic branches

```bash
cd <YOUR_PROJECT>
git branch --list "auto/*"
git log --oneline --grep=opportunistic
git diff main..auto/<slug>-<task>-<date>

# If good:
git merge auto/<slug>-<task>-<date>
# Or cherry-pick specific commits:
git cherry-pick <hash>

# Cleanup:
git worktree remove ../auto-<slug>-<task>-<date>
git branch -D auto/<slug>-<task>-<date>
```

All opportunistic commits carry the `[opportunistic]` prefix in their message.

---

## Kill switches

| Speed | Action | Effect |
|---|---|---|
| Instant | `touch <REPO_ROOT>/config/PAUSED` | Estimator sees the file and immediately sets dispatch_authorized: false |
| Persistent | Set `"paused": true` in `config/budget.json` | Same effect, persists across restarts |
| Full disable | Remove the scheduled task | Dispatcher never runs at all |
| Nuclear | Delete `config/budget.json` | Estimator fails closed (exit code 2) |

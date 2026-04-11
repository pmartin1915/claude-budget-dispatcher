# claude-budget-dispatcher

> Turn unused Claude Max quota into bounded, safe, autonomous self-improvement work on your projects — while you sleep, study, or work on something else.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## The problem

If you have a Claude Max subscription, you're paying for a monthly/weekly compute budget. If you don't consume it all — during a light work week, during an exam, during a vacation — that budget resets to zero and the money is gone.

With Claude Code now supporting Cowork, Scheduled Tasks, and non-interactive sessions, Claude can productively work on your projects while you're away. The only thing missing is a **budget-aware gate** that:

1. Estimates how much of your monthly budget you've consumed
2. Compares it to your expected pace
3. Detects when you're *below* pace (i.e., have headroom)
4. Only then dispatches bounded, reversible, safe work
5. Hard-stops when your reserve floor is threatened

This repo is that gate.

---

## Design principles

1. **User comes first.** The dispatcher always leaves a configurable reserve floor (default 15% monthly / 20% weekly) for your own sessions. Your interactive work is never slowed or throttled.
2. **Bounded tasks only.** The dispatcher only runs pre-approved, idempotent tasks you've explicitly allowlisted (e.g., `test`, `typecheck`, `audit`, `clean`). Nothing experimental, nothing destructive.
3. **Never touch `main`.** All opportunistic work happens on `auto/<slug>-<task>-<date>` branches or git worktrees. **Never pushes. Never merges.** You review and merge manually.
4. **Fail closed.** Missing config → skip. Estimator error → skip. Test regression → revert branch. Ambiguity → skip. The dispatcher is biased toward doing nothing.
5. **Observable.** Every decision (run OR skip) is logged to a JSONL file you can grep and audit.
6. **Zero Claude cost for the no-op path.** The estimator is a plain Node script — it runs on a cron, decides "not authorized", and exits without ever invoking Claude.

---

## How it works

```
┌──────────────────────────────────────────────────────────┐
│  Windows Task Scheduler (or cron) — every 20 min         │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  scripts/estimate-usage.mjs  (plain Node, no Claude cost)│
│  • Scans ~/.claude/projects/**/*.jsonl                   │
│  • Parses Anthropic usage fields                         │
│    (input_tokens, output_tokens, cache_*)                │
│  • Sums weighted cost into monthly + weekly buckets      │
│  • Compares to pace targets                              │
│  • Writes status/usage-estimate.json with gate decision  │
└──────────────────────────────────────────────────────────┘
                       │
           dispatch_authorized?
                       │
          ┌────────────┴────────────┐
          NO                        YES
          │                         │
          ▼                         ▼
      exit 0              ┌──────────────────────┐
      (free)              │ tasks/budget-        │
                          │ dispatch.md          │
                          │ (Claude prompt)      │
                          │ • activity gate      │
                          │ • daily quota        │
                          │ • project pick       │
                          │ • task pick          │
                          │ • worktree + bounded │
                          │   subagent           │
                          │ • verify + audit     │
                          │ • local commit       │
                          │ • log                │
                          └──────────────────────┘
```

Because the **estimator** and the **dispatcher prompt** are decoupled, the expensive Claude invocation only happens when the gate is already green. The no-op path is pure Node.

---

## Installation

### Prerequisites

- **Claude Max subscription** with Claude Code installed (`claude` in PATH or Claude Code Desktop)
- **Node.js 18+** for the estimator script
- **Git** for worktree isolation
- **A task scheduler**: Windows Task Scheduler (built-in), `cron` on macOS/Linux, or Claude Code Desktop's Schedule UI

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/pmartin1915/claude-budget-dispatcher.git
cd claude-budget-dispatcher

# 2. Copy the example config and edit it
cp config/budget.example.json config/budget.json
$EDITOR config/budget.json
#   - Set projects_in_rotation with YOUR project paths
#   - Set opportunistic_tasks per project (must match DISPATCH.md keywords)
#   - Adjust thresholds if desired

# 3. Ensure each rotation project has a DISPATCH.md
# See docs/OPERATOR-GUIDE.md § "Per-project DISPATCH.md requirements"

# 4. Smoke test the estimator
node scripts/estimate-usage.mjs
cat status/usage-estimate.json
#   - Verify it parses your Claude transcripts correctly
#   - Should report actual_pct, headroom_pct, gate_passes, skip_reason

# 5. Register the dispatcher task with your scheduler
# See docs/OPERATOR-GUIDE.md § "Scheduling"

# 6. LEAVE dry_run: true in budget.json for the first 3–5 days
# Watch status/budget-dispatch-log.jsonl accumulate decisions.
# Validate that project/task picks look sane before going live.
```

---

## Kill switches

Any ONE of these halts the dispatcher immediately:

| Speed | Action |
|---|---|
| Fastest | `touch config/PAUSED` (empty sentinel file) |
| Persistent | Set `"paused": true` in `config/budget.json` |
| Full disable | Remove the scheduled task from your scheduler |
| Nuclear | Delete `config/budget.json` — estimator fails closed |

---

## Per-project DISPATCH.md requirement

Each project in `projects_in_rotation` must have a `DISPATCH.md` file at its repo root with a "Pre-Approved Tasks" section. The dispatcher reads this file to decide what's safe to run autonomously. Example:

```markdown
## Pre-Approved Tasks (No Confirmation Needed)

| Task Keyword | Command | Success Criteria |
|---|---|---|
| test | npm test | All tests pass |
| typecheck | npm run typecheck | Zero type errors |
| audit | pal codereview on src/ | Report findings |
| clean | Remove dead code | Tests pass, commit |

## Requires Confirmation (Never Auto-Execute)

- deploy
- publish
- delete
- architecture
```

The dispatcher will ONLY run keywords from "Pre-Approved Tasks" that are also listed in `budget.json.projects_in_rotation[].opportunistic_tasks`. Anything in "Requires Confirmation" is blocked unconditionally.

See [docs/OPERATOR-GUIDE.md](docs/OPERATOR-GUIDE.md) for full details.

---

## Budget model

Since Anthropic exposes no Claude Max quota endpoint, this tool uses a **declared-budget + transcript-based estimation** approach:

- **Estimator** parses real `usage` fields (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) from Claude Code transcripts at `~/.claude/projects/**/*.jsonl`. These are exact token counts, not byte-counting.
- **Weighted cost** applies per-field weights (default: input 1.0x, output 5.0x, cache-creation 1.25x, cache-read 0.1x) that approximate Anthropic pricing ratios.
- **Baseline anchoring** uses your trailing-30-day weighted cost as the reference and treats `target_burn_pct_per_day` (default 2.5%) as the target pace. This makes the tool a **relative pace detector**: it detects when *this* week/month is above or below *your* historical average. It is not an absolute quota gauge.
- **Dual-period gate** enforces BOTH monthly and weekly checks. The stricter wins. This prevents an easy early-month week from burning quota a study-heavy week will need.
- **Reserve floor** is the real safety net — even a 2× estimator error still leaves the reserve intact.

See `scripts/estimate-usage.mjs` comments for the full math.

---

## Caveats and known limitations

1. **Not an absolute quota API.** This is a relative pace detector. If Anthropic ever publishes a real quota endpoint, swap in `estimator: "admin-api"` mode (not yet implemented — see `HANDOFF.md`).
2. **Bootstrap depends on trailing history.** If you've used Claude Code for less than 30 days, the baseline is weak. The reserve floor still protects you.
3. **Windows-first but cross-platform-safe.** Paths and scheduler examples use Windows conventions. The estimator script itself is fully portable (tested via `homedir()` and `path.resolve`). cron/launchd users need to adapt the scheduler step.
4. **Dispatcher prompt is a template, not a binary.** The Claude prompt in `tasks/budget-dispatch.md` is pasted into Claude Code Desktop's scheduler by hand. A true headless runner would need to invoke `claude -p` with this prompt — that works but requires your own shell wrapper.
5. **Never tested in production.** This ships in dry-run mode by default for a reason. See `HANDOFF.md` for the validation plan.

---

## Contributing

This is extracted from a personal framework (`combo`) used for multi-project orchestration. Pull requests welcome, especially for:

- macOS/Linux scheduler integration (launchd, systemd timers)
- A proper headless runner wrapper for the dispatcher prompt
- Admin Usage API estimator mode
- Better project/task ranking heuristics
- Test suite for the estimator

See [HANDOFF.md](HANDOFF.md) for the list of things explicitly needing polish and second-look review.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Related

- [Claude Code](https://docs.claude.com/en/docs/claude-code) — the CLI this depends on
- [PAL MCP](https://github.com/pmartin1915/pal-mcp-server) — the free cross-model audit server used by the clinical gate
- `combo` — the author's personal multi-project orchestration framework this tool was extracted from

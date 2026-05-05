# Budget-Dispatcher — Agent Context

## Overview

Turn unused Claude Max quota into bounded, safe, autonomous self-improvement work on your projects. A budget-aware gate that only dispatches work when you have headroom.

**Repository:** `pmartin1915/budget-dispatcher`  
**License:** MIT

## Design Principles

1. **User comes first.** Reserve floor (15% monthly / 20% weekly) always protected.
2. **Bounded tasks only.** Pre-approved, idempotent tasks from allowlist.
3. **Never touch `main`.** All work on `auto/<slug>-<task>-<date>` branches or worktrees.
4. **Fail closed.** Missing config → skip. Estimator error → skip. Ambiguity → skip.
5. **Observable.** Every decision logged to JSONL.
6. **Zero Claude cost for no-op.** Estimator is plain Node — exits before Claude if gate is red.

## Architecture

```
Windows Task Scheduler (every 20 min)
    → scripts/estimate-usage.mjs (Node, no Claude cost)
        → status/usage-estimate.json (gate decision)
            → [if authorized] tasks/budget-dispatch.md (Claude prompt)
                → worktree + bounded subagent → local commit → log
```

## Tech Stack

- Node.js 18+
- Plain Node scripts (no framework)
- Git worktrees for isolation
- Windows Task Scheduler (Windows-first, portable to cron/launchd)

## Key Files

| File | Purpose |
|------|---------|
| `scripts/estimate-usage.mjs` | Parses Claude transcripts, estimates usage, writes gate decision |
| `scripts/check-idle.mjs` | Activity gate — 20-min inactivity window |
| `config/budget.json` | User config: projects, tasks, thresholds, paused flag |
| `config/budget.example.json` | Template for new users |
| `tasks/budget-dispatch.md` | Claude prompt template for dispatcher |
| `status/usage-estimate.json` | Latest estimator output |
| `status/budget-dispatch-log.jsonl` | Audit trail of all dispatch decisions |
| `docs/OPERATOR-GUIDE.md` | Full operator documentation |
| `docs/HANDOFF-2026-04-11.md` | Pre-live audit trail |

## Commands

```bash
node scripts/estimate-usage.mjs     # Run estimator manually
node scripts/check-idle.mjs         # Check idle status
```

## Kill Switches

| Speed | Action |
|-------|--------|
| Fastest | `touch config/PAUSED` |
| Persistent | `"paused": true` in `config/budget.json` |
| Full disable | Remove scheduled task |
| Nuclear | Delete `config/budget.json` |

## Per-Project Requirement

Each project in `projects_in_rotation` must have a `DISPATCH.md` with:
- **Pre-Approved Tasks** table (task keyword, command, success criteria)
- **Requires Confirmation** list (blocked unconditionally)

## Session Protocol

Follow `combo/SESSION_PROTOCOL.md` for the 5-phase workflow. This is a meta-tool — changes here affect all rotation projects. Use extra caution.

## Constraints

- Estimator must remain pure Node (no Claude API calls)
- Dispatcher prompt is manually pasted into Claude Code Desktop scheduler
- Dry-run mode (`dry_run: true`) is default for first 3–5 days
- Never pushes or merges automatically

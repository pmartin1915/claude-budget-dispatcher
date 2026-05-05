---
name: budget-dispatcher-context
description: Budget-Dispatcher — opportunistic automation gate for Claude Max quota. Node.js, git worktrees, fail-closed design.
---

# Budget-Dispatcher — Kimi Context

## What This Project Is

A budget-aware gate that turns unused Claude Max quota into bounded, safe, autonomous self-improvement work. It only dispatches when you're below pace on monthly + weekly budgets.

## Kimi's Scope

**Do:**
- Node script refactoring and cleanup
- Estimator math improvements
- JSON parsing and logging improvements
- Documentation updates
- Test suite for estimator (currently missing)
- Portable script improvements (Windows → macOS/Linux)

**Do NOT:**
- Change gate logic without understanding the dual-period math
- Remove or bypass kill switches
- Make the estimator invoke Claude (must stay pure Node)
- Change default reserve floors without explicit approval

## Key Code Paths

- `scripts/estimate-usage.mjs` — Core estimator. Parses `~/.claude/projects/**/*.jsonl`, applies weighted costs, compares to pace targets.
- `scripts/check-idle.mjs` — Activity gate. Checks transcript mtime for 20-min inactivity.
- `config/budget.json` — Live config. Never commit real paths/keys.
- `tasks/budget-dispatch.md` — Claude prompt template. Read-only reference for understanding dispatch behavior.

## Testing

There is currently **no test suite** for the estimator. This is a known gap and a good Kimi task.

## Math to Respect

- Weighted cost: input 1.0x, output 5.0x, cache-creation 1.25x, cache-read 0.1x
- Dual-period gate: monthly AND weekly checks; stricter wins
- Reserve floor: 15% monthly / 20% weekly default
- Baseline: trailing-30-day weighted cost

## Safety

This tool touches real project repos and real Claude quota. Always:
1. Leave `dry_run: true` in config when testing
2. Verify estimator output before any dispatcher change
3. Preserve all kill switches

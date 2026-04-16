# Handoff Prompt

Paste this into the next Claude Code session:

```
Resume work on claude-budget-dispatcher.

Required reading:
1. DISPATCHER-STATUS.md (dual-engine guide, scorecard, current state)
2. git log --oneline main -16
3. HANDOFF.md (Part 9 context + gotchas list at bottom)

Current state: Both engines wired via -Engine auto (budget-adaptive routing).
Free-model engine is LIVE (dry_run: false). Auto mode checks budget on every
firing: Claude when headroom is positive, free models otherwise. Budget is
currently over-pace (headroom -24%), so auto selects node every time. When
headroom turns positive, Claude kicks in automatically. 36/36 items done
(excluding S-1/S-2 infra-gated on WSL2).

This session (Part 9) shipped 1 commit:
- c925524 engine switching dashboard, CLI control, config override, -ForceBudget

New tools available:
- node scripts/dashboard.mjs   # web UI at localhost:7380
- node scripts/control.mjs     # interactive CLI
- -ForceBudget flag on run-dispatcher.ps1 (bypasses budget + activity gates for Claude validation)
- engine_override field in config/budget.json (instant engine switching, no admin)

Remaining:
- Claude engine validation (run -ForceBudget once to confirm full pipeline)
- S-1/S-2 execution sandbox + network isolation (deferred, needs WSL2)
- I-4 native SDK reconciliation (optional, withTimeout works)
- Expand project rotation (add projects + src/ dirs to unlock more tasks)
- Dashboard enhancements (see HANDOFF.md suggestions section)

Manual testing:
  node scripts/dashboard.mjs                     # open localhost:7380
  node scripts/control.mjs                        # CLI menu
  node scripts/dispatch.mjs --force --dry-run     # inspect pipeline
  node scripts/dispatch.mjs --force               # real dispatch now
  cat status/budget-dispatch-last-run.json        # check results

Before any commit: run mcp__pal__codereview with model: "gemini-2.5-pro".
Fallback to review_validation_type: "internal" if Gemini is 503-ing.
Do NOT flip dry_run back to true. Do NOT re-enable ClaudeBudgetDispatcher
(auto mode replaces it). Do NOT use gemini-3-pro-preview.
Do NOT add -ForceBudget to the scheduled task.
```

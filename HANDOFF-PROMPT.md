# Handoff Prompt

Paste this into the next Claude Code session:

```
Resume work on claude-budget-dispatcher.

Required reading:
1. DISPATCHER-STATUS.md (dual-engine guide, scorecard, current state)
2. git log --oneline main -20
3. HANDOFF.md (Part 10 context + gotchas list at bottom)

Current state: Both engines validated and live. Auto mode (budget-adaptive
routing) active via scheduled task. Free-model engine has 1 real successful
dispatch. Claude engine validated via -ForceBudget (fail-closed on negative
headroom). Dashboard redesigned with 6 tabs. CLI upgraded with 10 options.

This session (Part 10) shipped 8 commits:
- 537b30f  -ForceBudget bypasses activity gate
- ed25364  resolve claude.cmd for Start-Process
- 6873aa8  .NET Process for reliable ExitCode
- dfb45fb  mark Claude engine validated
- ff8b9ab  fix libuv crash on dispatch.mjs exit
- 9da4f2c  redesigned dashboard (6 tabs) + enhanced CLI
- 861af9b  fix client-side esc() missing
- 174b072  About tab with project docs

Tools available:
- node scripts/dashboard.mjs   # web UI at localhost:7380 (6 tabs)
- node scripts/control.mjs     # interactive CLI (10 options)
- -ForceBudget flag on run-dispatcher.ps1 (bypasses budget + activity gates)
- engine_override field in config/budget.json (instant engine switching)

Highest-priority next steps:
1. Add Perry's iOS apps to project rotation (create DISPATCH.md + CLAUDE.md
   in each repo, add to projects_in_rotation in budget.json, start with
   audit task for baseline)
2. Desktop notifications on dispatch completion (PowerShell toast)
3. Scheduled task health check in dashboard Status tab
4. Auto-open browser on dashboard start
5. WebSocket for live dashboard updates (replace 30s polling)

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

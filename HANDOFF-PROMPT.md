# Handoff Prompt

Paste this into the next Claude Code session:

~~~
Resume claude-budget-dispatcher.

## Required reading (in order)

1. HANDOFF.md -- Part 17 first (TL;DR + state check), then Part 16 (open questions), then Part 15 (invariant protocol, failure-modes table, guardrails).
2. git log --oneline -10
3. status/health.json  (or `gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json` from any machine)

## Before touching code: run the 6 invariants from Part 15

1. node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json  → expect "healthy (ok)"
2. Pre-commit hook installed: `diff scripts/hooks/pre-commit .git/hooks/pre-commit`  → empty
3. `node --check` on every .mjs under scripts/  (pre-commit hook does this; verify manually on cold clones)
4. Dashboard loads: http://localhost:7380 → Fleet tab renders 11 projects
5. status/budget-dispatch-last-run.json fresh (<1h if user-active window, <4h if idle-eligible)
6. `cd ../combo && git branch --list 'auto/*' | wc -l`  → should grow over time (was 15 at Part 17 write)

## Pollution canary (added in Part 17)

`grep -c '^\[' status/budget-dispatch-log.jsonl`  → should be **10** and stay 10 forever.
If it grows: new run-dispatcher.ps1 case-collision or another Write-Log path bleeding into JSONL. See Part 16 Bug B.

## Open questions -- pick one and run (full detail in HANDOFF.md Part 16)

1. **Greenfield sandboxes have never been dispatched** (5 projects, zero auto/* branches). Recommended path: wait 24h → trace selector → soft STATE.md bias → hard `never_dispatched_bonus`. Start with observation, not code.
2. **boardbound date-sensitive vitest failures** block non-audit dispatches. Recommended: surgical `vi.useFakeTimers()` fix in the boardbound repo, not the dispatcher.
3. **Cross-machine status board**: build the lighter-touch `fleet.json` gist-sync (~4 lines in run-dispatcher.ps1 mirroring the health.json flow). Do NOT wire scripts/status.mjs into dispatch.mjs -- 144 comments/day flood risk.

## Audit discipline -- MANDATORY on hot-path files

Hot-path = dispatch.mjs, worker.mjs, verify-commit.mjs, provider.mjs, router.mjs, throttle.mjs, selector.mjs, context.mjs, run-dispatcher.ps1, scripts/lib/health.mjs.

Before any commit that touches hot-path:
  mcp__pal__codereview  with  model: "gemini-2.5-pro"
Fallback: review_validation_type: "internal" if Gemini 503s.
Zero findings is not a waste -- it confirms the change is minimal.

Docs-only changes (HANDOFF.md, README, config comments) do NOT need codereview.

## Suggested workflow (Opus <-> Sonnet swap, Part 17)

- **Opus 4.7 (1M ctx)** = planning + audit. Use for: understanding invariants, tracing bugs, writing handoffs, orchestrating mcp__pal__codereview, judging hot-path risk. Default to Plan mode on any change touching hot-path.
- **Sonnet 4.6** = implementation once a plan is approved. Switch to it after ExitPlanMode for the mechanical edit phase; switch back to Opus for the pre-commit review pass.
- **One-shot audits** (no code change): Opus + invariant commands + a short chat update. No Plan mode needed.

## PAL MCP toolbelt

- `mcp__pal__codereview` (gemini-2.5-pro): final gate before hot-path commits.
- `mcp__pal__precommit`: sanity-check pending diff before push.
- `mcp__pal__thinkdeep`: stuck on a root cause, or the symptom doesn't match any failure-mode row in Part 15.
- `mcp__pal__consensus`: judgment calls (e.g. "wait-24h vs. add never_dispatched_bonus"). Get 2-3 model views.
- `mcp__pal__debug`: surgical investigation in unfamiliar code paths.

## Do NOT

- flip `dry_run` back to true
- re-enable the old `ClaudeBudgetDispatcher` task (the `BudgetDispatcher-Node` node engine is authoritative)
- use `gemini-3-pro-preview`
- add `-ForceBudget` to the scheduled task
- use positional `gh gist edit <id> <file>` -- always `-a <file>` on multi-file gists (Part 15 guardrail #8, Part 16 Bug A)
- add a local variable in `run-dispatcher.ps1` whose name case-matches a script-scope `$Var` (Part 16 Bug B -- PowerShell is case-insensitive, collision silently redirects Write-Log)
- put test stderr into any JSON that flows to `budget-dispatch-log.jsonl` (Part 15 guardrail #2 -- that file is gist-sync candidate)
- commit hot-path code without `mcp__pal__codereview` gemini-2.5-pro
- push the handoff commit without Perry's "say the word"
~~~

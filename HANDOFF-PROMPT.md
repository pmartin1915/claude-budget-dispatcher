# Handoff Prompt

Paste this into the next Claude Code session (laptop or any machine):

~~~
Resume claude-budget-dispatcher.

## Required reading (in order)

1. HANDOFF.md -- Part 19 first (selector starvation fix, cowork inheritance, current state), then Part 18 (fleet.json sync), then Part 16 for the only still-open pre-19 question (Q2 boardbound date tests), then Part 15 (invariants + guardrails).
2. git log --oneline -15  -- expect `f868484 fix: unstick selector rotation` on top, preceded by 6 cowork commits (6d46e44 through 3b88e14) and then Part 18 commits (81e641d, 2af0429).
3. status/health.json  (or `gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json` from any machine). Three-state now: `{healthy, idle, down}`. "idle" during quiet windows is NORMAL, not a failure.
4. Cross-machine view: `gh gist view 655d02ce43b293cacdf333a301b63bbf` -- expect health.json, budget-dispatch-last-run.json, budget-dispatch-status.json, fleet-<hostname>.json per machine that has run the wrapper.

## If this is a FRESH machine (e.g. the laptop first picking this up)

Run the Part 18 second-machine first-run checklist BEFORE anything else:

1. `git pull` -- must include commit `f868484`. If not on origin yet, stop and flag it.
2. Install pre-commit hook if missing: `cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
3. Trigger one wrapper run: `powershell -File scripts/run-dispatcher.ps1 -RepoRoot "$(pwd)" -Engine node`
4. Verify `status/fleet-<thishostname>.json` was created locally.
5. Verify remote: `gh gist view 655d02ce43b293cacdf333a301b63bbf` lists `fleet-<thishostname>.json`.
6. Pollution canary: `grep -c '^\[' status/budget-dispatch-log.jsonl` MUST be 10.
7. Greenfield sandboxes: `git clone https://github.com/pmartin1915/extra-sub-standalone-<slug>` for each of {biz-app, game-adventure, dnd-game, sand-physics, worldbuilder} to the path listed in the local `config/budget.json` (which is gitignored -- copy from the wilderness machine).

## Before touching code: run the 8 invariants (Part 15 + Part 18 + Part 19 additions)

1. `node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json` -> expect "healthy (ok)" or "idle (no work found in Xh)"
2. Pre-commit hook installed: `diff scripts/hooks/pre-commit .git/hooks/pre-commit` -> empty
3. `node --check` on every .mjs under scripts/ (includes fleet.mjs + new alerting.mjs + test files)
4. Dashboard loads: http://localhost:7380 -> Fleet tab + Analytics tab both render
5. status/budget-dispatch-last-run.json fresh (<1h during user-active, <4h when idle-eligible)
6. `cd ../combo && git branch --list 'auto/*' | wc -l` -- should grow over time after Part 19 fix unsticks rotation (was 15 at Parts 17-19 write)
7. `ls status/fleet-*.json` -- at least this machine's fleet file present
8. NEW (Part 19): `tail -200 status/budget-dispatch-log.jsonl | grep -oE 'auto/[a-z-]+-[a-z-]+' | sort | uniq -c | sort -rn` -- selector rotation should spread across multiple projects, not concentrate on one. If one project dominates >80% for 24h+ post-f868484, the fix isn't working.

## Pollution canary (unchanged since Part 17)

`grep -c '^\[' status/budget-dispatch-log.jsonl` -> MUST be **10** and stay 10 forever.
If it grows: new Write-Log path bleeding into JSONL. Check the Part 18 fleet block AND the Part 19 appendLog edits.

## Part 19 project/task canary

Post-fix, every non-error JSONL entry should have project+task at top level. Test:

```bash
tail -20 status/budget-dispatch-log.jsonl | node -e "
const lines = require('fs').readFileSync(0,'utf8').trim().split('\n');
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    if (o.outcome && o.outcome !== 'wrapper-success' && o.outcome !== 'error' && !o.project) {
      console.log('MISSING project:', l.slice(0, 120));
    }
  } catch {}
}
"
```
Empty output is healthy. Any missing-project warning means a new appendLog call site regressed Part 19.

## Open questions -- current state

1. ~~Greenfield sandboxes never dispatched~~ -- effectively RESOLVED by Part 19 + pushing the 5 GitHub repos. Monitor for ~24h to confirm rotation reaches each greenfield at least once.
2. **Boardbound date-sensitive vitest failures** block non-audit dispatches. Recommended: surgical `vi.useFakeTimers()` fix in the boardbound repo. Out of scope for dispatcher.
3. ~~Cross-machine status board~~ -- SHIPPED Parts 18 + cowork.
4. **NEW (Part 19): Consolidate context.mjs log I/O.** 3× redundant JSONL reads per selector call. Gemini flagged as MEDIUM; acceptable-to-defer. Refactor into a single-pass helper returning `{lastDispatch, lastAttempt, recentOutcomes}` for a future session.
5. **NEW (Part 19): Audit the 6 cowork commits.** +1278 lines, includes security-relevant code (alerting.mjs sends HTTP plaintext by default; worker.mjs audit hardening uses credential-stripping regex that could be bypassed with edge inputs). Run `mcp__pal__codereview` with gemini-2.5-pro before extending those subsystems.

## Audit discipline -- MANDATORY on hot-path files

Hot-path (Part 19 expanded list): `dispatch.mjs`, `worker.mjs`, `verify-commit.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`, `selector.mjs`, `context.mjs`, `run-dispatcher.ps1`, `scripts/lib/health.mjs`, `scripts/lib/fleet.mjs`, **`scripts/lib/alerting.mjs`** (new), **`scripts/lib/gates.mjs`**, **`scripts/lib/git-lock.mjs`**.

Before any commit that touches hot-path:
  mcp__pal__codereview with model: "gemini-2.5-pro"
Fallback: review_validation_type: "internal" if Gemini 503s.

**From Part 18:** Gemini can overstate severity. Verify empirically when you can. "HIGH" in Gemini's output is not a trump card -- cross-check against the actual runtime behavior. Part 18 flagged a CRLF "correctness bug" that was actually fine because JSON.parse treats \r as whitespace (ECMA-404).

## Suggested workflow (Opus <-> Sonnet swap, Parts 17-19)

- **Opus 4.7 (1M ctx)** = planning + audit + handoff writing + hot-path orchestration.
- **Sonnet 4.6** = implementation once a plan is approved. Switch to it after ExitPlanMode for mechanical edits; switch back to Opus for pre-commit review pass.
- **One-shot audits** (no code change): Opus + invariants + short chat update. No Plan mode needed.
- For this repo's size of changes (Part 19 was 3 hot-path files + 44 insertions), Plan mode is optional — a clear in-chat proposal + AskUserQuestion before editing works if Perry confirms scope.

## PAL MCP toolbelt

- `mcp__pal__codereview` (gemini-2.5-pro): final gate before hot-path commits.
- `mcp__pal__precommit`: sanity-check pending diff before push.
- `mcp__pal__thinkdeep`: stuck on a root cause, or the symptom doesn't match any failure-mode row in Part 15.
- `mcp__pal__consensus`: judgment calls. Get 2-3 model views.
- `mcp__pal__debug`: surgical investigation in unfamiliar code paths.

## Do NOT

- flip `dry_run` back to true
- re-enable the old `ClaudeBudgetDispatcher` task (the `BudgetDispatcher-Node` node engine is authoritative)
- use `gemini-3-pro-preview`
- add `-ForceBudget` to the scheduled task
- use positional `gh gist edit <id> <file>` -- always `-a <file>` on multi-file gists (Part 15 guardrail #8, Part 16 Bug A)
- add a local variable in `run-dispatcher.ps1` whose name case-matches a script-scope `$Var` (Part 16 Bug B)
- put test stderr into any JSON that flows to `budget-dispatch-log.jsonl` (Part 15 guardrail #2 -- that file is gist-sync candidate)
- commit hot-path code without `mcp__pal__codereview` gemini-2.5-pro
- push the handoff commit without Perry's "say the word"
- rename or relocate `scripts/lib/fleet.mjs` (Part 18)
- write a single merged `fleet.json` across machines (Part 18)
- revert the project/task attachment at `dispatch.mjs:256-267` without also reverting `context.mjs` and `selector.mjs` changes (Part 19 -- coupled fix)
- rely on `last_dispatched` alone for rotation decisions -- use `last_attempted` (Part 19 Rule 3)
- change Rule 3 wording without preserving "never ranks as more stale than any timestamp" (Part 19 self-healing behavior depends on this)
~~~

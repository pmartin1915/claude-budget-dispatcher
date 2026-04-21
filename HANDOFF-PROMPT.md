# Handoff Prompt

Paste this into the next Claude Code session (laptop or any machine):

~~~
Resume budget-dispatcher.

## Required reading (in order)

1. HANDOFF.md -- Part 20 first (Tuscaloosa-prep fleet fields + worldbuilder ADR-0001), then Part 19 (selector starvation fix), then Part 18 (fleet.json gist sync), then Part 16 Q2 (boardbound date tests -- still open but deprioritized per Perry's standing guidance), then Part 15 (invariants + guardrails).
2. git log --oneline -15  -- expect `fab7d71 feat: fleet.json remote-debug fields (Part 20)` near top, plus laptop commits 8321fd0 (F1.1 lock) + 06092be (C1.1 cache) and Part 19 commits.
3. status/health.json  (or `gh gist view 655d02ce43b293cacdf333a301b63bbf -f health.json` from any machine). Three-state: {healthy, idle, down}. "idle" during quiet windows is NORMAL.
4. Cross-machine view: `gh gist view 655d02ce43b293cacdf333a301b63bbf` -- expect health.json, budget-dispatch-last-run.json, budget-dispatch-status.json, fleet-<hostname>.json per machine.

## Part 20 remote-monitoring playbook (this is why the Tuscaloosa prep matters)

From any machine, a laptop can now read per-machine dispatcher state:

```bash
gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet-perrypc.json | jq .
```

Look for the NEW Part 20 fields:
- consecutive_errors -- tail count of outcome=error (>=3 = down state, investigate)
- last_error_reason -- "final-test-failure", "retries-exhausted", "hard-timeout", etc.
- last_error_phase -- gate / selector / router / complete / unhandled
- last_error_ts -- when the failure happened

Skips/dry-runs/wrapper-success are neutral; success and reverted break the error streak (mirrors health.mjs). Privacy: reason values are bounded enum-like strings (scanned verify-commit.mjs + dispatch.mjs).

## If this is a FRESH machine (laptop first-time pickup)

1. `git pull` -- must include `fab7d71`. If not on origin, flag it and stop.
2. Install pre-commit hook if missing: `cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
3. Trigger one wrapper: `powershell -File scripts/run-dispatcher.ps1 -RepoRoot "$(pwd)" -Engine node`
4. Verify status/fleet-<hostname>.json exists locally with the full 15-field shape (includes last_error_* + consecutive_errors).
5. Verify remote: `gh gist view 655d02ce43b293cacdf333a301b63bbf` lists fleet-<hostname>.json.
6. Pollution canary: `grep -c '^\[' status/budget-dispatch-log.jsonl` MUST be 10.
7. Greenfield sandboxes: `git clone https://github.com/pmartin1915/extra-sub-standalone-<slug>` each of {biz-app, game-adventure, dnd-game, sand-physics, worldbuilder} to the path listed in config/budget.json.

## Before touching code: run the 9 invariants (Part 15 + 18 + 19 + 20 additions)

1. `node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json` -> "healthy (ok)" or "idle (no work found in Xh)"
2. Pre-commit hook installed: `diff scripts/hooks/pre-commit .git/hooks/pre-commit` -> empty
3. `node --check` on every .mjs under scripts/
4. Dashboard loads: http://localhost:7380 -- Fleet tab + Analytics tab both render
5. status/budget-dispatch-last-run.json fresh (<1h user-active, <4h idle)
6. `cd ../combo && git branch --list 'auto/*' | wc -l` -- should grow over time
7. `ls status/fleet-*.json` -- at least this machine's fleet file present with 15-field shape
8. Selector rotation not stuck on one project: `tail -200 status/budget-dispatch-log.jsonl | grep -oE 'auto/[a-z-]+-[a-z-]+' | sort | uniq -c | sort -rn`
9. NEW (Part 20): `cat status/fleet-$(hostname).json | jq .consecutive_errors` -> 0 normally; >=3 means investigate the new last_error_* fields

## Pollution canary (unchanged since Part 17)

`grep -c '^\[' status/budget-dispatch-log.jsonl` -> MUST be **10** and stay 10 forever.

## Part 19 project/task canary (unchanged)

Post-Part-19 every non-error JSONL entry should have project+task at top level. If any missing, a new appendLog call site regressed the fix.

## Open questions -- current state

1. ~~Greenfield sandboxes never dispatched~~ -- RESOLVED by Part 19 + GitHub push.
2. **Boardbound date-sensitive vitest failures** -- UNCHANGED. Perry has deprioritized this. Out of scope while away.
3. ~~Cross-machine status board~~ -- SHIPPED Parts 18 + 20.
4. **Consolidate context.mjs log I/O** (MEDIUM, future refactor) -- not blocking.
5. **Audit cowork changes** -- 6 commits, +1278 lines, security-relevant (alerting HTTP plaintext, credential-stripping regex). Run mcp__pal__codereview before extending those subsystems.
6. NEW (Part 20): **Auto-pull from laptop** -- deferred, risk-analysis session needed. Currently laptop pushes don't propagate to PC automatically.
7. NEW (Part 20): **stderr tail gist sync** -- deferred, privacy review needed.
8. NEW (Part 20 -- worldbuilder project): **ADR-0001 review** -- the narrative schema proposal is committed to worldbuilder/docs/ (commit 40217a8, not pushed). Perry to review + accept. ADR-0002 candidate is relationship cardinality constraints.

## Audit discipline -- MANDATORY on hot-path files

Hot-path (current list): `dispatch.mjs`, `worker.mjs`, `verify-commit.mjs`, `provider.mjs`, `router.mjs`, `throttle.mjs`, `selector.mjs`, `context.mjs`, `run-dispatcher.ps1`, `scripts/lib/health.mjs`, `scripts/lib/fleet.mjs`, `scripts/lib/alerting.mjs` (cowork), `scripts/lib/gates.mjs` (cowork), `scripts/lib/git-lock.mjs` (cowork), `scripts/lib/gist.mjs` (F1.1 laptop), `scripts/lib/cache.mjs` (C1.1 laptop).

Before any hot-path commit: `mcp__pal__codereview` with model gemini-2.5-pro.

**From Part 18/20:** Gemini can overstate severity. Verify empirically. Part 18 flagged CRLF as HIGH -- turned out fine (JSON.parse tolerates \r). Part 20 flagged a rationale-vs-code contradiction (YELLOW) that was only a wording issue. Cross-check against actual runtime.

## Suggested workflow (Opus <-> Sonnet swap)

- **Opus 4.7 (1M ctx)** = planning + audit + handoff writing + hot-path orchestration.
- **Sonnet 4.6** = mechanical implementation after ExitPlanMode. Switch back to Opus for pre-commit review.
- **One-shot audits** (no code change): Opus + invariants + short chat update. No Plan mode.
- Plan mode is reasonable but optional for small well-scoped hot-path changes when Perry confirms scope in chat.

## PAL MCP toolbelt

- `mcp__pal__codereview` (gemini-2.5-pro): final gate before hot-path commits.
- `mcp__pal__precommit`: sanity-check pending diff.
- `mcp__pal__thinkdeep`: stuck on root cause, or symptom doesn't match failure-mode table.
- `mcp__pal__consensus`: judgment calls, architectural decisions. Get 2-3 model views. (Note Part 20: openai/gpt-5.2 may hit OpenRouter credit limits -- fall back to a single gemini-2.5-pro review if needed.)
- `mcp__pal__debug`: surgical investigation.

## Do NOT

- flip `dry_run` back to true
- re-enable the old `ClaudeBudgetDispatcher` task (the `BudgetDispatcher-Node` node engine is authoritative)
- use `gemini-3-pro-preview`
- add `-ForceBudget` to the scheduled task
- use positional `gh gist edit <id> <file>` -- always `-a <file>` on multi-file gists
- add a local variable in `run-dispatcher.ps1` whose name case-matches a script-scope `$Var` (Part 16 Bug B)
- put test stderr into any JSON that flows to `budget-dispatch-log.jsonl` (Part 15 guardrail #2)
- commit hot-path code without `mcp__pal__codereview` gemini-2.5-pro
- push the handoff commit without Perry's "say the word"
- revert the Part 19 project/task attachment at dispatch.mjs:277-288 without also reverting context.mjs + selector.mjs changes (coupled fix)
- rely on `last_dispatched` alone for rotation decisions -- use `last_attempted` (Part 19 Rule 3)
- change Rule 3 wording without preserving "never ranks as more stale than any timestamp" (Part 19 self-healing behavior depends on this)
- rename or relocate `scripts/lib/fleet.mjs` (Part 18 path contract)
- write a single merged `fleet.json` across machines (Part 18 per-file race-free model)
- remove the 4 Part 20 error fields from fleet.mjs without also removing the laptop-side monitoring playbook (Part 20 handoff)
- attempt fix-from-laptop while on a trip -- auto-pull is NOT implemented, a bad push lands on the PC only after manual pull
- push fab7d71 or 40217a8 without explicit Perry go-ahead
~~~

## Pre-departure checklist for Perry (before Tuscaloosa)

1. **Review Part 20 fleet fields.** `node scripts/lib/fleet.mjs status/budget-dispatch-log.jsonl /tmp/fleet-test.json $(hostname)` -- inspect /tmp/fleet-test.json. Confirm the 4 new fields match your expectation. Rename "perrypc" if you want a different machine name.

2. **Decide: push fab7d71 before leaving?**
   - YES (recommended): laptop gets the rich fleet view for the whole trip.
   - NO: laptop sees the old sparse fleet.json; Part 20 rollback is trivial (one commit).

3. **Review worldbuilder ADR-0001.** Read `c:/Users/perry/DevProjects/sandbox/extra-sub-standalone-worldbuilder/docs/ADR-0001-schema-foundations.md`. Mark "Accepted" in the Status field if satisfied, or request revisions. Push (or ask me to push) the worldbuilder commit `40217a8` when ready.

4. **Optional: fire a -ForceBudget dispatch** to generate a fresh successful dispatch data point before leaving.

5. **Subscribe to ntfy.sh topic** (if you haven't yet). Check [config/budget.example.json](config/budget.example.json) for the alerting section. When `scripts/lib/alerting.mjs` fires a healthy→down alert while you're away, your phone gets a push.

6. **Test the laptop's dispatcher hasn't run** -- `gh gist view 655d02ce43b293cacdf333a301b63bbf` should NOT yet list fleet-<laptop>.json unless you've kicked one off. If it does, verify the laptop's machine name is distinct from perrypc.

## cowork-bus (deferred Track B) checklist

When your cowork instance signals that cowork-bus is ready for audit:

1. Follow `SYNCTHING-SETUP-PROMPT-2026-04-18.md` on all three machines (phase 1 → collect IDs → phase 2).
2. `npm link` cowork-bus globally on each machine.
3. `bus init perrypc` / `bus init laptop` / `bus init optiplex`.
4. Smoke test: `bus ping --task sync-setup --progress "paired"`; `bus status` shows all three.
5. Run `mcp__pal__codereview` with gemini-2.5-pro on the cowork-bus codebase. Focus: secrets in state files, sync-lag tolerance, race conditions on concurrent writes.
6. Document setup + audit findings in a future handoff part.

## Part 21: slot_fill task class

**Class name:** `slot_fill` (router.mjs TASK_TO_CLASS, budget.example.json classes)

**Purpose:** Expands flagged subsections in worldbuilder content files (YAML culture/geography) using free-tier LLM (Gemini 2.5 Pro). Parses provenance headers in comment blocks at the top of each file.

**Project config shape** (`slot_fill_config` on a projects_in_rotation entry):
```json
{
  "slot_fill_config": {
    "lane_files": ["linguistics/cultures/oravan.yaml", "..."],
    "prompt_file": "docs/PHASE-0-1-DEVICE-PROMPTS-2026-04-19.md",
    "prompt_section": "Prompt 3: PC dispatcher",
    "validators": [
      { "cmd": "node", "args": ["src/validate.js", "{file}", "{schema}"], "schema": "schemas/culture.schema.json" },
      { "cmd": "node", "args": ["src/phoneme-check.js", "{file}"] }
    ]
  }
}
```

**Provenance header format** (YAML comment block between `# ====...====` lines):
- `[X]` or `[x]` = complete, skip
- `[?]` = partial, low-priority TODO
- `[!]` = missing + required, high-priority TODO
- Regex: `/^#\s+\[([!?xX])\]\s+(\S+)/`

**Expected outcomes:**
- `success` — subsection expanded, validators passed
- `skipped` (reason `missing-slot_fill-config`) — project not configured
- `skipped` (reason `slot_fill-complete`) — all subsections [x]/[X]
- `reverted` (reason `slot_fill-validation-failed`) — validators failed after retry
- `error` — path escape, parse failure, LLM error, missing prompt

**Diagnostic location:** `{projectPath}/state/notes/{hostname}.md` — appended on validation failure after retry.

**Validator env:** Uses `getSafeTestEnv()` (SAFE_ENV_KEYS allowlist). Validators run with cwd = projectPath. `{file}` and `{schema}` placeholders substituted in args.

**Retry budget:** 1 retry per file. On 2nd validator failure: revert + diagnostic + return reverted.

**Audit:** Validators serve the audit role — `auditChanges()` is NOT called.

**Hot-path:** worker.mjs is on the hot-path list (line 74). The slot_fill addition was reviewed via `mcp__pal__codereview` with gemini-2.5-pro covering all 7 security focus areas (path escape, retry bounds, prompt injection, hostname traversal, validator races, header crash, env leak). 0 CRITICAL/HIGH/MEDIUM findings.

**Deferred:** `golden_examples:` support — actual migrated files use `DISPATCHER TASK` reference lines, not structured golden_examples blocks. See `state/notes/laptop-cc.md` for Gap 12 assessment.

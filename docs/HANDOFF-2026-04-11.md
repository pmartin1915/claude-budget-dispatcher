# HANDOFF — claude-budget-dispatcher

> **Status:** Initial public release pushed. **Hold for fixes** before running live. Cross-model audit convergence on several real bugs. This document is the polish list for the next session (or a deep-research chat).

**Repo:** https://github.com/pmartin1915/claude-budget-dispatcher
**Current commit:** `fe185c9` (initial release)
**Audit run date:** 2026-04-11
**Models consulted:** Gemini 2.5 Pro (Google direct), Mistral Large Latest (Mistral direct), Codestral Latest (Mistral direct). Three independent voices across 2 vendor families. Target was 5 across 5 families — 3 OpenRouter models and 1 Bedrock model errored out (see "Free-model audit roster reality" below).

---

## Convergent verdict

All three auditors independently returned: **hold for fixes**.

Core design is sound. The dual-gate pace detector, fail-closed philosophy, local-auto-branch-only commit policy, and two-layer architecture (free Node estimator + Claude dispatcher prompt) all got approval. The bugs are in the implementation details, not the architecture.

---

## Critical issues (MUST fix before flipping `dry_run: false`)

### C1. Cold-start bootstrap math fails open
- **Where:** `scripts/estimate-usage.mjs` around line 150 (`buildSnapshot` → `costPerPctPoint`)
- **Found by:** Gemini 2.5 Pro + Mistral Large (independent convergence)
- **Bug:** When `trailing30 === 0` (fresh install, no Claude history yet), the fallback `costPerPctPoint = 1` means every cost unit equals 1 pct-point. This makes `monthlyActualPct = 0` for any real usage, which reports maximum headroom and **authorizes dispatch on day 1** — exactly the wrong behavior. A fresh user with no reserve pattern gets a green light.
- **Impact:** Violates Invariant #1 (fail closed) and Invariant #3 (reserve floor is the real safety net). The reserve floor math depends on `actual_pct` being truthful; cold start makes it a lie.
- **Fix (consensus):**
  ```javascript
  // At the top of buildSnapshot() after computing trailing30:
  const MIN_HISTORY_COST = 100; // arbitrary small threshold; tune per token_weights
  if (trailing30 < MIN_HISTORY_COST) {
    return {
      generated_at: new Date(now).toISOString(),
      paused,
      dispatch_authorized: false,
      skip_reason: "insufficient-history-for-bootstrap",
      bootstrap: { trailing_30day_cost: round(trailing30, 0), cost_per_pct_point: null, method: "trailing-30-anchored-to-target-rate" }
      // ... null/zero the monthly+weekly blocks with a comment
    };
  }
  ```

### C2. Division-by-zero on bad config
- **Where:** `scripts/estimate-usage.mjs` same area, on `target_burn_pct_per_day`
- **Found by:** Gemini 2.5 Pro
- **Bug:** If `target_burn_pct_per_day` is `0`, `null`, or missing, `costPerPctPoint = trailing30 / (30 * 0) = Infinity`. Then `monthlyActualPct = monthlyCost / Infinity = 0`, which reports zero usage, which authorizes dispatch.
- **Fix:** Validate config at the top of `buildSnapshot`:
  ```javascript
  const target = config.monthly?.target_burn_pct_per_day;
  if (!target || typeof target !== "number" || target <= 0) {
    return { ..., dispatch_authorized: false, skip_reason: "invalid-config-target_burn_pct_per_day" };
  }
  ```

### C3. Timezone drift at month boundaries
- **Where:** `scripts/estimate-usage.mjs` `monthlyPeriodStart`
- **Found by:** Gemini 2.5 Pro + Mistral Large
- **Bug:** `monthlyPeriodStart` uses local-time `setDate`/`setHours`. Entry timestamps from transcripts are ISO strings parsed by `Date.parse(ts)` which is UTC-aware. On reset day (1st of month), this creates up to 24 hours of drift where bucket membership is wrong — entries in the "first day" of the new month may be counted against last month.
- **Impact:** Miscounts usage for ~24h around the 1st of each month. Could false-alarm or false-greenlight.
- **Fix (Mistral proposal):** Use UTC consistently everywhere.
  ```javascript
  function monthlyPeriodStart(now, resetsOnDay) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    if (d.getUTCDate() >= resetsOnDay) {
      d.setUTCDate(resetsOnDay);
    } else {
      d.setUTCMonth(d.getUTCMonth() - 1);
      d.setUTCDate(resetsOnDay);
    }
    return d.getTime();
  }
  ```
  Also update `daysInMonthContaining` to use `getUTCFullYear/Month`.
- **Alternative (Gemini proposal):** Add an explicit `timezone` field in `budget.json` and use `date-fns-tz`.
- **Pick one:** UTC-everywhere is simpler and matches how Anthropic timestamps already arrive. Go with Mistral's proposal.

### C4. Activity gate is Linux-only (silently no-ops on Win/Mac)
- **Where:** `tasks/budget-dispatch.md` Step 2
- **Found by:** Gemini 2.5 Pro + Mistral Large
- **Bug:** `find ~/.claude/projects -name "*.jsonl" -newermt "$(date -d '20 minutes ago')"` uses GNU-specific `date -d`. On Windows Git Bash this may work depending on coreutils; on macOS BSD `date` uses `-v-20M` syntax; on bare Windows it just fails. A silent failure means the activity gate returns false negatives, and the dispatcher will spawn work while Perry is actively using Claude Code.
- **Impact:** Violates Invariant #5 (zero cost for no-op) AND potentially collides with user's session.
- **Fix:** Replace the shell command with a Node helper script (`scripts/check-idle.mjs`) that the dispatcher prompt can call via `node`. Node is already a dependency; it's platform-native. Something like:
  ```javascript
  // scripts/check-idle.mjs
  import { readdirSync, statSync } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";

  const idleMinutes = Number(process.argv[2] || 20);
  const cutoff = Date.now() - idleMinutes * 60_000;
  const root = join(homedir(), ".claude", "projects");

  function* walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) yield full;
    }
  }

  for (const f of walk(root)) {
    if (statSync(f).mtimeMs > cutoff) {
      process.stdout.write("user-active\n");
      process.exit(1);
    }
  }
  process.stdout.write("idle\n");
  process.exit(0);
  ```
  Then Step 2 in the prompt becomes: `node <REPO_ROOT>/scripts/check-idle.mjs 20` — check exit code.

---

## High-severity issues (fix before first real-work run)

### H1. Subagent constraints are prompt-only, not technically enforced
- **Where:** `tasks/budget-dispatch.md` Step 6 (subagent spawn)
- **Found by:** Gemini 2.5 Pro + Mistral Large
- **Bug:** The prompt tells the subagent "NEVER push / NEVER merge / NEVER touch files outside project path." There's no technical control preventing any of those. A buggy subagent, a prompt-injection payload in a file the subagent reads, or a simple misunderstanding could cause a push to origin.
- **Fix options (pick one or stack them):**
  1. **Unset remote before dispatch:** Before spawning subagent, in the worktree: `git remote remove origin`. After verify+commit, restore: `git remote add origin <url>`. Makes push technically impossible during the session.
  2. **Pre-receive hook:** Install a local git hook in the auto-branch worktree that rejects any push attempt.
  3. **Explicit absolute-path constraints in subagent prompt** (Mistral's suggestion): "Do NOT edit any file outside `<PROJECT_PATH>/**`. If the task requires editing a file not under this path, STOP and report invalid-path."
- **Recommendation:** Do both #1 and #3. Defense-in-depth.

### H2. Worktree branch name collision in same-minute runs
- **Where:** `tasks/budget-dispatch.md` Step 6
- **Found by:** Mistral Large
- **Bug:** Branch name template `auto/<slug>-<task>-<YYYYMMDD-HHMM>` has minute-level resolution. Two runs in the same minute collide and git errors out.
- **Fix:** Use `<YYYYMMDD-HHMMSS>` or append a 4-char random suffix. Since dispatcher runs every 20 min, this is nearly impossible in practice, but it's a 1-character fix.

### H3. Race condition parsing live transcript writes
- **Where:** `scripts/estimate-usage.mjs` `usageEntries` stream parser
- **Found by:** Mistral Large
- **Bug:** The estimator reads `.jsonl` files while Claude Code may be actively writing them. A partial trailing line is possible. Current code skips corrupt lines silently via `try { JSON.parse(line) } catch { continue }`, which is OK for data integrity but could silently zero out legitimate usage if the whole file reads as corrupt.
- **Fix options:**
  1. **Retry-on-error:** If any file errors, retry after a short backoff.
  2. **Skip-last-line-on-active-file:** Detect files modified in the last 30 seconds and skip their last line (likely mid-write).
  3. **Accept current behavior and document:** The reserve floor catches this anyway. Document in the script comments.
- **Recommendation:** Option 2 is cheapest and handles the real-world case. Active-file detection via mtime is trivial.

---

## Medium-severity issues

### M1. Weekly "expected pct at pace" is hardcoded 100%
- **Where:** `scripts/estimate-usage.mjs` `buildSnapshot` near weekly calc
- **Found by:** Mistral Large
- **Observation:** The weekly calc assumes `weekly_expected_pct = 100` — i.e., if you're running at target, your 7-day rolling should total exactly 100% of weekly budget. This is fine as long as target burn is constant. If Perry's actual burn is spikier (weekends vs weekdays), the weekly headroom will flap.
- **Fix:** Add a `weekly.target_burn_pct_per_day` field in config, letting users set a different weekly target from the monthly one. Or: document the current assumption and move on.
- **Recommendation:** Document and move on. This is a second-order refinement.

### M2. `max_opportunistic_pct_per_run = 1.0` might be too aggressive
- **Where:** `config/budget.example.json`
- **Found by:** Mistral Large
- **Observation:** 1.0% per run × max 8 runs/day = up to 8% daily impact. Against a 15% monthly reserve, 2 bad days could nibble the reserve. Not catastrophic but worth tightening.
- **Fix:** Lower default to `0.5`.

### M3. Pro-cyclical pace detection (inherent trade-off)
- **Where:** `scripts/estimate-usage.mjs` bootstrap logic
- **Found by:** Gemini 2.5 Pro
- **Observation:** Using trailing-30 as baseline means after a vacation the baseline is low → system is conservative for weeks; after a crunch week the baseline is high → system is permissive. This is inherent to relative pace detection and not a bug, but users will be confused by it.
- **Fix:** Add a paragraph to README.md "Caveats" section explaining the dynamic. No code change needed.

### M4. README overclaims "cross-platform-safe"
- **Where:** `README.md` "Caveats and known limitations" section
- **Found by:** Gemini 2.5 Pro
- **Observation:** README says "Windows-first but cross-platform-safe. The estimator script itself is fully portable." That's true for the estimator but false for the dispatcher prompt (Linux-only activity gate per C4).
- **Fix:** Update caveat #3: "Estimator is portable; the dispatcher prompt's activity gate currently has GNU-date assumptions that break on Windows and macOS. See HANDOFF C4 for the fix."

### M5. Status directory hostility
- **Where:** `scripts/estimate-usage.mjs` `main` function
- **Found by:** Codestral
- **Observation:** If `status/` directory doesn't exist, estimator calls `die()`. This is deliberate (fail closed on broken install) but unfriendly for first-run users.
- **Fix (minimal):** Change the message to explicitly instruct the user: `die(\`status dir missing: \${statusDir}. Run: mkdir -p \${statusDir}\`)`. Don't auto-create — keep the fail-closed posture.
- **Fix (alternative):** Auto-mkdir with `{ recursive: true }`. Friendlier for first-run but loses the "broken install" signal.
- **Recommendation:** Codestral's auto-mkdir suggestion is reasonable. Accept it.

---

## Low-severity / style

- **L1.** Add a directory-type check: `existsSync(CLAUDE_PROJECTS_DIR) && statSync(...).isDirectory()` (Codestral)
- **L2.** Wrap `writeFileSync` in try/catch to log clean errors instead of uncaught throws (Codestral)
- **L3.** Add inline comment to `target_burn_pct_per_day` in example config warning not to set it to 0 (Gemini)
- **L4.** Empty-line skip: add `if (!line.trim()) continue;` before JSON.parse (Codestral) — currently skipped only via the `"usage"` prefilter which is a byte check, not a whitespace check

---

## Public-repo suitability — PASS

All three auditors agreed: no secrets, no PHI, no private data. `README.md` mentions "pmartin1915" and "Perry" — intentional and appropriate for a personal portfolio repo. `LICENSE` is clean MIT. `.gitignore` correctly excludes local `budget.json` and runtime state.

---

## Free-model audit roster reality (as of 2026-04-11)

This run probed 6 models. Only 3 returned usable reviews. The HANDOFF's cross-model signal is weaker than planned — only 2 vendor families (Google + Mistral) — but consensus on the critical bugs is still strong because 3 independent reviews converged on the same top-3 issues.

| Model | Result |
|---|---|
| `gemini-2.5-pro` (Google direct) | ✅ Full review, "hold for fixes" |
| `mistral-large-latest` (Mistral direct, free 1B tokens/mo) | ✅ Full review, "hold for fixes" |
| `codestral-latest` (Mistral direct, code-specialist) | ✅ Full review, "hold for fixes" |
| `nousresearch/hermes-3-llama-3.1-405b:free` (OpenRouter) | ❌ 429 rate-limited (8 rpm cap makes it nearly unusable) |
| `qwen/qwen3.6-plus-preview:free` (OpenRouter) | ❌ 404 endpoint not found |
| `nvidia/nemotron-3-super-120b-a12b:free` (OpenRouter) | ❌ NoneType error (provider endpoint broken) |
| `us.meta.llama3-3-70b-instruct-v1:0` (AWS Bedrock) | ❌ AWS credentials expired (`UnrecognizedClientException`) |

**Implications for future free-model audits:**
- OpenRouter `:free` tier is unreliable for parallel audits. Use sparingly, serially.
- AWS Bedrock is dead until Perry refreshes credentials (or never — "I doubt Amazon AWS still works but we can try").
- Mistral direct API (Mistral Large + Codestral + Mistral Small) is the reliable secondary after Google. Three models, one family — limited blind-spot coverage.
- **For true cross-family audits, deep-research chats in external tools (Perry's parallel chat instances) may outperform the PAL roster right now.**

See `~/.claude/projects/c--Combo/memory/reference_pal_free_model_audit_roster.md` for the updated tested roster.

---

## Suggested deep-research questions (for parallel chat instances)

Perry mentioned he can use separate deep-research chats. Here are the questions most likely to benefit from a different model's perspective, framed so you can paste them verbatim:

### Q1 — Baseline anchoring alternatives
> "I have a Node script (`estimate-usage.mjs`) that detects 'relative pace' of Claude Max subscription usage by anchoring a trailing-30-day weighted token cost against a user-declared target burn rate. The concern: this is pro-cyclical (after a vacation the baseline shrinks, making the system over-conservative; after a crunch week it over-permits). What alternative baseline schemes are commonly used in relative-usage systems — EMA, rolling percentile, Kalman, seasonally-adjusted? Please compare 2–3 that would fit this use case with concrete formulas, and tell me which you'd pick and why for a user whose actual usage oscillates between exam weeks (heavy) and clinical weeks (light)."

### Q2 — Technical enforcement of "never push" constraint
> "I have a Claude Code subagent that runs autonomous work inside a git worktree and is prompt-instructed to 'NEVER push to origin / NEVER merge to main.' I want to add technical enforcement so a buggy or prompt-injected subagent physically cannot push. Options I'm considering: (a) `git remote remove origin` before spawning, restore after; (b) git pre-receive hook that rejects; (c) wrap the subagent in a subprocess with a custom PATH that shadows `git` with a filter. For each: what are the failure modes, bypass surface, and operational cost? Recommend the minimum viable defense-in-depth stack."

### Q3 — Windows-safe file-mtime activity detection
> "In a Node script running on Windows 11 (also needs to work on macOS/Linux), I need to detect whether any `.jsonl` file in a recursive directory has been modified within the last 20 minutes. Currently I'm using `find -newermt '20 minutes ago'` (GNU only). What's the idiomatic Node approach? Show me a minimal implementation using `fs.statSync.mtimeMs` and a generator-based directory walk. Any gotchas around locked files or symlinks on Windows?"

### Q4 — Dual-period budget gate design review
> "Review this budget gate design: the user has a monthly Claude Max quota. I enforce TWO gates simultaneously — a monthly pace gate (fires if month-to-date usage exceeds pace + reserve floor) and a rolling-7-day weekly gate (fires if last-7-days exceeds weekly pace + reserve floor). Both must pass for a dispatcher to run. The weekly is stricter, so it 'wins' in practice. Question: is there a known name for this pattern? Is it better or worse than a single monthly EMA gate with stricter short-term smoothing? What edge cases am I missing around month-boundary transitions when the weekly window straddles the reset?"

### Q5 — Anthropic Admin Usage API as alternative data source
> "Does the Anthropic API expose a documented endpoint for querying current Claude Max (subscription) usage programmatically? Not the billing-API historical usage, but something like 'here's how much of this user's monthly subscription allotment they've consumed.' If yes, give me the endpoint + required scopes + example response shape. If no, confirm that so I can stop looking. I currently estimate usage by scanning ~/.claude/projects transcripts for `.message.usage` fields — is that still the best local estimator in 2026?"

---

## Execution plan for next session

1. **Apply critical fixes** (C1–C4). Each is 5–20 lines of code. Test locally by running `node scripts/estimate-usage.mjs` on Perry's real transcripts — should already report "insufficient-history-for-bootstrap" correctly on a fresh `~/.claude/projects` directory (test with `CLAUDE_PROJECTS_DIR` override env var if added).
2. **Apply high-severity fixes** (H1–H3). H1 (technical enforcement) is the heaviest lift — probably 30–50 lines including remote unset/restore ceremony. H2 and H3 are one-line fixes.
3. **Re-run the estimator** against Perry's real data. Confirm the output changes make sense (e.g., the gate should still block for Perry right now given his exam-week burn).
4. **Cross-model re-audit** with the now-working 3-model Google+Mistral roster. Convergent PASS → flip `dry_run: false` in a controlled way (start with one project).
5. **Write the dev-ops integration** — the standalone repo is public, but Perry's personal combo framework at `c:/Users/perry/DevProjects/dev-ops/` has its own copies. Sync the fixes back.

---

## What NOT to change without discussion

These were deliberate choices that might look wrong in a review but were intentional:

- **`dry_run: true` as default.** Keep it. The repo should ship defaulting to no-op observation mode so first-run users can't hurt themselves.
- **Trailing-30-day anchoring** vs absolute quota API. There's no quota API; this is the best we can do. Q5 above asks deep-research to double-check.
- **Local-auto-branch-only commit policy.** Perry explicitly locked this in plan mode. Do not add auto-push even if "convenient."
- **No fixed-hours allow-list in activity_gate.** Perry explicitly chose activity-gated only, no hours window. Don't add hours back.
- **The two-layer architecture** (Node estimator + Claude dispatcher prompt). The whole point of the Node layer is zero-cost no-op. Do not fold everything into one Claude prompt.

---

## Reviewer checklist (for you, future Perry, or another Claude session)

- [ ] Pull `main` and read `HANDOFF.md` (this file)
- [ ] Read `scripts/estimate-usage.mjs` top-to-bottom
- [ ] Read `tasks/budget-dispatch.md`
- [ ] Apply C1–C4 in one commit labeled `fix: critical cold-start, timezone, activity-gate, config guards`
- [ ] Apply H1–H3 in a second commit labeled `fix: technical enforcement + race + collisions`
- [ ] Run `node scripts/estimate-usage.mjs` and confirm behavior
- [ ] Re-audit via `mcp__pal__chat` on gemini-2.5-pro + mistral-large-latest + codestral-latest with the same prompt. Convergent PASS → ready
- [ ] Update `README.md` caveats section per M4
- [ ] Remove this HANDOFF.md OR move it to `docs/HANDOFF-2026-04-11.md` as a historical record
- [ ] Tag `v0.1.0-pre-live` on the final dry-run commit before any real-work runs

---

## Appendix — Full audit outputs

Condensed above. Full per-model transcripts preserved in `~/.claude/projects/c--Users-perry-DevProjects-combo/` transcripts from session 2026-04-11.

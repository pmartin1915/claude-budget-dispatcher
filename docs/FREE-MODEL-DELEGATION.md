# Free-Model Delegation

> How the Budget Dispatcher routes work to free-tier models (Gemini, Mistral, Codestral) via PAL MCP to minimize Claude Max subscription burn.

## The two costs we're cutting

| Cost | Where it lives | How delegation helps |
|---|---|---|
| **Subscription usage** | Claude Max monthly quota | Entire tasks run on free-tier models; zero Claude Max tokens consumed for the work itself |
| **Context usage** | Tokens inside a single Claude session | Claude asks PAL to read/summarize files instead of Reading them directly; the files never enter Claude's context window |

Both use the same PAL plumbing (`mcp__pal__chat`, `mcp__pal__codereview`, etc.). Both matter. They hit in different places — subscription usage reduction is the dispatcher's primary win; context usage reduction applies to every Claude session including interactive ones.

## The roster (verified 2026-04-11)

| Task class | Delegate to | Why |
|---|---|---|
| `explore` | `gemini-2.5-pro` | 1M context, reads files via `absolute_file_paths`, returns 300-token summary |
| `audit` | `gemini-2.5-pro` via `pal codereview` | Critical findings flagged, existing default |
| `research` | `gemini-2.5-pro` or `mistral-large-latest` | Open-ended reasoning on docs/web context |
| `tests_gen` | `codestral-latest` | Code-specialized, best for vitest/jest scaffolding |
| `refactor` | `codestral-latest` | Deterministic code transforms (rename, extract, move) |
| `docs_gen` | `mistral-large-latest` | Generalist, great for JSDoc + README + changelog |
| `plan` / `design` / `architecture` | **Claude Max only** | Needs multi-file reasoning + judgment |
| `clinical` / `security` / `safety` | **Claude Max only, NEVER delegate** | Hard rule |

Configure in `config/budget.json` under `free_model_roster.classes`.

## ⛔ Forbidden models

Three categories of models must never be used autonomously, even if a prompt or stale config names them:

| Model | Why forbidden |
|---|---|
| `gemini-3-pro-preview` | **Separate Google Cloud billing** — bills against Perry's ~$900 credit pool, not the free tier. Do not use. |
| OpenRouter `:free` tier models (hermes, qwen, nemotron) | Rate-limited to 8 rpm, endpoints broken or unreliable as of 2026-04-11 |
| AWS Bedrock models | Credentials expired |

The `free_model_roster.forbidden_models` array is enforced in Step 5.5 of the dispatcher prompt. If a task resolves to a forbidden model, the dispatcher refuses with `outcome: "error"`, `reason: "forbidden-model-in-roster"`.

## How a delegated run looks

1. Estimator runs (free, Node-only). Gate green.
2. Activity gate passes (free, Node-only). User is idle.
3. Daily quota OK.
4. Dispatcher picks project `wilderness` and task `audit`.
5. **Step 5.5:** `task_class = "audit"` → `delegate_to = "gemini-2.5-pro"` (from roster).
6. Forbidden-model check: `gemini-2.5-pro` not in forbidden list. Pass.
7. PAL health check: `mcp__pal__version` returns 9.8.2. Pass.
8. **Step 6 Branch B:** dispatcher calls `mcp__pal__codereview` directly with `model: "gemini-2.5-pro"`, `relevant_files: [...wilderness src files]`.
9. Gemini returns findings.
10. Dispatcher parses findings, verifies no critical, commits `[opportunistic][pal:gemini-2.5-pro] audit: weekly codereview clean` to `auto/wilderness-audit-...`.
11. Logs `delegated_to: "gemini-2.5-pro"`, `pal_tokens_estimated: <n>`.

**Claude Max tokens consumed:** just the orchestration (~2-5K tokens for the dispatcher prompt run). The actual audit work — reading hundreds of files, reasoning about findings — is 100% free-tier.

## How a Claude Max run looks (for comparison)

Same run with `delegate_to: "claude"`:

1–7. Same as above.
8. **Step 6 Branch A:** dispatcher spawns a Task-tool subagent with `subagent_type: "general-purpose"`.
9. Subagent Reads files, runs Bash tests, edits code, calls Claude repeatedly.
10. Subagent returns report. Dispatcher verifies, commits.

**Claude Max tokens consumed:** ~50-200K tokens (dispatcher orchestration + subagent's full work + iterations). A 10-40x multiplier vs Branch B.

## Fallback policy

`free_model_roster.on_pal_error` controls what happens when PAL is unreachable:

- `"skip"` (default, safest): log `outcome: "skipped"`, `reason: "pal-unreachable"`, exit. Zero Claude Max cost. This matches the framework's fail-closed philosophy.
- `"claude_fallback"`: log a warning, switch to Branch A (Claude Max subagent), continue. Higher availability but burns subscription tokens on days when PAL is flaky.

Start with `"skip"`. Only switch to `"claude_fallback"` if PAL reliability becomes a sustained problem (which, as of 2026-04-11, it is not — all three roster models are healthy when tested directly).

## DISPATCH.md schema extension

Each rotation project's `DISPATCH.md` gains an optional `Delegate To` column in the Pre-Approved Tasks table:

```markdown
| Task Keyword | Command | Success Criteria | Delegate To |
|-------------|---------|-----------------|-------------|
| test     | npm test               | pass           | claude |
| audit    | pal codereview src/    | no critical    | gemini-2.5-pro |
| docs-gen | JSDoc missing exports  | doc coverage   | mistral-large-latest |
```

If a row omits the column, the dispatcher infers the class from the keyword (see `tasks/budget-dispatch.md` Step 5.5 step 2).

**Clinical gate overrides delegation.** If the project has `clinical_gate: true` (burn-wizard) or a content-safety gate (wilderness `src/data/` + `src/calculators/`), the dispatcher forces `delegate_to: "claude"` regardless of the roster. Safety-critical logic is never delegated to a free model.

## Expected savings

Back-of-envelope for a full week of opportunistic runs:

| Scenario | Runs/day | Tokens/run | Weekly Claude Max cost |
|---|---|---|---|
| **All Claude Max (pre-delegation)** | 8 | 100K avg | 5.6M tokens |
| **Mixed (audit/docs/tests delegated, impl on Claude)** | 8 | 25K avg | 1.4M tokens |
| **Fully delegated (audit/research/docs only)** | 8 | 8K avg | 450K tokens |

Roughly **4-12x** reduction in subscription burn depending on task mix. Combined with the existing dual-period reserve floor, this makes it realistic to run the dispatcher aggressively without threatening Perry's interactive work headroom.

## Verification

Test that delegation is working by watching `status/budget-dispatch-log.jsonl`:

```bash
tail -f status/budget-dispatch-log.jsonl | grep delegated_to
```

Each run should show either `delegated_to: "claude"` (for plan/clinical/implementation tasks) or `delegated_to: "gemini-2.5-pro"` / `codestral-latest` / `mistral-large-latest` (for audit/explore/docs/tests/refactor).

If every run shows `"claude"` even for audits, the roster isn't being consulted — check `free_model_roster.enabled == true` in budget.json.

## References

- `config/budget.example.json` — `free_model_roster` block
- `tasks/budget-dispatch.md` — Step 5.5 routing, Step 6 branches
- `~/.claude/WORKFLOW.md` — global workflow rules for interactive sessions
- `docs/HANDOFF-2026-04-11.md` — original cross-model audit that established the roster

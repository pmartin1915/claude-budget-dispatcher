# Dispatcher Overseer (Pillar 1 steps 3+4 — gates 5+6)

Out-of-band reviewer for dispatcher-authored draft PRs.
Gates 5 (read-only review) + 6 (cooling-off + ready-flip + merge) of the seven-gate stack from `worldbuilder/VEYDRIA-VISION.md` Pillar 3.

> Gate 5 is **always on** when the Overseer is enabled — labels every draft PR with `overseer:approved | overseer:rejected | overseer:abstain`. Gate 6 (auto-merge) is dormant by default and requires explicit opt-in at both `auto_merge: true` (top-level) AND per-repo `auto_merge: true`. See `AUTO-MERGE.md` for the gate-6 lifecycle, opt-in procedure, and operator action matrix.

## Why this exists

Gates 1 (path firewall), 2 (tests green), 3 (in-line cross-family audit), and 4
(canary success) all run inside the dispatcher's own commit pipeline. They catch
syntactic regressions and basic invariants. What they cannot catch is a
**semantic** drift — code that compiles, passes its tests, and clears the canary
but doesn't actually achieve what the PR body claimed, or introduces a subtle
contract regression a unit test wouldn't notice.

The Overseer reads the diff and the PR body together and asks a model from the
**opposite family** of whatever generated the PR: *did this change actually do
what the bot said it would?*

Read-only by default: the Overseer **labels** the PR with its verdict. When
`auto_merge: true` is set at BOTH the top level and the per-repo entry in
`overseer.repos`, the bot enters gate 6: cooling-off, ready-flip, merge. The
label-only mode remains the fallback path; any project not opted in stays
advisory-only. See `AUTO-MERGE.md` for gate-6 details.

## How it works

1. GitHub Actions runs `node scripts/overseer.mjs` every 2 hours (and on
   manual `workflow_dispatch`).
2. The script reads `OVERSEER_REPOS` (a comma-separated `owner/repo` list)
   and for each repo lists open draft PRs that carry the `dispatcher:auto`
   label.
3. **Idempotency check.** For each candidate, the Overseer fetches the PR's
   issue events to find the latest `overseer:*` label timestamp. If that
   timestamp is at-or-newer than the PR's head commit's `committer.date`,
   the SHA has already been reviewed and the Overseer skips (no PAL spend).
   Re-review fires only when the dispatcher pushes a new commit advancing
   the head.
4. **Cross-family selection.** The PR's `model:<name>` label (or fallback
   PR-body line) names the generating model. The Overseer picks the
   **opposite family** for review:
   - `gemini-*` generated → audit with `mistral-large-latest`
   - `mistral-*` / `codestral-*` generated → audit with `gemini-2.5-pro`
   - Anything else (Groq/OpenRouter/Ollama/unknown) → **abstain** (we never
     pick a default family silently — that would silently violate the
     C-1 anti-monoculture rule from `combo/ai/DECISIONS.md` 2026-04-14).
5. **Semantic review.** The Overseer fetches the PR diff (truncated to
   `max_diff_chars`, default 50000), builds a structured-JSON prompt
   asking *"does the diff achieve what the body claimed?"*, and posts to
   the appropriate provider's REST endpoint (Gemini `generateContent` or
   Mistral `chat/completions`).
6. **Verdict labeling.** The audit model's JSON is parsed into one of three
   verdicts:
   - `overseer:approved` — diff matches the body claim, no semantic
     regressions detected.
   - `overseer:rejected` — diff demonstrably breaks the claim or
     introduces a critical regression.
   - `overseer:abstain` — ambiguous, low confidence, or the audit model
     errored / hit quota. **Quota-exhausted is always abstain, never
     rejected.** The previous overseer label (if any) is removed before
     the new one is added.
7. The PR stays **draft**. The label is the only artifact. A human (you)
   marks ready and merges by hand.

## Hosting independence

`scripts/overseer.mjs` is **pure Node, zero npm deps, zero imports from
`scripts/lib/*`.** Helpers (`asciiSafeHeader`, `providerFamily`, the JSONL
appender, family detection, quota-detection) are duplicated inline rather
than imported. The watchdog uses the same posture for the same reason: if
the dispatcher engine is broken, the Overseer must still run.

## Setup (one-time)

### 1. Add labels to each rotation repo

The Overseer's three labels are added to the canonical list in
`scripts/setup-labels.mjs`. Run:

```bash
node scripts/setup-labels.mjs
```

This is idempotent — existing labels return *"already exists"* which the
script swallows.

### 2. Add four secrets

At <https://github.com/pmartin1915/budget-dispatcher/settings/secrets/actions>:

| Secret | Value |
|---|---|
| `OVERSEER_REPOS` | Comma-separated list of `owner/repo`, e.g. `pmartin1915/burn-wizard,pmartin1915/wilderness`. Empty value disables. |
| `OVERSEER_GH_TOKEN` | A GitHub PAT (fine-grained or classic) with `pull_request: read+write` and `contents: read` scope on the repos in `OVERSEER_REPOS`. The default `GITHUB_TOKEN` cannot label PRs across repos. |
| `GEMINI_API_KEY` | Same key the dispatcher uses. Used to call Gemini when the PR was generated by Mistral. |
| `MISTRAL_API_KEY` | Same key the dispatcher uses. Used to call Mistral when the PR was generated by Gemini. |

### 3. Flip the kill switch (when ready)

In `config/local.json` (or `shared.json`):

```json
"overseer": {
  "enabled": true,
  "repos": ["pmartin1915/burn-wizard", "pmartin1915/wilderness"],
  "review_model": "gemini-2.5-pro",
  "max_diff_chars": 50000,
  "abstain_below_confidence": "medium"
}
```

Default `enabled: false` keeps the workflow running every 2h but exits as a
no-op until you flip it on.

## Verifying it works

After secrets are set, trigger the workflow manually:

1. Go to <https://github.com/pmartin1915/budget-dispatcher/actions>.
2. Pick **Dispatcher Overseer** in the left sidebar.
3. Click **Run workflow** → optionally set `pr_number` and `repo` for a
   single-PR smoke test → **Run workflow**.

The "Run Overseer" step prints one line per processed PR:

```
[overseer] pmartin1915/burn-wizard#42 -> approved (approved)
[overseer] pmartin1915/wilderness#7 -> skipped (already-reviewed:overseer:approved)
[overseer] no PRs processed this run
```

## How to interpret labels (operator's quick reference)

| Label | What it means | What you should do |
|---|---|---|
| `overseer:approved` | Audit model says diff matches the PR body's claim and no semantic regression was detected. | If `auto_merge: true` is opted in for this repo, the bot will ready-flip + merge after `cooling_off_minutes` (default 45). Otherwise, the label is *advisory* and manual review/merge is still required. See `AUTO-MERGE.md`. |
| `overseer:rejected` | Audit model says the diff breaks the body's claim or introduces a critical regression. | Read the JSONL `summary` field. Either close the PR or push a fixup commit (which retriggers review on next cron tick). Auto-merge is NEVER triggered on rejected PRs regardless of opt-in. |
| `overseer:abstain` | Audit model couldn't decide — low confidence, ambiguous family, or quota-exhausted. | Manual review required. The label is **not** a failure signal; it's just *"the bot couldn't help here"*. Auto-merge is NEVER triggered on abstained PRs. |
| `overseer:ready-flipped` | **Sentinel** (gate 6). The bot flipped the PR ready-for-review after cooling-off elapsed and is queued to merge on the next tick (or immediately if `cooling_off_minutes_after_ready: 0`). | None — bot owns the next step. To intervene, leave a comment or convert back to draft; either signal blocks the merge. |
| `overseer:merged` | **Sentinel** (gate 6). The bot merged the PR. Gate 7 (post-merge canary monitor) now owns the next 24h. | None — watch for `post-merge-canary` outcomes in JSONL. A failed replay will auto-suspend `auto_push` for the project's slug. See `AUTO-MERGE.md`. |

## Disabling

Three escape hatches, in increasing severity:

1. **Empty `OVERSEER_REPOS` secret** — the workflow runs but `runOverseer`
   logs `no-repos-configured` and exits. Zero API spend.
2. **Set `overseer.enabled: false` in `local.json`** — kept for future
   wiring; the workflow itself does not currently read this field, so
   prefer option 1 today.
3. **Delete `.github/workflows/overseer.yml`** — total removal.

## Failure modes

| Failure | Behavior |
|---|---|
| GitHub 403 (rate limit) | Log-and-skip the affected PR. Other repos still process. |
| GitHub 404 (PR closed/deleted between list and review) | Log-and-skip. |
| GitHub 422 (label add conflict) | Treated as success. The label is on the PR; that's the win. |
| PAL quota-exhausted (HTTP 429) | Verdict = `abstain`, reason `quota-exhausted`. **Never** mapped to `rejected`. |
| PAL network error | Verdict = `abstain`, reason `pal-error`. |
| Audit model returns malformed JSON | Verdict = `abstain` (parse fallback). |
| `overseer.mjs` itself throws | Top-level wrapper catches, logs `internal-error`, returns 0 exit. The dispatcher cron is independent and unaffected. |

The Overseer is read-only. Every failure mode is fail-soft.

## JSONL log shape (`status/budget-dispatch-log.jsonl`)

Each processed PR produces one entry:

```json
{
  "ts": "2026-04-27T14:00:00.000Z",
  "phase": "overseer",
  "engine": "overseer.mjs",
  "outcome": "approved",
  "reason": "approved",
  "repo": "pmartin1915/burn-wizard",
  "pr_number": 42,
  "pr_url": "https://github.com/pmartin1915/burn-wizard/pull/42",
  "head_sha": "abcd1234",
  "task": "audit",
  "model_used": "gemini-2.5-pro",
  "audit_model": "mistral-large-latest",
  "summary": "<=500 chars",
  "confidence": "high",
  "issue_counts": { "critical": 0, "high": 1, "medium": 2, "low": 3 },
  "label_outcome": { "added": true, "label": "overseer:approved" }
}
```

On Actions runs the JSONL goes to the runner's ephemeral `status/` directory
(not persisted). The `console.log` lines mirror the same outcome for the
Actions logs. On local CLI runs the JSONL appends to the dispatcher repo's
real `status/` directory same as `dispatch.mjs`.

## Architecture notes

- Idempotency uses GitHub-side state (label events) rather than the
  ephemeral JSONL log so it works on fresh `actions/checkout` runners.
- Sequential PR processing (no parallel) keeps the GitHub API budget
  predictable: ~5 calls per PR × ~25 PRs/repo × N repos. At 5000 req/hr
  authenticated, well-bounded.
- Tests at `scripts/lib/__tests__/overseer.test.mjs` inject `gh`,
  `palCallFn`, and `appender` via parameters — no network, no FS.

# Plan — smooth error handling + laptop-to-PC auto-update

**Author:** Opus 4.7 (PC), 2026-04-21
**Trigger:** Today's silent 10-hour selector outage on perrypc (`selector_model: gemini-2.5-pro` + `thinkingBudget: 0` incompatibility). ntfy never paged; health showed `idle`, not `degraded`. Discovered only because Perry manually resumed the session and looked at the dispatch log.

## Goals

1. When a dispatcher starts silently failing, **ntfy fires within ~1 hour** and the alert body names the root cause.
2. One file, one grep — Perry can answer "why did perrypc stop dispatching?" in under 30 seconds from any machine.
3. Perry codes on laptop, commits + pushes, and the PC fleet **picks up the change on the next cycle** without him SSHing or spinning up a CC instance on each PC.

## Non-goals

- No new alerting channels (ntfy stays the only notifier).
- No push-based fleet sync (GitHub Actions webhook → PC polling). Pull-on-cycle is sufficient and simpler.
- No retry-mid-cycle for selector. If selector fails, this cycle skips, next cycle retries. This is already correct behavior.

---

## Root cause of today's blind spot

[scripts/lib/health.mjs:45-54](../scripts/lib/health.mjs#L45-L54) counts `outcome === "error"` toward `consecutiveErrors`. But [scripts/dispatch.mjs:189-194](../scripts/dispatch.mjs#L189-L194) writes selector-failures as `outcome: "skipped", reason: "selector-failed"` — structurally identical to benign skips like `user-active` or `budget-below-headroom`. [health.mjs:61-65](../scripts/lib/health.mjs#L61-L65)'s `recentAllSkips` collapses every skip reason into one bucket, so 10 hours of broken selector looked identical to 10 hours of legitimate keyboard-active gating.

[scripts/lib/alerting.mjs:108](../scripts/lib/alerting.mjs#L108) then only fires on transitions to `down`, which requires 3 consecutive `outcome === "error"` entries — a state selector failures structurally can't reach.

The fix is to treat **"the dispatcher tried to do work and broke"** as a different class of skip from **"the dispatcher chose not to work"**.

---

## Phase 1 — Capture error detail in the log (observability floor)

Without this, phases 2 and 3 are blind. No risk surface: add-only fields to the JSONL log and fleet entry.

### 1a. Thread error detail out of the selector

[scripts/lib/selector.mjs:298-342](../scripts/lib/selector.mjs#L298-L342) — `callGeminiWithRetry` currently throws a plain `Error("Gemini returned empty response text")` after 3 retries. The caller at [scripts/lib/selector.mjs:155-157](../scripts/lib/selector.mjs#L155-L157) logs to stderr and returns null. The outer [scripts/dispatch.mjs:186-197](../scripts/dispatch.mjs#L186-L197) writes the skip entry but doesn't know what failed or why.

**Change:** `callGeminiWithRetry` returns `{ text, model, retries }` on success and throws an error with a structured `.details` property on failure:

```javascript
const err = new Error("selector gemini call failed");
err.details = { model, retries, last_api_error: lastErr.message, root_cause: "empty_response" };
throw err;
```

`selectProjectAndTask` catches and attaches `.selector_error_details` to its null-return path (via a thread-local or by returning an object with `{ pick: null, error: {...} }` instead of bare null — the latter is less stateful).

### 1b. Extend the JSONL entry on selector-failed

[scripts/dispatch.mjs:189-194](../scripts/dispatch.mjs#L189-L194). Current shape:

```json
{"ts":"...","outcome":"skipped","reason":"selector-failed","phase":"selector","engine":"dispatch.mjs"}
```

Target shape:

```json
{"ts":"...","outcome":"skipped","reason":"selector-failed","phase":"selector","engine":"dispatch.mjs",
 "error_detail":"empty_response","error_model":"gemini-2.5-pro","error_retries":3,
 "error_message":"Gemini returned empty response text"}
```

Every field is optional — downstream readers must not break on absence.

### 1c. Fleet entry surfaces the detail

[scripts/lib/fleet.mjs:63-67](../scripts/lib/fleet.mjs#L63-L67) only captures entries with `outcome === "error"` or `"reverted"` into `last_error_*`. Broaden to also capture `outcome === "skipped" && reason === "selector-failed"` entries. This is the single change that lets Perry run `gh gist view <id> -f fleet-perrypc.json` and see `last_error_reason: "selector-failed"` with the detail — from his phone, from any machine.

New fields on the fleet entry: `last_error_detail`, `last_error_model` (copied through from the JSONL).

### Rollout order

1a → 1b → 1c can land in one commit. No config changes. No behavior change for healthy machines.

---

## Phase 2 — Make ntfy fire on structural skip-storms

Once Phase 1 is in, we can distinguish `selector-failed` from `user-active`. Now teach the health/alerting state machine to care.

### 2a. New health state: `degraded`

[scripts/lib/health.mjs:67-89](../scripts/lib/health.mjs#L67-L89) — add a state between `healthy` and `down`:

```
degraded: last N cycles contain ≥M selector-failed (or other "tried-and-broke" skips),
          but consecutive error streak hasn't hit DOWN_ERROR_STREAK.
```

Suggested defaults: N=6, M=3 (i.e. in the last 6 real outcomes, 3+ were structural failures). Expose both as `shared.json` keys — but **do not** edit shared.json in this phase; ship the code with defaults and let Perry opt-in later.

State precedence (highest to lowest): `down` → `degraded` → `idle` → `healthy`. If both conditions fire (e.g. 3 selector-failed AND 13h since success), `down` wins.

### 2b. Split `recentAllSkips` by skip class

Today [health.mjs:61-65](../scripts/lib/health.mjs#L61-L65) counts any skipped outcome as evidence of idleness. Introduce a distinction inside the function (no API change):

- **benign skips:** `user-active`, `paused`, `budget-below-headroom`, `no-eligible-projects` (rotation empty)
- **structural skips:** `selector-failed`, `router-failed`, anything with `phase !== "gate"` and `outcome === "skipped"`

`recentAllSkips` remains the idle test, but only benign skips count. A tail full of structural skips is not idle — it's degraded.

### 2c. Alerting fires on healthy→degraded

[scripts/lib/alerting.mjs:108-117](../scripts/lib/alerting.mjs#L108-L117). Add `"degraded"` to the default `on_transitions` list alongside `"down"`. The ntfy body should name the failure, e.g.:

```
perrypc: degraded — 4 selector-failed in last 6 cycles
model=gemini-2.5-pro retries=3 error="empty response"
```

Pull `error_detail`, `error_model`, `error_message` from the most recent matching JSONL entry to build the body. This is what makes the alert actionable from a phone — Perry sees the model name and `empty_response` and immediately knows it's the thinkingBudget regression, not a quota issue.

### 2d. Heartbeat rule tweak

[alerting.mjs:119-134](../scripts/lib/alerting.mjs#L119-L134) currently pings only when state is `healthy`. That's correct — degraded/down have their own transition alert. Leave heartbeat behavior alone.

### Rollout order

2a → 2b → 2c can land in one commit. Requires Phase 1 already merged. No config changes in the commit itself.

Once merged, Perry can tune thresholds in shared.json (e.g. `degraded_window: 6`, `degraded_threshold: 3`) after observing real signal.

---

## Phase 3 — Laptop push → PC auto-update

The mechanism is intentionally dumb: each cycle, the wrapper tries `git pull --ff-only` before invoking `dispatch.mjs`. If the pull succeeds, the new code runs this cycle. If it fails, the current code runs, and a diagnostic is logged — Phase 2 alerting catches any resulting failures.

### 3a. Stop dispatcher state from blocking pulls

Two changes to [.gitignore](../.gitignore):

Currently gitignored (lines 11–15): `status/usage-estimate.json`, `status/budget-dispatch-log.jsonl`, `status/budget-dispatch-last-run.json`, `status/health.json`, `status/fleet-*.json`.

**Add:** `status/alerting-state.json`, `status/merge-tracker.json`.

`merge-tracker.json` was going to be the pull blocker every time (I had to stash it manually twice today just to pull). Making it gitignored means each machine maintains its own copy via `npm run track-merges`, and the selector reads the local one.

Trade-off: we lose cross-machine visibility into which branches got merged. Mitigation: have `track-merges.mjs` also write a compact summary to the gist (e.g. `fleet-merges-<hostname>.json`) so selector prompts on other machines can see aggregated merge-rate. This is a follow-up, not part of this phase.

### 3b. Wrapper auto-pull block

[scripts/run-dispatcher.ps1](../scripts/run-dispatcher.ps1) — after the mutex acquisition (~line 211) and before engine selection (~line 250), insert:

```powershell
# --- Auto-update: fetch and fast-forward if behind
Write-Log "checking for upstream updates"
try {
    git -C $RepoRoot fetch origin main --quiet
    $local  = (git -C $RepoRoot rev-parse HEAD).Trim()
    $remote = (git -C $RepoRoot rev-parse origin/main).Trim()
    if ($local -ne $remote) {
        $ahead  = (git -C $RepoRoot rev-list --count origin/main..HEAD).Trim()
        $behind = (git -C $RepoRoot rev-list --count HEAD..origin/main).Trim()
        if ($ahead -eq "0" -and $behind -ne "0") {
            Write-Log "pulling $behind new commit(s) from origin/main"
            git -C $RepoRoot pull --ff-only --quiet
            if ($LASTEXITCODE -eq 0) {
                $newHead = (git -C $RepoRoot rev-parse --short HEAD).Trim()
                Write-Log "fast-forwarded to $newHead"
            } else {
                Write-Log "pull --ff-only failed (exit $LASTEXITCODE); continuing with local code" 'warn'
            }
        } elseif ($ahead -ne "0") {
            Write-Log "local is $ahead ahead of origin; skipping auto-update (uncommitted work)" 'warn'
        }
    }
} catch {
    Write-Log "auto-update error: $_; continuing with local code" 'warn'
}
```

Properties:
- **No stash dance needed** once 3a is in (status files are gitignored).
- **Ahead-of-remote short-circuit** protects the handoff-commit pattern (I'm currently 1 ahead of origin with an unpushed doc commit — auto-pull must not touch that).
- **Network flake ≠ dispatch failure.** Any error in the pull block logs a warning and falls through. The cycle proceeds with whatever code the machine has.
- **Fires per-cycle**, so a laptop push at 12:00 lands on perrypc by 12:20 (next scheduled tick) and on any machine that pulls before its cycle.

### 3c. Log what was picked up

Every cycle that pulls should emit a JSONL entry:

```json
{"ts":"...","outcome":"auto-update","from":"7764729","to":"c08695d","phase":"pre-dispatch"}
```

Purpose: when the laptop pushes a regression, the post-incident grep is:

```bash
grep auto-update status/budget-dispatch-log.jsonl | tail -5
```

and the breaking commit is right there.

This requires a small shim: the PowerShell wrapper can't easily append to the JSONL directly (encoding + atomicity concerns on Windows). Cleanest path: have the wrapper pass `--pre-dispatch-event='{"ts":...,"outcome":"auto-update",...}'` to `dispatch.mjs`, which appends it to the log on startup. That's a 10-line addition to [scripts/dispatch.mjs](../scripts/dispatch.mjs).

### 3d. Scheduled-task hygiene

No changes to scheduled task registration. The wrapper already handles its own mutex. Auto-update happens in-wrapper, so there's no race between pull and dispatch.

**One caveat:** if the laptop pushes a change to `run-dispatcher.ps1` itself, the next cycle picks up the new wrapper *on the subsequent run* (the currently-executing wrapper finishes with the old code). That's acceptable.

### Rollout order

Phase 3 requires Phase 1+2 already merged and **manually** deployed to every PC in the fleet (so that when 3b starts auto-pulling, the telemetry is already in place to catch a bad push). Order within Phase 3: 3a → 3b → 3c.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Phase 1 JSONL schema change breaks downstream readers (fleet.mjs, dashboard HTML, third-party grep) | All new fields optional. Readers must handle `undefined` — verify dashboard parsing before merge. |
| Phase 2 `degraded` state defaults page too aggressively during transient Gemini hiccups | Thresholds tuned conservatively (3 structural skips in 6 cycles = at least 1h of continuous failure). Configurable via shared.json if it's noisy. |
| Phase 3 auto-pull brings in a breaking commit; every PC fleet-wide goes silent | Phase 2 alerting catches it within ~1h. Recovery is a laptop revert push + wait one cycle. The wrapper's "continue on pull failure" property means no fleet-wide boot loop. |
| Merge-tracker gitignored means PCs lose cross-machine merge visibility | Follow-up: sync compact merge summary via gist (noted above). Not blocking for this phase. |
| Wrapper runs `git fetch` every cycle, adding ~1-2s and occasional network noise | Acceptable. `fetch --quiet` against origin is lightweight. Offline PCs log the warning and proceed. |
| Perry's local handoff commits (currently `290fd8d` unpushed) interfere with pull | 3b's ahead-check skips auto-update if local is ahead. Handoff pattern preserved. |

---

## Verification

### Phase 1
- Induce a selector failure (point `selector_model` at a garbage model name, run `--force --dry-run`).
- Check: JSONL tail entry has `error_detail`, `error_model`, `error_message`.
- Check: `fleet-<host>.json` in gist has populated `last_error_*` fields.
- Revert the config change.

### Phase 2
- Keep the broken selector config for 6 forced cycles (or mock the log).
- Check: `health.json` transitions `healthy → degraded` at exactly the configured threshold.
- Check: ntfy fires exactly once on the transition (not every cycle).
- Check: alert body contains model name + error detail.

### Phase 3
- From laptop, make a trivial commit (e.g. add a comment), push to origin/main.
- On any PC, wait one scheduled cycle OR run `scripts/run-dispatcher.ps1` manually.
- Check: wrapper log shows `fast-forwarded to <new-sha>`.
- Check: JSONL has the `auto-update` entry with from/to SHAs.
- Check: `git log -1` on PC matches laptop's new tip.

### End-to-end regression guard
- After all three phases deployed, simulate today's incident: revert `c08695d` on laptop, push, wait ~90 min.
- Expect: ntfy pages all three machines with "degraded — selector-failed — gemini-2.5-pro empty response".
- Laptop re-pushes the fix; fleet self-heals within one cycle; no manual PC touch.

---

## Files touched

| Phase | File | Change type |
|---|---|---|
| 1 | `scripts/lib/selector.mjs` | Extend `callGeminiWithRetry` return / error shape |
| 1 | `scripts/dispatch.mjs` | Thread error detail into JSONL entry on selector-failed |
| 1 | `scripts/lib/fleet.mjs` | Capture selector-failed skips into `last_error_*` fields |
| 2 | `scripts/lib/health.mjs` | Add `degraded` state; split skip classes |
| 2 | `scripts/lib/alerting.mjs` | Add `degraded` to default `on_transitions`; richer body |
| 3 | `.gitignore` | Add `status/alerting-state.json`, `status/merge-tracker.json` |
| 3 | `scripts/run-dispatcher.ps1` | Insert auto-pull block before engine selection |
| 3 | `scripts/dispatch.mjs` | Optional `--pre-dispatch-event` flag to log auto-update events |

All edits are backward-compatible. No `shared.json` changes (fleet-wide config propagation risk).

---

## Open questions for Perry

1. **Degraded thresholds.** 3 structural skips in 6 cycles feels right to me; alternative is 2 in 3 (faster pages, more false positives) or 5 in 10 (slower, steadier). Preference?
2. **Merge-tracker gitignore trade-off.** Accept per-machine merge state with gist summary follow-up, or keep tracker committed and add auto-stash to the wrapper (more fragile but preserves cross-machine visibility immediately)?
3. **Auto-update kill switch.** Should there be an `auto_update: false` key in `config/local.json` to disable per-machine pull — e.g. if Perry wants to pin a PC to a specific SHA for a week?
4. **Phase sequencing.** Comfortable merging Phase 1 alone first (pure observability, no behavior change) to build confidence before Phases 2+3?

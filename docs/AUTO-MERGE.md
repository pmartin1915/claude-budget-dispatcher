# Auto-merge (gate 6 + gate 7)

> Closes Pillar 1 of `worldbuilder/VEYDRIA-VISION.md`. Gate 6 (cooling-off + ready-flip + merge) and gate 7 (post-merge canary replay) together let the dispatcher transition from "writes code, opens draft PR for human review" to "writes code, reviews semantically, merges autonomously". The mechanism stays dormant on ship: `auto_merge: false` everywhere by default. An operator must opt a project in explicitly.

This guide covers operator-facing semantics, the opt-in procedure, what an auto-suspend means, and recovery paths. For the read-only Overseer (gate 5), see `OVERSEER.md`. For the path firewall + canary (gates 1+4), see `AUTO-PUSH.md`.

## State diagram

```
                    dispatcher pushes auto/<slug>-<task>-<date>
                                       |
                                       v
                              [draft PR opened]
                                       |
                              dispatcher:auto label
                              task:<class> label
                              model:<name> label
                                       |
                                       v
                            ┌──────────────────────┐
                  cron tick │ Overseer (Actions)   │ <-- gate 5 happens here
                            │ - cross-family audit │
                            └──────────────────────┘
                                       |
                +----------------------+----------------------+
                |                      |                      |
        overseer:approved      overseer:rejected      overseer:abstain
                |                                              (terminal)
                |        gate 6 starts only if BOTH:           (terminal)
                |          top-level auto_merge:true
                |          per-repo auto_merge:true
                v
              +---+---+
              | wait  |  cooling_off_minutes (default 45)
              +---+---+
                  |
            (any human comment, draft-state change,
             or fresh push during this window blocks)
                  |
                  v
              [bot flips PR ready-for-review]
              + adds overseer:ready-flipped sentinel
                  |
              +---+---+
              | wait  |  cooling_off_minutes_after_ready (default 0)
              +---+---+
                  |
                  v
              [bot calls PUT /pulls/{n}/merge]
              + adds overseer:merged sentinel
              + writes pending-merges.json gist entry
                  |
                  v
            ┌──────────────────────┐
            │ Dispatcher (host)    │ <-- gate 7 happens here
            │ Phase 0 reads gist   │
            │ replays canary at    │
            │ T+15m, T+1h, T+4h,   │
            │ T+24h                │
            └──────────────────────┘
                  |
            +-----+-----+
            |           |
       all clean    one failure
            |           |
        completed   auto-suspend:
                    - local.json auto_push:false
                    - fatal ntfy fired
                    - no further replays for this PR
```

## Opt-in procedure

For a project to auto-merge, ALL of the following must be true:

1. **Repo is set up for auto-push (gate 4)** — see `AUTO-PUSH.md`. The project must already have a non-empty `auto_push_allowlist` and a `canary_command`.
2. **Top-level fleet flag** — set `auto_merge: true` in `config/shared.json`. This is the fleet-wide kill switch. Default is `false`.
3. **Per-repo Overseer flag** — in `config/shared.json` (or a secret consumed by the Actions workflow), the repo must appear in `overseer.repos` as an OBJECT entry (not a bare string) with `auto_merge: true`:
   ```jsonc
   "overseer": {
     "enabled": true,
     "repos": [
       { "owner_repo": "pmartin1915/extra-sub-standalone-canary-test",
         "auto_merge": true,
         "merge_strategy": "squash",
         "project_slug": "sandbox-canary" }
     ]
   }
   ```
   `project_slug` is REQUIRED for object entries — gate 7 needs it to look up the local project path for the canary replay and to flip `auto_push: false` on auto-suspend.
4. **Top-level cooling-off** (optional; defaults are sane):
   ```jsonc
   "auto_merge": true,
   "cooling_off_minutes": 45,
   "cooling_off_minutes_after_ready": 0,
   "post_merge_canary_replay_schedule_min": [15, 60, 240, 1440]
   ```
5. **GitHub Actions secret for the Overseer**: set `OVERSEER_AUTO_MERGE=true`. The workflow defaults to read-only when this secret is missing or `false`. `OVERSEER_REPOS_JSON` should carry the same per-repo objects as `shared.json` so the Actions runner sees the per-repo `auto_merge` field.

When ANY of these conditions is false, the Overseer falls back to gate-5 read-only mode — labels the PR but never readys, never merges.

## Gate 6: cooling-off, ready-flip, merge

### Cooling-off window

After the Overseer applies `overseer:approved`, it does NOT immediately ready-flip the PR. Instead it waits `cooling_off_minutes` (default 45). On each subsequent cron tick (every 2h), it re-checks:

| Check | If false |
|---|---|
| PR still open | skip silently (terminal) |
| PR still draft | block (`pr-not-draft-and-not-flipped-by-bot`) — interpreted as "human flipped ready early"; the bot will not auto-merge a human-readied PR |
| `overseer:approved` label still present | skip; defer to existing review flow |
| Approve label timestamp ≥ head commit committer date | block (`head-advanced-since-approval`) — a fresh push invalidated the approval; gate 5 must re-review |
| No issue comment authored after the approve label | block (`human-comment-after-approval`) — a comment is a Perry-interrupt signal |
| `now - approve_label_ts >= cooling_off_minutes * 60_000` | skip with `cooling-off-not-elapsed:Ns-remaining` |

If all five pass, the bot:
1. PATCHes `/repos/<owner>/<repo>/pulls/{n}` with `{draft: false}` (ready-flip)
2. Adds `overseer:ready-flipped` (sentinel — proves the bot owns the merge)

The PR is now ready for review. If `cooling_off_minutes_after_ready` is `0` (default), the merge happens in the same cron tick. Otherwise, the bot waits one more cron tick before merging.

### Merge

The bot calls `PUT /repos/<owner>/<repo>/pulls/{n}/merge` with `{merge_method: "squash", sha: <approved-head-sha>}`. The `sha` field makes GitHub refuse the merge if HEAD has advanced since the bot last looked. On success:
1. Adds `overseer:merged` sentinel.
2. Writes a pending-merge entry to `pending-merges.json` in the status gist for gate 7 to replay.

The bot will never re-merge a PR carrying `overseer:merged` (terminal idempotency).

### What blocks the merge?

Five default-to-block invariants gate every code path that ends in `gh.mergePr`. The audit must confirm each is enforced:

- (a) `auto_merge: true` at both layers (top-level + per-repo).
- (b) `overseer:approved` matching the head SHA.
- (c) Cooling-off elapsed.
- (d) No human comment between approval and merge.
- (e) PR was draft when cooling-off expired (proves the bot's own ready-flip is what made it ready).

A failure on any check is logged with `outcome: "auto-merge-blocked"` (or `auto-merge-pending` for transient cooling-off-not-elapsed) and `reason: <which-check-failed>`. Operator can grep `status/budget-dispatch-log.jsonl` for `auto-merge-` outcomes to see history.

## Gate 7: post-merge canary monitor

After merge, the dispatcher (running on the host with the project worktree) runs the project's `canary_command` against the merged commit on a schedule: T+15min, T+1h, T+4h, T+24h. Configurable via `post_merge_canary_replay_schedule_min` (in MINUTES from merge time).

Each replay:
1. `git fetch` the project's origin.
2. `git worktree add <tmp> <merge_commit_sha>` — checks out the merged commit in a fresh disposable worktree.
3. Runs `canary_command` (argv form, `shell: false`, process-tree-safe via the same R-2 pattern as `gate 4 canary`).
4. On exit: `git worktree remove <tmp>`.
5. Writes a JSONL log entry with `phase: "post-merge-canary"`, replay number, exit code, duration, and trail-limited stdout/stderr (≤500 chars each).

### Auto-suspend (one-strike)

A SINGLE failure within the 24h window causes the dispatcher to:

1. **Atomically mutate `local.json`**: set `projects_in_rotation[i].auto_push = false` for the affected project. Other entries are untouched. Implementation is write-temp-then-rename.
2. **Fire one fatal ntfy** at priority 5 (urgent) to the existing dispatcher topic with the project slug, failure mode (timeout / non-zero / spawn-error), and tail-preserved stdout/stderr.
3. **Mark the entry completed** in `pending-merges.json`. No further replays for this PR.
4. **Log JSONL** with `outcome: "auto-suspended"`.

**No auto-recovery.** Once a project is auto-suspended, `auto_push: false` stays false until you flip it back manually. This is intentional — a regression that shipped past gate 4 (canary pre-push) and gate 5 (Overseer review) and gate 7 (post-merge replay) is exactly the failure mode we want to halt for human review.

### Re-enabling after auto-suspend

1. Investigate the failed canary. Look in `status/budget-dispatch-log.jsonl` for `outcome: "auto-suspended"` entries to see the failure mode and tail output.
2. If the regression is real, fix it (open a PR yourself, no dispatcher involvement). Once fixed:
   - Edit `config/local.json` for that project: set `auto_push: true`.
   - Optionally clean up the completed entry in the gist's `pending-merges.json` (cosmetic).
3. If the regression is a false positive (flaky canary), still flip `auto_push: true` back manually — and consider hardening the `canary_command` so the noise stops.

### Dispatcher integration (Phase 0)

`scripts/post-merge-monitor.mjs` runs as **Phase 0** of `dispatch.mjs` — before the gates, before the dispatch lock, before any new work selection. It is fail-soft: any uncaught exception is logged and the dispatcher continues with Phase 1 normally. Phase 0 fires on every cron tick the dispatcher runs (typically every 20 min), regardless of whether the budget/activity gate would skip dispatch otherwise — replays are deadline-driven, not budget-driven.

Phase 0 only writes to the gist when something changed (replay processed, deferred, or GC). Idle ticks make zero gist API calls beyond the read.

### Garbage collection

Completed entries (both `replays-clean` and `auto-suspended`) older than 7 days are dropped from `pending-merges.json` on the next gist write. This keeps the file from growing unboundedly. The 7-day window preserves recent history for operator review (~3-4 dispatch cycles after the 24h replay schedule completes).

### Multi-machine

If multiple dispatcher hosts have the same project in their `projects_in_rotation`, **only one wins the replay** for any given entry — the gist ETag CAS ensures the loser sees the entry already-bumped on its next read. Hosts that don't have the project locally return `skipped: project-not-in-local-rotation` and pass the entry through unchanged.

## Cross-host coordination

- **Overseer (Actions)** writes `pending-merges.json` to the status gist (PATCH with `If-Match` ETag).
- **Dispatcher (host)** reads `pending-merges.json` at the start of each dispatch cycle, processes any entries whose `next_deadline_ms` has elapsed, and PATCHes the gist with updated state.
- **Schema versioning**: `pending-merges.json` carries a `schema_version` integer. The dispatcher fails-soft on unknown future versions (logs and skips).
- **Backwards compatibility**: missing fields default to safe values (e.g. `replays_done: 0`, `completed: false`).
- **Multi-machine**: if multiple dispatcher hosts have the same project in rotation, the gist ETag CAS lets only one win the mutation race. The loser re-reads and finds the entry already-completed.

## Failure modes and operator action

| JSONL `outcome` | What happened | Operator action |
|---|---|---|
| `auto-merge-pending` (`reason: cooling-off-not-elapsed:...`) | Normal — bot is waiting for cooling-off to elapse | None |
| `auto-merge-blocked` (`reason: human-comment-after-approval`) | A comment landed during cooling-off | Bot will not auto-merge this PR. Resolve the comment, then either re-approve via dispatcher or manually merge |
| `auto-merge-blocked` (`reason: head-advanced-since-approval`) | A new commit landed after approval | Wait for next gate-5 review on the new SHA |
| `auto-merge-blocked` (`reason: pr-not-draft-and-not-flipped-by-bot`) | A human flipped ready early | Bot opts out of auto-merge for this PR — the human owns it |
| `auto-merge-blocked` (`reason: comments-fetch-failed:...`) | GitHub API hiccup; default-to-block | Will retry on next cron tick |
| `auto-merge-error` (`reason: set-ready-failed:...`) | Ready-flip API call failed (non-422) | Investigate token scope / branch protection. The bot will retry next tick because no sentinel was added |
| `auto-merge-error` (`reason: merge-failed:...`) | Merge API call failed (e.g. branch protection 405) | Branch protection blocked the merge. Either disable the protection on the bot's account or merge manually |
| `auto-merge-merged` | Bot merged successfully; gate 7 takes over | None — watch for replay outcomes |
| `post-merge-canary` `outcome: replay-success` | Replay passed | None |
| `post-merge-canary` `outcome: auto-suspended` | First replay failed within 24h | Auto-suspend fired; see "Re-enabling after auto-suspend" above |

## Smoke procedure

Before opting in a real rotation project, smoke against `extra-sub-standalone-canary-test`:

1. In `config/shared.json`: set `auto_merge: true`, `cooling_off_minutes: 1` (smoke value).
2. In the Actions secrets, set `OVERSEER_AUTO_MERGE=true` and update `OVERSEER_REPOS_JSON` to include the canary repo as an object with `auto_merge: true` and `project_slug: "sandbox-canary"`.
3. Hand-create a draft PR labeled `dispatcher:auto`+`model:gemini-2.5-pro` with a trivial diff that the Overseer would approve.
4. Trigger Overseer via `workflow_dispatch` with the PR number → expect `overseer:approved`.
5. Wait 1 minute, trigger again → expect `overseer:ready-flipped` followed by `overseer:merged` and a `pending-merges.json` entry.
6. On the next dispatcher run (host) → expect a `post-merge-canary` JSONL entry. Wait through T+15min, T+1h to confirm replays fire.
7. Revert smoke values: `auto_merge: false`, `cooling_off_minutes: 45`, `OVERSEER_AUTO_MERGE=false`.

After three clean cycles on `extra-sub-standalone-canary-test`, you can consider opting in real rotation projects. Burn-wizard and wilderness need additional clinical-gate hardening before they qualify.

## See also

- `OVERSEER.md` — gate 5 read-only review
- `AUTO-PUSH.md` — gates 1 (path firewall) + 4 (canary)
- `WATCHDOG.md` — out-of-band fleet silence detector (P7)
- `worldbuilder/VEYDRIA-VISION.md` — Pillar 3 seven-gate stack rationale

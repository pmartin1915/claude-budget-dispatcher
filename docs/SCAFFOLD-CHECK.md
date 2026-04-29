# Scaffold Check (Phase 0.5)

The scaffold check is a per-cron-tick observability pass that surfaces
rotation projects whose required scaffolds (today: `DISPATCH.md`) are missing.
It runs as Phase 0.5 in `scripts/dispatch.mjs`, between Phase 0 (post-merge
canary monitor) and Phase 1 (gates), and never blocks dispatch.

It exists because of Bug A: `scripts/lib/context.mjs:56-59` silently returns
`null` for any project without a `DISPATCH.md`, dropping the project from
the selector with zero log surface. Operators had no visible signal that
a project was effectively dormant.

## What it logs

For every project in `shared.json projects_in_rotation` that lacks
`DISPATCH.md` on local disk, the dispatcher appends one entry to
`status/budget-dispatch-log.jsonl`:

```json
{
  "ts": "2026-04-29T20:15:00.123Z",
  "engine": "dispatch.mjs",
  "phase": "scaffold-check",
  "project": "combo",
  "outcome": "scaffold-missing",
  "reason": "dispatch-md-missing"
}
```

If a project entry is malformed (e.g. missing `path`), the dispatcher logs
`outcome: "scaffold-check-error"` instead and continues iterating other
projects. One bad entry never aborts the whole pass.

## Local-fs vs origin/main

The check uses `existsSync(<project.path>/DISPATCH.md)` — a **local
filesystem** check, not a remote `gh api` lookup. This mirrors the load-
bearing pathology: the silent skip in `context.mjs:56-59` is filesystem-
based, so the verifier surfaces the same source.

The "exists locally, missing on origin/main" case is a separate failure
mode that surfaces later in `scripts/lib/auto-push.mjs` when push attempts
run. If origin-divergence becomes a real failure mode, a remote-check
variant can be added without breaking the local-fs path.

## Cadence

One log entry per cron tick per missing project. With a 20-minute cron
and N missing-scaffold projects, that's `72 × N` entries/day. For N=1
this is comparable to existing gate-skip noise. If volume becomes a
concern, a `last-scaffold-check.json` change-detection state file
(mirroring `last-auto-pull.json` from the P3 circuit breaker) is the
obvious follow-up.

## Operator response

When `scaffold-missing` appears for a project:

1. **Decide the project's fate.** Either commit a `DISPATCH.md` to the
   project (model after `wilderness/DISPATCH.md` or `burn-wizard/DISPATCH.md`)
   so the selector can authorize tasks, or remove the project from
   `shared.json projects_in_rotation` so the dispatcher stops checking.
2. **Watch for resolution.** Once `DISPATCH.md` is present locally, the
   next cron tick stops emitting `scaffold-missing` for that project.

A project that emits `scaffold-missing` continuously for >7 days is a
candidate for a v2 detector (similar to `evaluateNoProgress`) that
escalates fleet health to `degraded`.

## Implementation

- Pure function: `evaluateProjectScaffold({ project, fs })` in
  `scripts/lib/scaffold.mjs`. Mirrors `evaluatePathFirewall` shape.
- Orchestrator: `verifyProjectScaffolds({ projects, fs, appendLog })` in
  the same file.
- Phase 0.5 caller: `scripts/dispatch.mjs`, immediately after Phase 0.
- Tests: `scripts/lib/__tests__/scaffold.test.mjs` (5 tests, dependency
  injection style matching `auto-push.test.mjs`).

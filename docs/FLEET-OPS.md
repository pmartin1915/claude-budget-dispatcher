# Fleet Operations from Your Laptop

> Day-to-day operator guide for the multi-machine Budget Dispatcher fleet.
> Lives at `docs/FLEET-OPS.md`. Pair with [`AUTO-PUSH.md`](AUTO-PUSH.md) and
> [`AUTO-MERGE.md`](AUTO-MERGE.md) for the gate-stack details.

The fleet is N coder machines (each running `dispatch.mjs` on a 20-min cron
via the auto-pulling PowerShell wrapper) plus 1 monitoring laptop. This guide
covers the two things you do most often:

1. **Check fleet health from the laptop.**
2. **Deploy a fix or opt-in change to all machines without RDP'ing into each one.**

---

## 1. Check fleet health (laptop, read-only)

Three options, fastest first:

```bash
# Option A: terminal summary (quickest)
node scripts/remote-status.mjs

# Option B: live PWA — open in browser (or iPhone home-screen install)
start docs/fleet-dashboard.html

# Option C: raw gist read
gh api gists/655d02ce43b293cacdf333a301b63bbf | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.files['health.json'].content);
"
```

What you're looking at:

| Field | Where to read | What it means |
|---|---|---|
| `state` | `health.json` | `healthy` / `degraded` / `down`. Degraded fires ntfy. |
| `last_structural_failure.reason` | `health.json` | Why we're degraded (e.g. `canary-command-missing`). |
| `last_run_outcome` | `fleet-<machine>.json` | What each machine last did. |
| `pending-merges.json` | gist root | Auto-merge replay queue (gate 7). |

If a coder machine's `last_run_ts` is more than ~1h old, that machine's
wrapper or cron is stuck — check the machine directly.

---

## 2. Deploy a fleet-wide config change (from laptop, no RDP)

The fleet shares a two-layer config:

- **`config/shared.json`** — committed, auto-pulled by every machine on every
  cron tick. **This is the truth.** Edit here for fleet-wide changes.
- **`config/local.json`** — gitignored, per-machine. Holds genuinely
  per-machine overrides (machine name, paused flag, alternate paths).
  Currently only the laptop's local.json is editable from here.

The two are merged at startup by [`scripts/lib/config.mjs:loadConfig`](../scripts/lib/config.mjs):

- Most fields: deep merge, local.json wins on conflict.
- Arrays: local.json wins (replaces shared.json).
- **`projects_in_rotation`** (special): merged **by `slug`**. Per-slug deep
  merge means local.json can override individual project fields without
  clobbering the fleet-wide list.

### Common operator actions

#### Add a project to fleet rotation

Edit `config/shared.json` `projects_in_rotation`. Add a new entry:

```json
{
  "slug": "my-new-project",
  "path": "c:/Users/perry/DevProjects/my-new-project",
  "clinical_gate": false,
  "opportunistic_tasks": ["test", "audit"],
  "auto_push": false,
  "auto_push_allowlist": []
}
```

Then locally:

```bash
npm test                    # 476+ tests must stay green
node scripts/dispatch.mjs --dry-run   # optional: see materialized config
git add config/shared.json
git commit -m "feat(rotation): add my-new-project"
git push
```

Each coder machine will pick it up on its next cron tick (≤20 min lag).

> **Path caveat:** if a machine has the project at a different path, that
> machine's `dispatch.mjs` will fail for THAT project (git worktree add
> fails). Fix by adding `{"slug":"my-new-project","path":"d:/alt/path"}` to
> that machine's `config/local.json` `projects_in_rotation`. Per-slug merge
> applies the override.

#### Opt a project into auto-push (Pillar 1 cycle)

In `shared.json`, set on the project entry:

```json
{
  "slug": "...",
  "auto_push": true,
  "auto_push_allowlist": ["docs/notes/**", "..."],
  "canary_command": ["npm.cmd", "test"],
  "canary_timeout_ms": 60000
}
```

`canary_command` is **required** when `auto_push:true`. Default-to-block
invariant: missing canary blocks the push with `canary-not-configured`.

Push, wait 20 min, watch [the gist](#1-check-fleet-health-laptop-read-only).

#### Disable auto-push fleet-wide (kill switch)

Set top-level `auto_push: false` in `shared.json`, push. Top-level acts as
the master kill switch over per-project flags.

#### Pause one machine without affecting fleet

On that machine: edit `config/local.json` to add `"paused": true`. (Or use
the tray app's pause button — `scripts/tray.ps1`.) Don't put `paused` in
shared.json or you'll pause the whole fleet.

---

## 3. Migrating from the legacy local.json `projects_in_rotation`

Until commit `<this-commit>`, each machine kept the canonical
`projects_in_rotation` array in its own `config/local.json`. This caused
drift: `sandbox-canary-test.canary_command` was set on the laptop only, so
the coder fleet couldn't replay the gate-7 canary, hit
`canary-command-missing` ≥ 3 times in 6 cycles, and tripped degraded ntfy.

The fix moved the canonical list to `shared.json` and added per-slug merge
semantics. To complete the migration on a coder machine:

```bash
# After the wrapper auto-pulls the new shared.json:
node scripts/migrate-local-projects.mjs
```

The script:
1. Backs up `config/local.json` to `config/local.json.bak-<timestamp>` (gitignored).
2. Removes the `projects_in_rotation` key.
3. Validates the result is parseable JSON before writing.
4. Is idempotent — re-running on a migrated machine is a no-op.

After running on each coder machine, that machine's next cron tick uses the
fleet-wide list from `shared.json`.

### Transition window: what's in effect when

There is a brief window per machine between "auto-pulled the new shared.json"
and "ran migrate-local-projects.mjs". During that window, **local.json's
stale `projects_in_rotation` overrides shared.json's (per-slug)**. Concretely:

| Setting | Effective during transition? |
|---|---|
| `sandbox-canary-test.canary_command` (NEW in shared.json) | **Yes** if local.json's entry doesn't have it (filled by per-slug merge). **No** on the laptop where local.json already had it set — but the laptop doesn't dispatch in production, so doesn't matter. |
| `sandbox-workflow-enhancement.auto_push:true` (NEW in shared.json) | **No** until migration runs. Local.json's stale `auto_push:false` overrides per-slug. |
| Any new project entry added to shared.json | **Yes** — appended by per-slug merge (it's a new slug locally). |

Net effect: **the canary fix lands on auto-pull alone; new opt-ins wait for
migration.** This is the safe direction (no surprise opt-ins). Run the
migration on each coder machine to complete the rollout.

---

## 4. Where to look when something fails

| Symptom | First place to look |
|---|---|
| ntfy says `degraded` | `health.json` `last_structural_failure.reason` |
| ntfy says `down` | `fleet-<machine>.json` `last_run_ts` (which machine is silent?) |
| Auto-push isn't firing | [`AUTO-PUSH.md`](AUTO-PUSH.md) outcomes table; `JSONL log phase=auto-push` |
| Overseer isn't labeling | GH Actions [overseer.yml](../.github/workflows/overseer.yml) run logs |
| Auto-merge isn't firing | [`AUTO-MERGE.md`](AUTO-MERGE.md) gate-6 invariants |
| Post-merge canary keeps failing | `pending-merges.json` + [`OVERSEER.md`](OVERSEER.md) gate 7 |

---

## 5. Things to never do from shared.json

These are per-machine concerns and **must** stay in `local.json`:

- `paused: true` — fleet-wide pause is rarely what you want.
- `dry_run: true` — fleet-wide dry-run silences all real work.
- `machine_name` — derived per-machine.
- Per-machine `path` overrides — only when paths actually differ.

---

## 6. Anatomy of a clean fleet change

1. Edit `config/shared.json` (or scripts/) on the laptop.
2. `npm test` — must stay 476/476 green.
3. (Recommended for risky changes) `node scripts/dispatch.mjs --dry-run`
   shows the merged config the coder fleet will see.
4. (Recommended) cross-family PAL audit: `mcp__pal__codereview` with
   `gemini-2.5-pro` if you wrote it on Claude, or `mistral-large-latest` if
   you wrote it on Gemini.
5. `git commit && git push`.
6. Watch `node scripts/remote-status.mjs` for the next 1-2 cron ticks.

The wrapper's circuit breaker (3 consecutive post-pull dispatch failures →
freeze auto-update on that machine) protects you if a bad shared.json edit
slips through. Recovery: `rm status/last-auto-pull.json` on the affected
machine.

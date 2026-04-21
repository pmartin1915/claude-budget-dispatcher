# Morning Update Guide — 2026-04-21

## What changed overnight

1. **Config layering** — `shared.json` (committed) + `local.json` (gitignored) replaces single budget.json. Shared intent (engine=node, Thursday 2pm CT reset, model roster) propagates via `git pull`. Machine-specific fields (project paths, pause state) stay local.

2. **Dashboard improvements** — Activity countdown, auto-branch viewer, budget forecast, skip reason explainer.

3. **Weekly reset fixed** — Thursday 2pm CT (was Friday 11am ET).

4. **Engine override** — All machines now default to `"node"` (free models only) via shared.json.

## Update each machine

### PC (perrypc) — already dispatching, just needs config migration

```powershell
cd C:\Users\perry\DevProjects\budget-dispatcher
git pull
node scripts/migrate-to-layered-config.mjs
node scripts/dispatch.mjs --force --dry-run
```

The migration script reads the existing budget.json, extracts machine-specific fields (projects, paths, kill_switches) into local.json, and verifies the merge produces identical project rotation.

### Neighbor (DESKTOP-TOJGBG2) — needs config migration + env fix

```powershell
cd C:\Users\Perry\DevProjects\budget-dispatcher
git pull
node scripts/migrate-to-layered-config.mjs
node scripts/dispatch.mjs --force --dry-run
```

If dispatch still fails with `GEMINI_API_KEY` error, run the env fix:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fix-neighbor-env.ps1
```

### Optiplex — fresh onboarding

```powershell
# After cloning the repo and running setup-pc.ps1:
cp config/local.example.json config/local.json
# Edit local.json: set machine_name, project paths
node scripts/dispatch.mjs --force --dry-run
```

## Verify after update

From any machine with the dashboard running:
```
http://localhost:7380
```
- **Status tab**: Activity countdown should show idle time
- **Budget tab**: Forecast card should show "Reserve floor in ~X days"
- **Fleet tab**: Auto Branches card should list any origin/auto/* branches

From the fleet gist:
```powershell
gh gist view 655d02ce43b293cacdf333a301b63bbf
```
All three machines should show recent `last_run_ts` entries.

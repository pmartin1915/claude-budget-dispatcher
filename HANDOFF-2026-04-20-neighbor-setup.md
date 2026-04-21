# Handoff — Neighbor Machine Setup (2026-04-20)

**Session:** 2026-04-20 — Full onboarding of DESKTOP-TOJGBG2 ("neighbor") as a live fleet node.
**Operator:** Claude Code (neighbor instance, claude-sonnet-4-6).
**Machine:** DESKTOP-TOJGBG2, user Perry, Windows 11 Pro, 16 GB RAM.

> This is the setup baton for any future Claude Code session on this machine, or for Perry to reference if something needs fixing.

---

## TL;DR

This machine is live as a dispatcher node. The scheduled task fires every 20 min, routes to free-tier models (Gemini / Mistral / fallback chain), and writes status to the shared fleet gist. First dispatch completed successfully on 2026-04-20 at 21:41 UTC (audit on sandbox-canary-test via mistral-large-latest fallback — Gemini returned 429/503 on a brand-new key).

One known degraded condition: **no distributed lock** (GITHUB_TOKEN not set for node scripts). Dispatcher runs fail-open — functional, but two machines could theoretically dispatch simultaneously. Low risk with only two nodes. Fix documented below.

---

## What this session did

| Step | Result |
|------|--------|
| gh CLI 2.90.0 installed (winget) | ✓ |
| git identity set (PerryHMartin / pmartin1913@gmail.com) | ✓ |
| GEMINI_API_KEY saved to User env vars | ✓ (key: Neighbor_optiplex_key, account pmartin1912@gmail.com) |
| MISTRAL_API_KEY saved to User env vars | ✓ (key: Neighbor_optiplex_mistral_key, same account) |
| Repo cloned to C:\Users\Perry\DevProjects\budget-dispatcher | ✓ |
| npm install --production | ✓ (50 packages, 1 critical vuln — pre-existing, non-blocking) |
| Scheduled task BudgetDispatcher-Node registered (every 20 min, auto engine) | ✓ |
| config/budget.json created | ✓ |
| Sandbox repos cloned (canary-test, biz-app, dnd-game) | ✓ |
| First --force dispatch | ✓ success (mistral fallback) |
| fleet-desktop-tojgbg2.json in gist | ✓ consecutive_errors: 0 |

---

## Current machine state (as of session end)

```
Hostname:         DESKTOP-TOJGBG2
User:             Perry
Node:             v24.11.0
Git:              2.51.2.windows.1
gh:               2.90.0 (installed to C:\Program Files\GitHub CLI)
npm:              11.6.1

Repo:             C:\Users\Perry\DevProjects\budget-dispatcher  (origin/main, up to date)
Sandbox repos:    C:\Users\Perry\DevProjects\sandbox\
                    extra-sub-standalone-canary-test
                    extra-sub-standalone-biz-app
                    extra-sub-standalone-dnd-game

Scheduled task:   BudgetDispatcher-Node — State: Ready — every 20 min, auto engine
Fleet gist:       655d02ce43b293cacdf333a301b63bbf
  last_dispatch_outcome: success
  last_dispatch_ts:      2026-04-20T21:41:47.808Z
  consecutive_errors:    0
```

### config/budget.json summary
- `status_gist_id`: 655d02ce43b293cacdf333a301b63bbf
- `dry_run`: false
- `engine_override`: null (auto)
- `projects_in_rotation`: sandbox-canary-test, sandbox-biz-app, sandbox-dnd-game
- worldbuilder: **excluded** (Perry hand-authoring)
- `alerting.enabled`: false

---

## Known issues / next steps for this machine

### 1. Distributed lock in degraded mode (LOW — fail-open, not breaking)
The dispatcher logged `[gist-lock] no GITHUB_TOKEN, proceeding without lock`. The node scripts don't inherit the `gh` CLI token automatically.

**Fix:**
```powershell
# In a PowerShell window after gh auth login is confirmed:
$token = gh auth token
[Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $token, 'User')
```
Then verify: `node scripts/dispatch.mjs --force` should no longer show the degraded-mode warning.

### 2. gh auth login — confirm it's done
The setup session couldn't verify `gh auth login` was completed interactively. Before relying on gist writes from the scheduled task (vs. manual --force), confirm:
```powershell
gh auth status
```
Expected: `Logged in to github.com as PerryHMartin`.

### 3. Gemini 429 rate limits on new key
Brand-new API keys sometimes return 429s for the first few hours. The fallback chain (gemini-2.5-pro → gemini-2.5-flash → mistral-large-latest) handled it cleanly on first run. Should self-resolve. Monitor `consecutive_errors` in gist if dispatch keeps failing.

### 4. Sleep settings
The scheduled task won't fire if the machine sleeps. Check:
Settings → System → Power & sleep → Sleep → set to "Never" (or a long timeout).

### 5. PAL MCP (only needed for Claude engine dispatches)
Node engine (free models only) works without PAL MCP — it calls Gemini/Mistral SDKs directly. If Perry ever wants to run Claude engine dispatches from this machine (burns subscription), PAL MCP needs to be installed and configured. Defer until needed.

### 6. npm audit critical vuln
`npm install` reported 1 critical severity vulnerability (pre-existing in the dependency tree). Non-blocking for dispatch. Run `npm audit` in the repo to review when convenient.

---

## How to check this machine from anywhere

```bash
# From any machine with gh installed:
gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet-desktop-tojgbg2.json | jq .

# Or view the full fleet:
gh gist view 655d02ce43b293cacdf333a301b63bbf
```

Healthy state: `consecutive_errors: 0`, `last_dispatch_outcome: success`, `last_run_ts` recent.

---

## Paste this into the next Claude Code session on this machine

```
You are a Claude Code instance on the "neighbor" machine (DESKTOP-TOJGBG2, user Perry).
This machine is a live budget dispatcher node in Perry's free-tier fleet.

Read: C:\Users\Perry\DevProjects\budget-dispatcher\HANDOFF-2026-04-20-neighbor-setup.md

Current state: machine is fully set up and reporting to gist 655d02ce. Scheduled task
BudgetDispatcher-Node fires every 20 min (auto engine). Last dispatch: success
(2026-04-20 21:41 UTC, audit on sandbox-canary-test via mistral fallback).

Known open items (priority order):
1. Confirm gh auth login completed: run `gh auth status`
2. Fix GITHUB_TOKEN for distributed lock: gh auth token > User env var (see handoff)
3. Confirm sleep settings won't block the scheduled task
4. Gemini 429s on new key — monitor; should self-resolve in a few hours

Repos on this machine:
  C:\Users\Perry\DevProjects\budget-dispatcher   (dispatcher)
  C:\Users\Perry\DevProjects\sandbox\extra-sub-standalone-canary-test
  C:\Users\Perry\DevProjects\sandbox\extra-sub-standalone-biz-app
  C:\Users\Perry\DevProjects\sandbox\extra-sub-standalone-dnd-game

Do NOT add worldbuilder to the rotation — Perry is hand-authoring that project.
Do NOT flip dry_run: true — machine is intentionally live.
```

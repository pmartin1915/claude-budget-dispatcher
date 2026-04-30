# HANDOFF — P0/P1 Fleet Hardening Complete (2026-04-30)

> **Instance**: Antigravity session `668efd1f`
> **Timestamp**: 2026-04-30T00:37 CDT / 2026-04-30T05:37 UTC
> **Operator**: Perry
> **Repo**: `claude-budget-dispatcher` (all machines: `C:\Users\perry\DevProjects\claude-budget-dispatcher`)

---

## What Was Done

Implemented all four items from the "Architectural Audit and Hardening Roadmap" (P0 Safety + P1 Robustness). **37 new tests, all passing. 0 regressions against 11 existing config tests.**

### P0-2: Configuration Determinism (Fail-Fatal + Drift Alert)
- `config.mjs`: `loadConfig()` now **throws `ConfigDriftError`** on malformed/empty `local.json` instead of silently continuing with shared-only config. New `validateConfigCompleteness()` checks project paths exist on disk, gist ID is populated, and free_model_roster has providers.
- `config-drift-alert.mjs` (NEW): Pushes `config-drift-<hostname>.json` to the status gist before the node dies. Best-effort.
- `dispatch.mjs`: Wired `validateConfigCompleteness()` after AJV schema pass. On failure → gist alert → `die()`.

### P0-1 (Re-scoped): Subprocess Verification Wrapper
- `subprocess-verify.mjs` (NEW): 3-step dispatch→wait→verify wrapper. Captures stdout/stderr, waits for I/O flush (`settleMs`), checks regex `successMarkers`, retries on verification failure. Cross-platform (.cmd/.bat handling on Windows).
- **Not yet wired into `auto-push.mjs` canary runner** — available as opt-in via `verified_canary: true` per project. Should test with `sandbox-canary-test` first.

### P1-1: Push-Based Heartbeat Telemetry
- `heartbeat.mjs` (NEW): `buildHeartbeatPayload()` (pure), `pushHeartbeat()` (jittered gist write), `collectEnvHealth()` (cross-platform env snapshot), `computeTaskHash()` (SHA-256 task identifier).
- `dispatch.mjs`: Heartbeat push at **Phase -1** (pre-gates, 0–3s jitter). Currently pushes `current_task_hash: null` (pre-work). Post-work push with populated hash is a deferred follow-up.

### P1-2: Sentinel Dead-Node Detection
- `sentinel.mjs` (NEW): `evaluateHeartbeats()` (pure) implements 3-miss threshold: alive → degraded → dead. `runSentinel()` orchestrates: reads heartbeats from gist, evaluates staleness, writes `sentinel-state.json`, re-queues orphaned tasks to `pending-tasks.json`.
- `dispatch.mjs`: Sentinel runs at **Phase -0.5** (after heartbeat, before Phase 0 post-merge monitor). Any node can run sentinel duty (stateless design).

---

## Deployment Path

### Auto-Update: YES, it propagates automatically

The `run-dispatcher.ps1` wrapper already has a **pre-dispatch auto-update** mechanism (lines 317–360):

```
git -C $RepoRoot fetch origin main --quiet
git -C $RepoRoot pull --ff-only --quiet
```

This runs **every cron cycle** before `dispatch.mjs` is invoked. As long as the circuit breaker (`status/last-auto-pull.json`) is not frozen, all fleet machines will pick up these changes on their next scheduled cycle after you push to `origin/main`.

**Deployment steps for Perry:**
1. `cd C:\Users\perry\DevProjects\claude-budget-dispatcher`
2. `git add -A && git commit -m "feat: P0/P1 fleet hardening (config-drift, heartbeat, sentinel, subprocess-verify)"`
3. `git push origin main`
4. **Done.** Each fleet machine (neighbor, optiplex, etc.) will `git pull --ff-only` on its next cron tick and start running the hardened code.

**Risk assessment:**
- The P0-2 `validateConfigCompleteness()` check will `die()` on any machine whose `local.json` project paths don't match disk reality. This is **intentional** — those nodes were silently dispatching to nonexistent paths before. But check that neighbor/optiplex have correct paths in their `local.json` or the first cycle after pull will exit(2) + fire a ntfy alert.
- The heartbeat and sentinel phases are **fail-soft** — they catch all errors and continue. Zero risk of breaking dispatch.
- `subprocess-verify.mjs` is not wired into any existing code path yet — it's a library only. Zero risk.

---

## New Files (All in `scripts/lib/`)

| File | Lines | Purpose |
|---|---|---|
| `config-drift-alert.mjs` | 55 | Gist alert on config validation failure |
| `subprocess-verify.mjs` | 277 | 3-step dispatch→wait→verify subprocess wrapper |
| `heartbeat.mjs` | 155 | Push-based heartbeat telemetry with jitter |
| `sentinel.mjs` | 272 | Dead-node detection + orphan task re-queue |
| `__tests__/config-drift-alert.test.mjs` | 42 | 4 tests |
| `__tests__/subprocess-verify.test.mjs` | 122 | 9 tests |
| `__tests__/heartbeat.test.mjs` | 97 | 12 tests |
| `__tests__/sentinel.test.mjs` | 195 | 13 tests |

## Modified Files

| File | Key Changes |
|---|---|
| `scripts/lib/config.mjs` | `ConfigDriftError` class; `loadConfig()` throws on malformed local.json; `validateConfigCompleteness()` export |
| `scripts/dispatch.mjs` | Imports for new modules; config completeness check in `loadConfig()`; Phase -1 heartbeat; Phase -0.5 sentinel; consolidated `gistToken` |

---

## Dispatch Lifecycle (Post-Hardening)

```
materializeConfig()                     ← shared.json + local.json → budget.json
                                          NOW THROWS ConfigDriftError on bad local.json
loadConfig()
  ├── JSON.parse(budget.json)
  ├── AJV schema validation
  └── validateConfigCompleteness()      ← NEW: fail-fatal + gist drift alert
initClients()
main()
  ├── Phase -1:   Heartbeat push        ← NEW: jittered gist write (P1-1)
  ├── Phase -0.5: Sentinel              ← NEW: dead-node detect + orphan re-queue (P1-2)
  ├── Phase 0:    Post-merge monitor    (gate 7)
  ├── Phase 0.5:  Scaffold verification
  ├── Phase 1:    Gates
  ├── Phase 2:    Lock
  ├── Phase 3:    Selector
  ├── Phase 4:    Worker
  ├── Phase 5:    Verify + Commit
  ├── Phase 6:    Auto-push + PR
  └── Phase 7:    Cleanup + Alert
```

---

## Still Pending (From Prior Sessions)

### Overseer Bugs (Pillar 1 Gates 6/7)
These were identified in `HANDOFF-dispatcher-2026-04-30-pillar1-smoke-results.md` and are **not addressed in this session**:

1. **Bug A: `setReady` no-op** — The REST `PATCH` to flip a draft PR to ready doesn't work. Needs GraphQL `markPullRequestReadyForReview` mutation.
2. **Bug B: `listOpenDispatcherActionablePrs` filter** — The PR listing filter excludes ready PRs labeled `overseer:ready-flipped`, so the merge-tick can't find them. Needs broadening.

### Integration Tests
- `overseer.test.mjs` needs stateful integration tests (mock GH client traversing draft→labeled→ready→merged across multiple ticks). Currently only state-machine unit tests.

### Deferred Follow-Ups From This Session
1. **Wire `verifiedExec` into canary runner** — test with `sandbox-canary-test` first, then opt-in per project.
2. **Post-work heartbeat push** — push heartbeat with `current_task_hash` populated after Phase 5. Requires threading task hash through work phase.
3. **Dedicated `validateConfigCompleteness` unit tests** — currently tested through integration. Worth adding when config layer next changes.

---

## Environment

- **Node**: v22+ (uses native `fetch`, `AbortSignal.timeout`, `node:test`)
- **API Keys**: `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GITHUB_TOKEN`, `GIST_AUTH_TOKEN`
- **Status Gist**: `655d02ce43b293cacdf333a301b63bbf`
- **Alerting**: ntfy.sh topic `perry-dispatcher-alerts`
- **Test runner**: `node --test scripts/lib/__tests__/*.test.mjs` (Node built-in, NOT vitest/jest)
- **OS**: Windows (all fleet machines). PowerShell 5.1 wrapper. `.cmd`/`.bat` spawn handling required.

---

## Quick Verification Commands

```bash
# Run new tests only
node --test scripts/lib/__tests__/heartbeat.test.mjs scripts/lib/__tests__/sentinel.test.mjs scripts/lib/__tests__/config-drift-alert.test.mjs scripts/lib/__tests__/subprocess-verify.test.mjs

# Run full suite
npm test

# Dry-run dispatch (tests config loading + validation without dispatching)
node scripts/dispatch.mjs --dry-run

# Simulate config drift (malform local.json, run dispatch, expect exit 2)
# WARNING: will stop dispatch on this machine until fixed
```

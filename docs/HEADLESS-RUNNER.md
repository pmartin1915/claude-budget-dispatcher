# Headless Runner — `scripts/run-dispatcher.ps1`

> PowerShell wrapper that turns the Budget Dispatcher into a fully unattended system. Runs the estimator → idle check → `claude -p` pipeline with retries, timeouts, and structured logging.

## What it does

The wrapper is a four-phase pipeline:

| Phase | What | Cost |
|---|---|---|
| 1 | `node scripts/estimate-usage.mjs` → check `dispatch_authorized` in the snapshot | Free (Node only) |
| 2 | `node scripts/check-idle.mjs 20` → check if user is active | Free (Node only) |
| 3 | `claude -p < tasks/budget-dispatch.md` → run the dispatcher prompt | Claude Max cost (only if phases 1+2 passed) |
| 4 | Append run summary to `status/budget-dispatch-log.jsonl` | Free |

Phases 1 and 2 are the fail-fast gate. If either one says "not now," the wrapper exits with code 0 and **zero Claude Max tokens are consumed**. This matches the framework's core invariant: "zero cost for the no-op path."

## Exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | Dispatcher ran successfully, OR skipped due to gate / activity check | Normal — expected for most invocations |
| 1 | Transient error retried to exhaustion (network, 429, 500) | Check log for last `claude_exit` value |
| 2 | Config or setup error (missing prompt, missing claude binary, invalid JSON, non-retryable Claude error) | Fix the install, don't retry |
| 3 | Hard timeout — `claude -p` ran > `TimeoutMinutes` and was killed | Investigate why the dispatcher prompt got stuck |

## Setup

### Prerequisites

- Windows 10/11 with PowerShell 5.1 or later
- Node.js 18+ on PATH
- GitHub CLI (`gh`) on PATH — install via `winget install --id GitHub.cli`,
  then run `gh auth login` interactively before first use
- `claude` CLI installed and authenticated to your Claude Max subscription.
  **Required:** standalone install via `npm install -g @anthropic-ai/claude-code`.
  The VS Code extension bundles a `claude.exe` but its path changes on every
  extension update — do not use it for scheduled tasks. Stable paths after
  standalone install:
  - npm global: `C:\Users\<username>\AppData\Roaming\npm\claude.cmd`
  - Homebrew (macOS): `/usr/local/bin/claude` or `~/.local/bin/claude`
- `budget-dispatcher` repo cloned with `config/budget.json` populated

### Pre-production verification

**Before registering this wrapper with Task Scheduler**, run through these checks manually. The PowerShell script is a draft pending real-world verification — these checks are the production gates.

#### 1. `claude` binary path and PATH resolution

Task Scheduler runs tasks with a minimal environment that may not include your interactive PATH. Verify `claude` is findable:

```powershell
# From a fresh PowerShell (not the one with your interactive profile):
Get-Command claude -ErrorAction SilentlyContinue
```

If this returns nothing, find the absolute path of your `claude` binary and pass it to the wrapper explicitly via `-ClaudePath`:

```powershell
# Typical locations:
"C:\Users\$env:USERNAME\AppData\Local\Anthropic\claude.exe"
"C:\Users\$env:USERNAME\.npm\claude.cmd"
"C:\Program Files\Anthropic\claude.exe"
```

Save the resolved path — you'll need it for the Task Scheduler registration.

#### 2. First invocation with `paused: true`

With `"paused": true` set in `config/budget.json`, run the wrapper once from an interactive PowerShell window:

```powershell
cd C:\Users\perry\DevProjects\budget-dispatcher
.\scripts\run-dispatcher.ps1 -RepoRoot (Get-Location).Path
```

Expected output:
- A new log file under `status/dispatcher-runs/YYYYMMDD-HHMMSS-<runid>.log`
- The log should show Phase 1 (estimator) running and writing a snapshot
- The estimator should report `paused: true` and the wrapper should exit 0 at Phase 1 without ever invoking `claude -p`
- A `skipped` entry should appear in `status/budget-dispatch-log.jsonl`

If any of that fails, the wrapper has a bug or the repo layout is wrong — fix before proceeding.

#### 3. Dry-run invocation

Set `"paused": false` but keep `"dry_run": true`. Run the wrapper again. Now:
- Phase 1 should pass (estimator green, depending on your current gate state)
- Phase 2 should say `user-active` (exit 1) because you're sitting at the terminal. Wrapper exits 0, logs a skip.
- To test Phase 3, wait 20+ minutes without touching Claude Code, then run the wrapper again. You should see it proceed to Phase 3, invoke `claude -p`, and either run the dispatcher (still in dry-run mode) or log a skip depending on the live gate.

#### 4. Retry logic

This is harder to test without simulating a 429. Two options:
- **Option A (simplest):** trust the design and verify it only after a real 429 happens in production
- **Option B (thorough):** temporarily rename `claude` to `claude-real` and create a wrapper shell script that exits with code 5 on the first two calls and code 0 on the third. Confirm the wrapper retries correctly with exponential backoff.

Start with Option A unless you're paranoid about reliability.

#### 5. Hard timeout

Set `-TimeoutMinutes 1` for this test. Run the wrapper when Phase 3 will actually invoke `claude -p`. Confirm that after 1 minute, the wrapper logs `HARD TIMEOUT` and kills the process. Do not ship with `-TimeoutMinutes 1` in production — the default is 45.

### Task Scheduler registration

Once all pre-production checks pass, register the wrapper as a scheduled task.

#### Primary method (recommended): `Register-ScheduledTask`

The `schtasks /TR` argument has a ~261-character limit that real-world paths
easily exceed. Use the PowerShell cmdlet instead:

```powershell
# Run from an elevated PowerShell window (Run as Administrator)
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"C:\Users\perry\DevProjects\dev-ops\scripts\run-dispatcher.ps1`" -RepoRoot `"C:\Users\perry\DevProjects\dev-ops`" -ClaudePath `"C:\Users\perry\AppData\Roaming\npm\claude.cmd`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 20) `
  -RepetitionDuration (New-TimeSpan -Days 365)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "ClaudeBudgetDispatcher" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Budget-gated autonomous Claude dispatch (every 20 min)" `
  -Force
```

Parameters:
- `-RepetitionInterval 20min` — every 20 minutes
- `-AllowStartIfOnBatteries` — runs on laptop battery power
- `-StartWhenAvailable` — catches up after sleep/hibernate
- `-Force` — overwrite if already registered
- `-ClaudePath` — **always pass this explicitly** with the npm global path

To verify registration:

```powershell
Get-ScheduledTask -TaskName "ClaudeBudgetDispatcher" | Format-List
```

To unregister:

```powershell
Unregister-ScheduledTask -TaskName "ClaudeBudgetDispatcher" -Confirm:$false
```

#### Fallback method: `schtasks`

> **Warning:** The `/TR` argument has a ~261-character limit. If your paths are
> long, the command silently truncates and the task will fail at runtime.

```powershell
schtasks /Create `
  /SC MINUTE `
  /MO 20 `
  /TN "ClaudeBudgetDispatcher" `
  /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"C:\Users\perry\DevProjects\dev-ops\scripts\run-dispatcher.ps1`" -RepoRoot `"C:\Users\perry\DevProjects\dev-ops`"" `
  /RL LIMITED `
  /F
```

To verify: `schtasks /Query /TN "ClaudeBudgetDispatcher" /V /FO LIST`
To unregister: `schtasks /Delete /TN "ClaudeBudgetDispatcher" /F`

## Log files

Each wrapper invocation produces one log file in `status/dispatcher-runs/`:

```
status/dispatcher-runs/
├── 20260411-045000-a1b2c3d4.log
├── 20260411-051000-e5f6g7h8.log
└── ...
```

The filename format is `<timestamp>-<run_id>.log`. The `run_id` is an 8-char hex that's also written to `status/budget-dispatch-log.jsonl`, so you can correlate a wrapper run with its gate decision:

```powershell
# Find all logs for a specific run_id
Get-Content status\budget-dispatch-log.jsonl | Select-String "a1b2c3d4"
```

Log files should be added to `.gitignore` (they are).

### Retention

Log files accumulate at a rate of ~72/day (one per scheduled invocation). Roughly 2.2K files/month. Most are tiny (Phase 1 skip → <1KB) but Phase 3 runs can be 10-50KB each.

**Automated cleanup:** The `run-dispatcher.ps1` wrapper automatically deletes log files older than 30 days from `status/dispatcher-runs/` at the start of each run. No manual cleanup is required.

## Troubleshooting

### Wrapper always exits at Phase 1 with "estimator failed"

Run the estimator directly from the same working directory to see its error:
```powershell
cd C:\Users\perry\DevProjects\budget-dispatcher
node scripts/estimate-usage.mjs
```
Most common cause: `config/budget.json` is missing or malformed. Copy from `config/budget.example.json` and re-edit.

### Wrapper always exits at Phase 2 with "user-active"

You're sitting at a terminal with Claude Code actively writing to `~/.claude/projects/`. Wait 20 minutes of idle, or run `check-idle.mjs` directly with a shorter threshold to debug:
```powershell
node scripts/check-idle.mjs 5
```

### `claude: binary not found` at startup

Provide `-ClaudePath` explicitly, or add `claude` to your system PATH (not just user PATH) so Task Scheduler sees it.

### Log files accumulating but no `[opportunistic]` commits

The dispatcher is running but every attempt is being skipped. Check the log entries in `status/budget-dispatch-log.jsonl` — look at the `reason` field. Common causes:
- `monthly-reserve-floor-threatened` / `weekly-reserve-floor-threatened` — your recent usage is over budget pace
- `daily-quota-reached` — `max_runs_per_day` hit for today
- `pal-unreachable` — PAL MCP isn't responding; check PAL server status

### `claude -p` hangs and hits the hard timeout repeatedly

The dispatcher prompt is getting stuck mid-run. Read the stdout block in the log file to see what it was doing. Most common cause: waiting on a MCP tool that timed out. Check PAL server logs.

### Exit code 2 on every run with "claude -p returned exit=1"

`claude -p` is rejecting the prompt. Read the `---STDERR---` block in the log file. Usually one of:
- Prompt file is empty or corrupted
- Claude Max session has expired (re-auth interactively: run `claude` from a normal terminal and follow the login flow)
- The prompt is too long (unusual for a dispatcher prompt but possible after edits)

## Known limitations (as of 2026-04-11)

Four questions this wrapper doesn't definitively answer because they need real-world data:

1. **PATH handling under Task Scheduler.** The `-ClaudePath` parameter is the escape hatch, but we haven't verified whether Task Scheduler's default environment finds `claude` on the user PATH without it. Recommend using `-ClaudePath` explicitly for the first week of production runs.
2. **Retry backoff scale.** Current: 10s → 20s → 40s. This may be too short for Claude Max's 429 window (which could be on the order of minutes). If you see repeated `retries-exhausted` entries, bump `$backoffSec = [Math]::Pow(2, $attempt) * 5` to `* 60` (minute scale) and measure.
3. **Estimator-cadence overhead.** Running the Node estimator every 20 minutes is 72 runs/day. That's fine (it's Node-only, <1 sec each) but monitor disk I/O if you notice slowdowns.
4. **Interaction with PowerShell execution policy.** On locked-down machines, `-ExecutionPolicy Bypass` may be blocked by group policy. Fallback: sign the script with a self-signed cert, or use a `.bat` wrapper that invokes PowerShell with the required flags.

If you hit any of these, log the findings into the workflow-enhancement sandbox's `docs/notes/` directory and file a proposal to refine them.

## Related

- `scripts/estimate-usage.mjs` — Phase 1 implementation
- `scripts/check-idle.mjs` — Phase 2 implementation
- `tasks/budget-dispatch.md` — the dispatcher prompt invoked by Phase 3
- `docs/FREE-MODEL-DELEGATION.md` — what the dispatcher does once invoked
- `docs/HANDOFF-2026-04-11.md` — audit history

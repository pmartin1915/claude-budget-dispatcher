#requires -version 5.1
<#
.SYNOPSIS
  Headless wrapper for the Budget Dispatcher. Invokes claude -p with the
  dispatcher prompt, captures output, handles retries, logs everything.

.DESCRIPTION
  This script is designed to run unattended via Windows Task Scheduler.
  It is NOT interactive. All output goes to log files under
  <REPO_ROOT>/status/dispatcher-runs/. Exit codes:
    0 = dispatcher ran (whether it dispatched work or skipped)
    1 = transient error, retried to exhaustion, fail-closed
    2 = config/setup error, no retry, fail-closed
    3 = hard timeout (dispatcher exceeded max wall-clock)

  Pipeline:
    Phase 1: node scripts/estimate-usage.mjs          (free, Node-only)
             -> if dispatch_authorized = false, exit 0 (no Claude cost)
    Phase 2: node scripts/check-idle.mjs 20           (free, Node-only)
             -> if user-active, exit 0 (no Claude cost)
    Phase 3: claude -p < tasks/budget-dispatch.md     (Claude Max invoked)
             -> with retry on transient errors, hard timeout
    Phase 4: append run summary to status/budget-dispatch-log.jsonl

  NOTE: This file is pure ASCII. PowerShell 5.1 reads .ps1 files as
  Windows-1252 by default; non-ASCII characters (em-dash, smart quotes)
  will mangle the parser. Do not add Unicode characters to this file
  without saving as UTF-8 with BOM.

.PARAMETER RepoRoot
  Absolute path to the claude-budget-dispatcher repo root.

.PARAMETER MaxRetries
  Max retry attempts on transient errors. Default: 2.

.PARAMETER TimeoutMinutes
  Hard wall-clock timeout for a single claude -p invocation. Default: 45.

.PARAMETER ClaudePath
  Absolute path to the claude binary. If omitted, resolved via PATH.
  Task Scheduler's environment may not include the user PATH, so explicit
  is safer.

.EXAMPLE
  .\run-dispatcher.ps1 -RepoRoot "C:\Users\perry\DevProjects\claude-budget-dispatcher"

.EXAMPLE
  .\run-dispatcher.ps1 -RepoRoot "C:\Users\perry\DevProjects\dev-ops" -ClaudePath "C:\Users\perry\.local\bin\claude.exe"
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [int]$MaxRetries = 2,

  [int]$TimeoutMinutes = 45,

  [string]$ClaudePath = '',

  [ValidateSet('claude', 'node')]
  [string]$Engine = 'claude'
)

$ErrorActionPreference = 'Stop'

# ---- Setup ----
$RepoRoot = (Resolve-Path $RepoRoot).Path
$PromptFile = Join-Path $RepoRoot 'tasks\budget-dispatch.md'
$LogDir = Join-Path $RepoRoot 'status\dispatcher-runs'
$RunId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$StartTime = Get-Date

if (-not (Test-Path $PromptFile)) {
  Write-Error "prompt file not found: $PromptFile"
  exit 2
}

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$timestamp = $StartTime.ToString('yyyyMMdd-HHmmss')
$LogFile = Join-Path $LogDir "$timestamp-$RunId.log"
$DispatcherLog = Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl'

function Write-Log {
  param([string]$msg, [string]$level = 'info')
  $line = "[$((Get-Date).ToString('HH:mm:ss.fff'))] [$level] $msg"
  Add-Content -Path $LogFile -Value $line
  if ($level -eq 'error' -or $level -eq 'warn') {
    Write-Host $line
  }
}

function Write-Jsonl {
  param([hashtable]$obj)
  $json = $obj | ConvertTo-Json -Compress
  Add-Content -Path $DispatcherLog -Value $json
}

function Get-DurationSec {
  return [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
}

Write-Log "run_id=$RunId repo_root=$RepoRoot timeout_minutes=$TimeoutMinutes engine=$Engine"

# ---- PID-file mutex (G9 fix) ----
# Prevents concurrent dispatcher runs (Task Scheduler overlap, manual + scheduled).
$StatusDir = Join-Path $RepoRoot 'status'
$lockFile = Join-Path $StatusDir "dispatcher.lock"
if (Test-Path $lockFile) {
  $lockPid = [int](Get-Content $lockFile -ErrorAction SilentlyContinue)
  $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Log "Previous run (PID $lockPid) still active -- skipping"
    exit 0
  }
  # Stale lock -- previous run crashed without cleanup
  Write-Log "Stale lock from PID $lockPid, removing" 'warn'
  Remove-Item $lockFile -Force
}
$PID | Set-Content $lockFile -Force

# ---- Log retention (30 days) ----
$cutoff = (Get-Date).AddDays(-30)
Get-ChildItem $LogDir -Filter "*.log" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  Remove-Item -Force -ErrorAction SilentlyContinue

try {

if ($Engine -eq 'node') {
  # ---- Node engine: dispatch.mjs handles gates + work internally ----
  Write-Log "engine=node: invoking dispatch.mjs (gates handled by Node)"

  $dispatchScript = Join-Path $RepoRoot 'scripts\dispatch.mjs'
  if (-not (Test-Path $dispatchScript)) {
    Write-Log "dispatch.mjs not found: $dispatchScript" 'error'
    exit 2
  }

  $stdoutTemp = Join-Path $LogDir "$timestamp-$RunId.stdout.tmp"
  $stderrTemp = Join-Path $LogDir "$timestamp-$RunId.stderr.tmp"

  $attempt = 0
  $success = $false
  $finalNodeExit = -1

  while (-not $success -and $attempt -le $MaxRetries) {
    $attempt++
    Write-Log "attempt $attempt of $($MaxRetries + 1)"

    $proc = $null
    try {
      $proc = Start-Process -FilePath "node" `
        -ArgumentList $dispatchScript `
        -RedirectStandardOutput $stdoutTemp `
        -RedirectStandardError $stderrTemp `
        -NoNewWindow `
        -PassThru `
        -WorkingDirectory $RepoRoot
    } catch {
      Write-Log "failed to start node: $_" 'error'
    }

    if ($null -ne $proc) {
      $timeoutMs = $TimeoutMinutes * 60 * 1000
      $procExited = $proc.WaitForExit($timeoutMs)

      if (-not $procExited) {
        Write-Log "HARD TIMEOUT after $TimeoutMinutes min, killing process" 'error'
        try { $proc.Kill() } catch { $null = $_ }
        $null = $proc.WaitForExit(5000)

        Write-Jsonl @{
          ts = (Get-Date).ToString('o')
          run_id = $RunId
          outcome = 'error'
          reason = 'hard-timeout'
          timeout_minutes = $TimeoutMinutes
          phase = 'dispatch-mjs'
          engine = 'node'
          wrapper_duration_sec = Get-DurationSec
        }

        Remove-Item $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue
        exit 3
      }

      $finalNodeExit = $proc.ExitCode
      Write-Log "dispatch.mjs exit=$finalNodeExit"

      # Capture output to log file
      Add-Content -Path $LogFile -Value "---STDOUT---"
      if (Test-Path $stdoutTemp) {
        $stdoutContent = Get-Content $stdoutTemp -Raw -ErrorAction SilentlyContinue
        if ($stdoutContent) { Add-Content -Path $LogFile -Value $stdoutContent }
      }
      Add-Content -Path $LogFile -Value "---STDERR---"
      if (Test-Path $stderrTemp) {
        $stderrContent = Get-Content $stderrTemp -Raw -ErrorAction SilentlyContinue
        if ($stderrContent) { Add-Content -Path $LogFile -Value $stderrContent }
      }

      if ($finalNodeExit -eq 0) {
        $success = $true
        Write-Log "dispatch.mjs succeeded on attempt $attempt"
      } elseif ($finalNodeExit -eq 2) {
        Write-Log "dispatch.mjs returned exit=2 (fatal, non-retryable)" 'error'
        Write-Jsonl @{
          ts = (Get-Date).ToString('o')
          run_id = $RunId
          outcome = 'error'
          reason = "dispatch-mjs-exit-$finalNodeExit"
          phase = 'dispatch-mjs'
          engine = 'node'
          attempts = $attempt
          wrapper_duration_sec = Get-DurationSec
        }
        Remove-Item $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue
        exit 2
      } else {
        Write-Log "dispatch.mjs returned exit=$finalNodeExit (retryable)" 'warn'
        if ($attempt -le $MaxRetries) {
          $backoffSec = [Math]::Pow(2, $attempt) * 5
          Write-Log "backoff $backoffSec sec before retry"
          Start-Sleep -Seconds $backoffSec
        }
      }
    } else {
      if ($attempt -le $MaxRetries) {
        $backoffSec = [Math]::Pow(2, $attempt) * 5
        Start-Sleep -Seconds $backoffSec
      }
    }
  }

  Remove-Item $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue

  if (-not $success) {
    Write-Log "all retries exhausted (node engine), fail closed" 'error'
    Write-Jsonl @{
      ts = (Get-Date).ToString('o')
      run_id = $RunId
      outcome = 'error'
      reason = 'retries-exhausted'
      phase = 'dispatch-mjs'
      engine = 'node'
      attempts = $attempt
      last_exit = $finalNodeExit
      wrapper_duration_sec = Get-DurationSec
    }
    exit 1
  }

  $durationSec = Get-DurationSec
  Write-Log "run complete (node) duration=${durationSec}s run_id=$RunId"
  Write-Jsonl @{
    ts = (Get-Date).ToString('o')
    run_id = $RunId
    outcome = 'wrapper-success'
    phase = 'complete'
    engine = 'node'
    attempts = $attempt
    wrapper_duration_sec = $durationSec
    log_file = $LogFile
  }

} else {
  # ---- Claude engine: original behavior ----

  # Resolve claude binary
  if (-not $ClaudePath) {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
      $ClaudePath = $claudeCmd.Source
      Write-Log "claude binary resolved via PATH: $ClaudePath"
    } else {
      Write-Log "claude binary not found on PATH and -ClaudePath not provided" 'error'
      exit 2
    }
  } else {
    if (-not (Test-Path $ClaudePath)) {
      Write-Log "claude binary not found at specified path: $ClaudePath" 'error'
      exit 2
    }
    Write-Log "claude binary (explicit): $ClaudePath"
  }

  # ---- Phase 1: estimator pre-check ----
  Write-Log "phase 1: running estimate-usage.mjs"
  $estimatorScript = Join-Path $RepoRoot 'scripts\estimate-usage.mjs'
  $estimatorOutput = & node $estimatorScript 2>&1
  $estimatorExit = $LASTEXITCODE
  Write-Log "estimator exit=$estimatorExit"
  foreach ($line in $estimatorOutput) {
    Write-Log "  estimator: $line"
  }

  if ($estimatorExit -ne 0) {
    Write-Log "estimator failed, fail closed" 'error'
    exit 2
  }

  $snapshotPath = Join-Path $RepoRoot 'status\usage-estimate.json'
  if (-not (Test-Path $snapshotPath)) {
    Write-Log "estimator ran but no snapshot written, fail closed" 'error'
    exit 2
  }

  $snapshot = Get-Content $snapshotPath -Raw | ConvertFrom-Json
  if (-not $snapshot.dispatch_authorized) {
    Write-Log "dispatch_authorized=false reason=$($snapshot.skip_reason), no-op exit 0"

    Write-Jsonl @{
      ts = (Get-Date).ToString('o')
      run_id = $RunId
      outcome = 'skipped'
      reason = $snapshot.skip_reason
      phase = 'estimator-gate'
      wrapper_duration_sec = Get-DurationSec
    }

    exit 0
  }

  # ---- Phase 2: activity gate ----
  Write-Log "phase 2: running check-idle.mjs"
  $idleScript = Join-Path $RepoRoot 'scripts\check-idle.mjs'
  $idleOutput = & node $idleScript 20 2>&1
  $idleExit = $LASTEXITCODE
  Write-Log "check-idle exit=$idleExit output=$idleOutput"

  if ($idleExit -eq 1) {
    Write-Log "user-active, skipping"
    Write-Jsonl @{
      ts = (Get-Date).ToString('o')
      run_id = $RunId
      outcome = 'skipped'
      reason = 'user-active'
      phase = 'activity-gate'
      wrapper_duration_sec = Get-DurationSec
    }
    exit 0
  }

  if ($idleExit -eq 2) {
    Write-Log "idle check errored, fail closed" 'error'
    exit 2
  }

  # ---- Phase 3: claude -p invocation with retry ----
  Write-Log "phase 3: invoking claude -p"

  $stdinTemp = Join-Path $LogDir "$timestamp-$RunId.stdin.tmp"
  $stdoutTemp = Join-Path $LogDir "$timestamp-$RunId.stdout.tmp"
  $stderrTemp = Join-Path $LogDir "$timestamp-$RunId.stderr.tmp"

  Copy-Item -Path $PromptFile -Destination $stdinTemp -Force

  $attempt = 0
  $success = $false
  $finalClaudeExit = -1

  while (-not $success -and $attempt -le $MaxRetries) {
    $attempt++
    Write-Log "attempt $attempt of $($MaxRetries + 1)"

    $procError = $null
    $procExited = $false
    $proc = $null

    try {
      $proc = Start-Process -FilePath $ClaudePath `
        -ArgumentList '-p' `
        -RedirectStandardInput $stdinTemp `
        -RedirectStandardOutput $stdoutTemp `
        -RedirectStandardError $stderrTemp `
        -NoNewWindow `
        -PassThru `
        -WorkingDirectory $RepoRoot
    } catch {
      $procError = $_
      Write-Log "failed to start claude: $procError" 'error'
    }

    if ($null -ne $proc) {
      $timeoutMs = $TimeoutMinutes * 60 * 1000
      $procExited = $proc.WaitForExit($timeoutMs)

      if (-not $procExited) {
        Write-Log "HARD TIMEOUT after $TimeoutMinutes min, killing process" 'error'
        try { $proc.Kill() } catch { $null = $_ }
        $null = $proc.WaitForExit(5000)

        Write-Jsonl @{
          ts = (Get-Date).ToString('o')
          run_id = $RunId
          outcome = 'error'
          reason = 'hard-timeout'
          timeout_minutes = $TimeoutMinutes
          phase = 'claude-p'
          wrapper_duration_sec = Get-DurationSec
        }

        Remove-Item $stdinTemp, $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue
        exit 3
      }

      $finalClaudeExit = $proc.ExitCode
      Write-Log "claude exit=$finalClaudeExit"

      Add-Content -Path $LogFile -Value "---STDOUT---"
      if (Test-Path $stdoutTemp) {
        $stdoutContent = Get-Content $stdoutTemp -Raw -ErrorAction SilentlyContinue
        if ($stdoutContent) { Add-Content -Path $LogFile -Value $stdoutContent }
      }
      Add-Content -Path $LogFile -Value "---STDERR---"
      if (Test-Path $stderrTemp) {
        $stderrContent = Get-Content $stderrTemp -Raw -ErrorAction SilentlyContinue
        if ($stderrContent) { Add-Content -Path $LogFile -Value $stderrContent }
      }

      if ($finalClaudeExit -eq 0) {
        $success = $true
        Write-Log "claude -p succeeded on attempt $attempt"
      } elseif ($finalClaudeExit -eq 1 -or $finalClaudeExit -eq 2) {
        Write-Log "claude -p returned exit=$finalClaudeExit (non-retryable), fail closed" 'error'

        Write-Jsonl @{
          ts = (Get-Date).ToString('o')
          run_id = $RunId
          outcome = 'error'
          reason = "claude-exit-$finalClaudeExit"
          phase = 'claude-p'
          attempts = $attempt
          wrapper_duration_sec = Get-DurationSec
        }

        Remove-Item $stdinTemp, $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue
        exit 2
      } else {
        Write-Log "claude -p returned exit=$finalClaudeExit (retryable)" 'warn'
        if ($attempt -le $MaxRetries) {
          $backoffSec = [Math]::Pow(2, $attempt) * 5
          Write-Log "backoff $backoffSec sec before retry"
          Start-Sleep -Seconds $backoffSec
        }
      }
    } else {
      if ($attempt -le $MaxRetries) {
        $backoffSec = [Math]::Pow(2, $attempt) * 5
        Start-Sleep -Seconds $backoffSec
      }
    }
  }

  Remove-Item $stdinTemp, $stdoutTemp, $stderrTemp -Force -ErrorAction SilentlyContinue

  if (-not $success) {
    Write-Log "all retries exhausted, fail closed" 'error'

    Write-Jsonl @{
      ts = (Get-Date).ToString('o')
      run_id = $RunId
      outcome = 'error'
      reason = 'retries-exhausted'
      phase = 'claude-p'
      attempts = $attempt
      last_claude_exit = $finalClaudeExit
      wrapper_duration_sec = Get-DurationSec
    }

    exit 1
  }

  $durationSec = Get-DurationSec
  Write-Log "run complete duration=${durationSec}s run_id=$RunId"

  Write-Jsonl @{
    ts = (Get-Date).ToString('o')
    run_id = $RunId
    outcome = 'wrapper-success'
    phase = 'complete'
    engine = 'claude'
    attempts = $attempt
    wrapper_duration_sec = $durationSec
    log_file = $LogFile
  }

} # end Engine if/else

} finally {
  # Always release PID lock
  Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

exit 0

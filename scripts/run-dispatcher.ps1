#requires -version 5.1
<#
.SYNOPSIS
  Headless wrapper for the Budget Dispatcher. Invokes `claude -p` with the
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
             → if dispatch_authorized = false, exit 0 (no Claude cost)
    Phase 2: node scripts/check-idle.mjs 20           (free, Node-only)
             → if user-active, exit 0 (no Claude cost)
    Phase 3: claude -p < tasks/budget-dispatch.md     (Claude Max invoked)
             → with retry on transient errors, hard timeout
    Phase 4: append run summary to status/budget-dispatch-log.jsonl

.PARAMETER RepoRoot
  Absolute path to the claude-budget-dispatcher repo root.

.PARAMETER MaxRetries
  Max retry attempts on transient errors. Default: 2.

.PARAMETER TimeoutMinutes
  Hard wall-clock timeout for a single `claude -p` invocation. Default: 45.

.PARAMETER ClaudePath
  Absolute path to the claude binary. If omitted, resolved via PATH.
  Task Scheduler's environment may not include the user PATH, so explicit
  is safer.

.PARAMETER DryRunOverride
  If set to $true, forces the dispatcher to run in dry-run mode regardless
  of config. Useful for first-time testing.

.EXAMPLE
  .\run-dispatcher.ps1 -RepoRoot "C:\Users\perry\DevProjects\claude-budget-dispatcher"

.EXAMPLE
  .\run-dispatcher.ps1 -RepoRoot "C:\Users\perry\DevProjects\dev-ops" -ClaudePath "C:\Users\perry\AppData\Local\Anthropic\claude.exe"
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [int]$MaxRetries = 2,

  [int]$TimeoutMinutes = 45,

  [string]$ClaudePath = '',

  [switch]$DryRunOverride
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

function Write-Log {
  param([string]$msg, [string]$level = 'info')
  $line = "[$((Get-Date).ToString('HH:mm:ss.fff'))] [$level] $msg"
  Add-Content -Path $LogFile -Value $line
  if ($level -in @('error', 'warn')) {
    Write-Host $line
  }
}

Write-Log "run_id=$RunId repo_root=$RepoRoot timeout_minutes=$TimeoutMinutes"

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
# Run the Node estimator first. If it reports not-authorized, don't even
# invoke claude -p. This is the free no-op path.
Write-Log "phase 1: running estimate-usage.mjs"
$estimatorScript = Join-Path $RepoRoot 'scripts\estimate-usage.mjs'
$estimatorOutput = & node $estimatorScript 2>&1
$estimatorExit = $LASTEXITCODE
Write-Log "estimator exit=$estimatorExit"
foreach ($line in $estimatorOutput) {
  Write-Log "  estimator: $line"
}

if ($estimatorExit -ne 0) {
  Write-Log "estimator failed — fail closed" 'error'
  exit 2
}

$snapshotPath = Join-Path $RepoRoot 'status\usage-estimate.json'
if (-not (Test-Path $snapshotPath)) {
  Write-Log "estimator ran but no snapshot written — fail closed" 'error'
  exit 2
}

$snapshot = Get-Content $snapshotPath -Raw | ConvertFrom-Json
if (-not $snapshot.dispatch_authorized) {
  Write-Log "dispatch_authorized=false reason=$($snapshot.skip_reason) — no-op, exit 0"

  # Log the skip to the dispatcher log for audit trail
  $skipEntry = @{
    ts = (Get-Date).ToString('o')
    run_id = $RunId
    outcome = 'skipped'
    reason = $snapshot.skip_reason
    phase = 'estimator-gate'
    wrapper_duration_sec = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
  } | ConvertTo-Json -Compress
  $dispatcherLog = Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl'
  Add-Content -Path $dispatcherLog -Value $skipEntry

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
  $skipEntry = @{
    ts = (Get-Date).ToString('o')
    run_id = $RunId
    outcome = 'skipped'
    reason = 'user-active'
    phase = 'activity-gate'
    wrapper_duration_sec = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
  } | ConvertTo-Json -Compress
  $dispatcherLog = Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl'
  Add-Content -Path $dispatcherLog -Value $skipEntry
  exit 0
} elseif ($idleExit -eq 2) {
  Write-Log "idle check errored — fail closed" 'error'
  exit 2
}

# ---- Phase 3: claude -p invocation with retry ----
Write-Log "phase 3: invoking claude -p"

$attempt = 0
$success = $false
$finalClaudeExit = -1

while (-not $success -and $attempt -le $MaxRetries) {
  $attempt++
  Write-Log "attempt $attempt/$($MaxRetries + 1)"

  try {
    # Build the invocation. claude -p takes the prompt via stdin.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ClaudePath
    $psi.Arguments = '-p'
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    # Async output capture to avoid deadlock on large outputs
    $stdoutBuilder = New-Object System.Text.StringBuilder
    $stderrBuilder = New-Object System.Text.StringBuilder
    $stdoutHandler = {
      if ($EventArgs.Data) {
        [void]$Event.MessageData.AppendLine($EventArgs.Data)
      }
    }
    $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived `
      -Action $stdoutHandler -MessageData $stdoutBuilder
    $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived `
      -Action $stdoutHandler -MessageData $stderrBuilder

    $proc.Start() | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    # Feed the prompt via stdin
    $promptText = Get-Content $PromptFile -Raw
    $proc.StandardInput.WriteLine($promptText)
    $proc.StandardInput.Close()

    # Wait with timeout
    $timeoutMs = $TimeoutMinutes * 60 * 1000
    if (-not $proc.WaitForExit($timeoutMs)) {
      Write-Log "HARD TIMEOUT after $TimeoutMinutes min — killing process" 'error'
      try { $proc.Kill() } catch { }
      $proc.WaitForExit(5000)

      $timeoutEntry = @{
        ts = (Get-Date).ToString('o')
        run_id = $RunId
        outcome = 'error'
        reason = 'hard-timeout'
        timeout_minutes = $TimeoutMinutes
        phase = 'claude-p'
        wrapper_duration_sec = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
      } | ConvertTo-Json -Compress
      Add-Content -Path (Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl') -Value $timeoutEntry

      exit 3
    }

    $finalClaudeExit = $proc.ExitCode
    Get-EventSubscriber | Unregister-Event

    $stdout = $stdoutBuilder.ToString()
    $stderr = $stderrBuilder.ToString()

    Write-Log "claude exit=$finalClaudeExit"
    Add-Content -Path $LogFile -Value "---STDOUT---"
    Add-Content -Path $LogFile -Value $stdout
    Add-Content -Path $LogFile -Value "---STDERR---"
    Add-Content -Path $LogFile -Value $stderr

    if ($finalClaudeExit -eq 0) {
      $success = $true
      Write-Log "claude -p succeeded on attempt $attempt"
    } elseif ($finalClaudeExit -in @(1, 2)) {
      # These are config/setup errors — do NOT retry
      Write-Log "claude -p returned exit=$finalClaudeExit (non-retryable) — fail closed" 'error'

      $errorEntry = @{
        ts = (Get-Date).ToString('o')
        run_id = $RunId
        outcome = 'error'
        reason = "claude-exit-$finalClaudeExit"
        phase = 'claude-p'
        attempts = $attempt
        wrapper_duration_sec = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
      } | ConvertTo-Json -Compress
      Add-Content -Path (Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl') -Value $errorEntry

      exit 2
    } else {
      # Everything else is potentially transient (network, rate limit)
      Write-Log "claude -p returned exit=$finalClaudeExit (retryable)" 'warn'
      if ($attempt -le $MaxRetries) {
        $backoffSec = [Math]::Pow(2, $attempt) * 5  # 10s, 20s, 40s
        Write-Log "backoff $backoffSec sec before retry"
        Start-Sleep -Seconds $backoffSec
      }
    }
  } catch {
    Write-Log "exception during claude -p: $_" 'error'
    Get-EventSubscriber | Unregister-Event -ErrorAction SilentlyContinue
    if ($attempt -le $MaxRetries) {
      $backoffSec = [Math]::Pow(2, $attempt) * 5
      Start-Sleep -Seconds $backoffSec
    }
  }
}

if (-not $success) {
  Write-Log "all retries exhausted — fail closed" 'error'

  $exhaustedEntry = @{
    ts = (Get-Date).ToString('o')
    run_id = $RunId
    outcome = 'error'
    reason = 'retries-exhausted'
    phase = 'claude-p'
    attempts = $attempt
    last_claude_exit = $finalClaudeExit
    wrapper_duration_sec = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
  } | ConvertTo-Json -Compress
  Add-Content -Path (Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl') -Value $exhaustedEntry

  exit 1
}

# ---- Phase 4: log the run ----
$endTime = Get-Date
$durationSec = ($endTime - $StartTime).TotalSeconds
Write-Log "run complete duration=${durationSec}s run_id=$RunId"

# Append a single-line summary to the dispatcher log
$summary = @{
  ts = $endTime.ToString('o')
  run_id = $RunId
  outcome = 'wrapper-success'
  phase = 'complete'
  attempts = $attempt
  wrapper_duration_sec = [math]::Round($durationSec, 1)
  log_file = $LogFile
} | ConvertTo-Json -Compress

$dispatcherLog = Join-Path $RepoRoot 'status\budget-dispatch-log.jsonl'
Add-Content -Path $dispatcherLog -Value $summary

exit 0

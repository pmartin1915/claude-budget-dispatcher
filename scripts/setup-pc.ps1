#requires -version 5.1
<#
.SYNOPSIS
  One-time setup for the Node dispatcher on Perry's PC.
  Run this once from an elevated PowerShell prompt.

.DESCRIPTION
  Steps:
    1. Pulls latest claude-budget-dispatcher from origin
    2. Installs Node dependencies (@google/genai, @mistralai/mistralai)
    3. Prompts for API keys and sets them as system env vars
    4. Registers a Windows Scheduled Task that runs dispatch.mjs every 20 min
    5. Runs a dry test to confirm everything works

  NOTE: This file is pure ASCII. Do not add Unicode characters.
  See ai/DECISIONS.md entry on PS1 encoding.

.PARAMETER RepoRoot
  Path to claude-budget-dispatcher repo. Default: script's grandparent dir.

.EXAMPLE
  .\setup-pc.ps1
#>

[CmdletBinding()]
param(
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

Write-Host ""
Write-Host "=== Node Dispatcher PC Setup ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Write-Host ""

# ---- Step 1: git pull ----
Write-Host "[1/5] Pulling latest from origin..." -ForegroundColor Yellow
Push-Location $RepoRoot
try {
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Error "git pull failed. Resolve manually and re-run."
  }
  Write-Host "  OK" -ForegroundColor Green
} finally {
  Pop-Location
}

# ---- Step 2: npm install ----
Write-Host "[2/5] Installing Node dependencies..." -ForegroundColor Yellow
Push-Location $RepoRoot
try {
  npm install --production
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed."
  }
  Write-Host "  OK" -ForegroundColor Green
} finally {
  Pop-Location
}

# ---- Step 3: API keys ----
Write-Host "[3/5] Checking API keys..." -ForegroundColor Yellow

$geminiKey = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
if (-not $geminiKey) {
  $geminiKey = Read-Host "  Enter your GEMINI_API_KEY (Google AI Studio)"
  [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', $geminiKey, 'User')
  $env:GEMINI_API_KEY = $geminiKey
  Write-Host "  GEMINI_API_KEY saved to user env vars" -ForegroundColor Green
} else {
  Write-Host "  GEMINI_API_KEY already set" -ForegroundColor Green
  $env:GEMINI_API_KEY = $geminiKey
}

$mistralKey = [Environment]::GetEnvironmentVariable('MISTRAL_API_KEY', 'User')
if (-not $mistralKey) {
  $mistralKey = Read-Host "  Enter your MISTRAL_API_KEY (Mistral console)"
  [Environment]::SetEnvironmentVariable('MISTRAL_API_KEY', $mistralKey, 'User')
  $env:MISTRAL_API_KEY = $mistralKey
  Write-Host "  MISTRAL_API_KEY saved to user env vars" -ForegroundColor Green
} else {
  Write-Host "  MISTRAL_API_KEY already set" -ForegroundColor Green
  $env:MISTRAL_API_KEY = $mistralKey
}

# ---- Step 4: Scheduled Task ----
Write-Host "[4/5] Registering scheduled task..." -ForegroundColor Yellow

$taskName = "BudgetDispatcher-Node"
$runScript = Join-Path $RepoRoot 'scripts\run-dispatcher.ps1'
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -RepoRoot `"$RepoRoot`" -Engine auto"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 20) `
  -RepetitionDuration (New-TimeSpan -Days 365)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "  Task '$taskName' already exists. Updating..." -ForegroundColor Yellow
  Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
} else {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Runs dispatcher every 20 min in auto mode: Claude when budget allows, free models otherwise" | Out-Null
}
Write-Host "  Task '$taskName' registered (every 20 min, auto engine)" -ForegroundColor Green

# Migration: disable old separate Claude engine task if it exists.
# Auto mode handles both engines via budget-adaptive routing, so the
# standalone ClaudeBudgetDispatcher task is no longer needed.
$oldClaudeTask = Get-ScheduledTask -TaskName "ClaudeBudgetDispatcher" -ErrorAction SilentlyContinue
if ($oldClaudeTask -and $oldClaudeTask.State -ne 'Disabled') {
  Disable-ScheduledTask -TaskName "ClaudeBudgetDispatcher" | Out-Null
  Write-Host "  Disabled old ClaudeBudgetDispatcher task (replaced by auto mode)" -ForegroundColor Yellow
}

# ---- Step 5: Dry test ----
Write-Host "[5/5] Running dry test..." -ForegroundColor Yellow
Push-Location $RepoRoot
try {
  $output = & node scripts/dispatch.mjs --dry-run 2>&1
  Write-Host "  $($output -join "`n  ")" -ForegroundColor Gray
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  Dry test passed" -ForegroundColor Green
  } else {
    Write-Host "  Dry test returned exit=$LASTEXITCODE (check output above)" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The dispatcher will run every 20 minutes in auto mode." -ForegroundColor White
Write-Host "Uses Claude when budget allows, free-tier APIs otherwise." -ForegroundColor White
Write-Host ""
Write-Host "To check status:  Get-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host "To pause:         touch $RepoRoot\config\PAUSED" -ForegroundColor Gray
Write-Host "To view logs:     dir $RepoRoot\status\dispatcher-runs\" -ForegroundColor Gray
Write-Host "To unregister:    Unregister-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host ""

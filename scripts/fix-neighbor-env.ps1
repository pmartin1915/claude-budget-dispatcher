# fix-neighbor-env.ps1
# Run this on DESKTOP-TOJGBG2 (Neighbor) in an elevated PowerShell to fix
# the GEMINI_API_KEY not being inherited by the scheduled task.
#
# The issue: SetEnvironmentVariable('User') sets it for new login sessions,
# but scheduled tasks running as the user don't always reload the environment.
# Fix: embed the keys directly in the scheduled task's action arguments.

# Step 1: Verify the key exists in User env
$gemini = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
$mistral = [Environment]::GetEnvironmentVariable('MISTRAL_API_KEY', 'User')

if (-not $gemini) {
    Write-Host "ERROR: GEMINI_API_KEY not found in User environment." -ForegroundColor Red
    Write-Host "Set it first: [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your-key', 'User')"
    exit 1
}
Write-Host "GEMINI_API_KEY found (${($gemini.Substring(0,8))}...)" -ForegroundColor Green
if ($mistral) { Write-Host "MISTRAL_API_KEY found" -ForegroundColor Green }

# Step 2: Update the scheduled task to pass env vars explicitly
$repoPath = "C:\Users\Perry\DevProjects\claude-budget-dispatcher"
$nodeExe = (Get-Command node).Source

# Build the command that sets env vars then runs dispatch
$envBlock = "`$env:GEMINI_API_KEY='$gemini';"
if ($mistral) { $envBlock += " `$env:MISTRAL_API_KEY='$mistral';" }
$envBlock += " & '$nodeExe' 'scripts/dispatch.mjs' --engine auto"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -Command `"$envBlock`"" `
    -WorkingDirectory $repoPath

# Step 3: Apply to existing task
try {
    Set-ScheduledTask -TaskName "BudgetDispatcher-Node" -Action $action
    Write-Host "`nScheduled task updated with embedded API keys." -ForegroundColor Green
    Write-Host "Next run will have GEMINI_API_KEY available."
} catch {
    Write-Host "ERROR: Could not update scheduled task. Run as Administrator?" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

# Step 4: Verify
Write-Host "`n--- Verification ---"
$task = Get-ScheduledTask -TaskName "BudgetDispatcher-Node"
Write-Host "Task state: $($task.State)"
Write-Host "Next run:   $((Get-ScheduledTaskInfo -TaskName 'BudgetDispatcher-Node').NextRunTime)"
Write-Host "`nDone. Run 'node scripts/dispatch.mjs --force' to test immediately."

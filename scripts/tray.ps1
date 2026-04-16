# Budget Dispatcher -- system tray app.
# Sits in the notification area showing dispatcher health (green/yellow/red).
# Right-click for actions: open dashboard, switch engine, pause, dispatch.
# Start: powershell -NoProfile -WindowStyle Hidden -File scripts/tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- Paths ----
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$assetsDir = Join-Path $repoRoot 'assets'
$launcher  = Join-Path $scriptDir 'dashboard-launcher.cmd'

$API_BASE = 'http://localhost:7380'
$POLL_INTERVAL_MS = 30000
$script:lastPaused = $false

# ---- Single-instance guard (named mutex) ----
$mutexName = 'Global\claude-budget-dispatcher-tray'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$owned = $false
try { $owned = $mutex.WaitOne(0, $false) } catch { }
if (-not $owned) {
    # Another tray instance is running
    $mutex.Dispose()
    exit 0
}

# ---- Load icons ----
function Load-Icon([string]$name) {
    $path = Join-Path $assetsDir "tray-$name.ico"
    if (Test-Path $path) {
        return New-Object System.Drawing.Icon($path)
    }
    # Fallback: use default app icon
    return [System.Drawing.SystemIcons]::Application
}

$iconGreen  = Load-Icon 'green'
$iconYellow = Load-Icon 'yellow'
$iconRed    = Load-Icon 'red'

# ---- HTTP helper ----
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8

function Api-Get([string]$path) {
    try {
        $json = $wc.DownloadString("$API_BASE$path")
        return $json | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Api-Post([string]$path, [string]$body) {
    try {
        $wc.Headers['Content-Type'] = 'application/json'
        $null = $wc.UploadString("$API_BASE$path", 'POST', $body)
    } catch { }
}

# ---- Build context menu ----
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('Open Dashboard')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.Add_Click({
    Start-Process $launcher
})

$null = $menu.Items.Add('-')

$miAuto  = $menu.Items.Add('Engine: Auto')
$miNode  = $menu.Items.Add('Engine: Free Only')
$miClaude = $menu.Items.Add('Engine: Claude')

$miAuto.Add_Click({
    Api-Post '/api/engine' '{"engine":"auto"}'
    Update-Status
})
$miNode.Add_Click({
    Api-Post '/api/engine' '{"engine":"node"}'
    Update-Status
})
$miClaude.Add_Click({
    Api-Post '/api/engine' '{"engine":"claude"}'
    Update-Status
})

$null = $menu.Items.Add('-')

$miPause = $menu.Items.Add('Pause')
$miPause.Add_Click({
    $isPaused = $script:lastPaused
    $target = if ($isPaused) { 'false' } else { 'true' }
    Api-Post '/api/pause' "{`"paused`":$target}"
    Update-Status
})

$miDispatch = $menu.Items.Add('Dispatch Now')
$miDispatch.Add_Click({
    Api-Post '/api/dispatch' '{"dry_run":false}'
})

$null = $menu.Items.Add('-')

$miQuit = $menu.Items.Add('Quit')
$miQuit.Add_Click({
    $timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# ---- Create NotifyIcon ----
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconGreen
$tray.Text = 'Budget Dispatcher'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

# Double-click opens dashboard
$tray.Add_DoubleClick({
    Start-Process $launcher
})

# ---- Status polling ----
function Update-Status {
    $state = Api-Get '/api/state'

    if ($null -eq $state) {
        $tray.Icon = $iconRed
        $tray.Text = 'Budget Dispatcher: Dashboard offline'
        $miPause.Text = 'Pause'
        $miAuto.Checked = $false; $miNode.Checked = $false; $miClaude.Checked = $false
        return
    }

    # Determine health level
    $isPaused = $state.paused -or $state.pause_file_exists
    $script:lastPaused = $isPaused
    $recentErrors = 0
    if ($state.recent_logs) {
        foreach ($log in $state.recent_logs) {
            if ($recentErrors -ge 3) { break }
            if ($log.outcome -eq 'error') { $recentErrors++ }
        }
    }

    if ($recentErrors -ge 2) {
        $tray.Icon = $iconRed
        $tip = "Errors detected ($recentErrors in recent runs)"
    } elseif ($isPaused) {
        $tray.Icon = $iconYellow
        $tip = 'Paused'
    } elseif ($state.budget -and $state.budget.dispatch_authorized) {
        $tray.Icon = $iconGreen
        $tip = 'Healthy (Claude authorized)'
    } else {
        $tray.Icon = $iconGreen
        $tip = 'Healthy (free models)'
    }

    # Engine info
    $eng = $state.engine_override
    if (-not $eng) { $eng = 'auto' }
    $tip += " | Engine: $eng"

    # Today's runs
    if ($null -ne $state.today_runs) {
        $tip += " | Runs: $($state.today_runs)"
    }

    # Tooltip max 63 chars (Windows limit)
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + '...' }
    $tray.Text = $tip

    # Update menu checkmarks
    $miAuto.Checked  = ($eng -eq 'auto')
    $miNode.Checked  = ($eng -eq 'node')
    $miClaude.Checked = ($eng -eq 'claude')

    # Pause button text
    $miPause.Text = if ($isPaused) { 'Resume' } else { 'Pause' }
}

# ---- Timer for periodic polling ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $POLL_INTERVAL_MS
$timer.Add_Tick({ Update-Status })
$timer.Start()

# Initial poll
Update-Status

# ---- Cleanup on exit ----
function Cleanup-Resources {
    $tray.Visible = $false
    $tray.Dispose()
    $wc.Dispose()
    $iconGreen.Dispose()
    $iconYellow.Dispose()
    $iconRed.Dispose()
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}

$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Cleanup-Resources
}

# ---- Run message loop (blocks until Application.Exit) ----
[System.Windows.Forms.Application]::Run()

Cleanup-Resources

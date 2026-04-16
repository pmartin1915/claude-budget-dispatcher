# Generates tray icon .ico files for the Budget Dispatcher system tray app.
# Run once: powershell -File scripts/tray-icons.ps1
# Produces: assets/tray-green.ico, assets/tray-yellow.ico, assets/tray-red.ico

Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$assetsDir = Join-Path (Split-Path -Parent $scriptDir) 'assets'

if (-not (Test-Path $assetsDir)) {
    New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
}

$colors = @{
    green  = [System.Drawing.Color]::FromArgb(158, 206, 106)  # matches dashboard --green
    yellow = [System.Drawing.Color]::FromArgb(224, 175, 104)  # matches dashboard --yellow
    red    = [System.Drawing.Color]::FromArgb(247, 118, 142)  # matches dashboard --red
}

foreach ($name in $colors.Keys) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $brush = New-Object System.Drawing.SolidBrush($colors[$name])
    $g.FillEllipse($brush, 1, 1, 13, 13)

    # Subtle border for visibility on both light and dark taskbars
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 0, 0, 0), 1)
    $g.DrawEllipse($pen, 1, 1, 13, 13)

    $g.Dispose()
    $brush.Dispose()
    $pen.Dispose()

    $iconPath = Join-Path $assetsDir "tray-$name.ico"
    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $fs = [System.IO.File]::Create($iconPath)
    $icon.Save($fs)
    $fs.Close()
    $icon.Dispose()
    $bmp.Dispose()

    Write-Host "Created $iconPath"
}

Write-Host 'Done. 3 icons generated in assets/'

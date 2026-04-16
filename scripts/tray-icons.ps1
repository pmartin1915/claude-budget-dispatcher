# Generates tray icon .ico files for the Budget Dispatcher system tray app.
# Run once: powershell -File scripts/tray-icons.ps1
# Produces: assets/tray-green.ico, assets/tray-yellow.ico, assets/tray-red.ico
# Uses PNG-in-ICO format for 32-bit ARGB with proper transparency.

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
    $bmp = New-Object System.Drawing.Bitmap(16, 16, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
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

    # Save bitmap as PNG into memory
    $pngStream = New-Object System.IO.MemoryStream
    $bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()
    $pngStream.Dispose()
    $bmp.Dispose()

    # Write ICO file with embedded PNG (supported Vista+)
    $iconPath = Join-Path $assetsDir "tray-$name.ico"
    $fs = [System.IO.File]::Create($iconPath)
    $bw = New-Object System.IO.BinaryWriter($fs)

    # ICONDIR header
    $bw.Write([uint16]0)      # reserved
    $bw.Write([uint16]1)      # type = ICO
    $bw.Write([uint16]1)      # count = 1 image

    # ICONDIRENTRY
    $bw.Write([byte]16)       # width
    $bw.Write([byte]16)       # height
    $bw.Write([byte]0)        # colors (0 = 256+)
    $bw.Write([byte]0)        # reserved
    $bw.Write([uint16]1)      # color planes
    $bw.Write([uint16]32)     # bits per pixel
    $bw.Write([uint32]$pngBytes.Length)  # size of PNG data
    $bw.Write([uint32]22)     # offset to PNG data (6 + 16 = 22)

    # PNG data
    $bw.Write($pngBytes)

    $bw.Dispose()
    $fs.Dispose()

    Write-Host "Created $iconPath ($($pngBytes.Length + 22) bytes, 32-bit PNG-in-ICO)"
}

Write-Host 'Done. 3 icons generated in assets/'

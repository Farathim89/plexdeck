# Copies mpv into vendor/mpv for building PlexDeck (mpv.exe is too big for git).
# Get mpv first:  winget install --id shinchiro.mpv -e
$ErrorActionPreference = "Stop"
$src = @("C:\Program Files\MPV Player", "$env:LOCALAPPDATA\Programs\mpv", "C:\Program Files\mpv") | Where-Object { Test-Path (Join-Path $_ "mpv.exe") } | Select-Object -First 1
if (-not $src) { Write-Error "mpv not found. Install it with:  winget install --id shinchiro.mpv -e"; exit 1 }
$dest = Join-Path $PSScriptRoot "..\vendor\mpv"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $src "mpv.exe") $dest -Force
$d3d = Join-Path $src "d3dcompiler_43.dll"
if (Test-Path $d3d) { Copy-Item $d3d $dest -Force }
Write-Host "mpv copied from $src to $dest"
& (Join-Path $dest "mpv.exe") --version | Select-Object -First 1

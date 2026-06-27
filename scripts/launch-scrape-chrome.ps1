# launch-scrape-chrome.ps1
# Ensure the scrape debug Chrome (remote-debugging port 9222) is up.
# Idempotent wrapper around launch-scrape-chrome.vbs:
#   probe 9222 -> if up, nothing to do -> else wscript the .vbs -> wait -> re-probe.
#
# WHY THIS EXISTS (and why it must be called via RELATIVE path from the repo root):
# The repo path contains Chinese (F:\...\). When Claude runs the launch from the
# Bash tool, any Chinese literal on the command line is sent UTF-8 by bash but
# decoded as GBK by powershell.exe/cmd.exe -> the path garbles -> wscript cannot
# find the .vbs -> Chrome never starts (this is exactly what triggered the
# 2026-06-27 `ask hard-timeout`: Chrome never launched, Claude spiraled debugging
# chrome.exe and hung for 15 min).
#
# This script is ASCII-only and derives every path at runtime from $PSScriptRoot
# (Windows API returns UTF-16, so Chinese in the actual path is handled correctly
# with ZERO Chinese ever crossing the bash->powershell command-line boundary).
# Claude invokes it as:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/launch-scrape-chrome.ps1
# (relative path, no Chinese on the command line; cwd is the repo root).
#
# Exit / stdout contract (so Claude can branch without parsing screen):
#   stdout "READY ..." + exit 0  -> 9222 is listening, proceed to chrome-devtools
#   stdout "FAILED ..." + exit 2  -> could not bring 9222 up, stop and report user
$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot                                   # ...\scripts (UTF-16, correct)
$vbs = Join-Path $here 'launch-scrape-chrome.vbs'

function Test-Port9222 {
  try { return ((Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) }
  catch { return $false }
}

if (Test-Port9222) { Write-Output 'READY (already up)'; exit 0 }

if (-not (Test-Path $vbs)) { Write-Output ('FAILED: vbs not found at ' + $vbs); exit 2 }

# not up -> launch via wscript (no console window; vbs starts Chrome async and returns)
wscript $vbs
Start-Sleep -Seconds 4
if (Test-Port9222) { Write-Output 'READY (launched)'; exit 0 }

# slow start / busy machine: one more wait
Start-Sleep -Seconds 3
if (Test-Port9222) { Write-Output 'READY (launched, slow start)'; exit 0 }

Write-Output 'FAILED: 9222 not up after launch'
exit 2

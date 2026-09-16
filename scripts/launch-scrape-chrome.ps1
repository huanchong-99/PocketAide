# launch-scrape-chrome.ps1
# Ensure the scrape debug Chrome (remote-debugging port 19222) is up.
# Idempotent wrapper around launch-scrape-chrome.vbs:
#   probe 19222 -> if up, nothing to do -> else wscript the .vbs -> wait -> re-probe.
#
# PORT HISTORY (why 19222, not the usual 9222): Windows randomly reserves 100-port
# blocks for Hyper-V/WinNAT inside the TCP dynamic port range ON EVERY BOOT. That
# range varies per machine (check: netsh int ipv4 show dynamicport tcp) and on boxes
# with Hyper-V/WSL enabled it often starts as low as 1024, so any port below ~15000
# can silently die after a reboot. That is exactly what happened to 9222 here: the
# reserved block landed on 9211-9310, Chrome started fine but could not bind the
# port (WSAEACCES) and gave NO error at all. 19222 sits outside the dynamic range,
# so the OS can never reserve it. If you change the port, change it EVERYWHERE:
# launch-scrape-chrome.vbs, .mcp.json, the web-scrape / video-note skills, and
# tools/test/scenarios.js.
#
# WHY THIS EXISTS (and why it must be called via RELATIVE path from the repo root):
# If the repo path contains non-ASCII characters (Chinese, etc.), any such literal
# on the command line is sent UTF-8 by bash but decoded as the system codepage by
# powershell.exe/cmd.exe -> the path garbles -> wscript cannot find the .vbs ->
# Chrome never starts. That failure is silent and expensive: the agent sees only
# "no Chrome", starts debugging chrome.exe, and can hang for many minutes.
#
# This script is ASCII-only and derives every path at runtime from $PSScriptRoot
# (the Windows API returns UTF-16, so non-ASCII characters in the real path are
# handled correctly with ZERO of them ever crossing the bash->powershell boundary).
# Invoke it as:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/launch-scrape-chrome.ps1
# (relative path, no non-ASCII on the command line; cwd is the repo root).
#
# Exit / stdout contract (so the caller can branch without parsing the screen):
#   stdout "READY ..." + exit 0   -> 19222 is listening, proceed to chrome-devtools
#   stdout "FAILED ..." + exit 2  -> could not bring 19222 up, stop and report user
$ErrorActionPreference = 'SilentlyContinue'
$port = 19222
$here = $PSScriptRoot                                   # ...\scripts (UTF-16, correct)
$vbs = Join-Path $here 'launch-scrape-chrome.vbs'

function Test-DebugPort {
  try { return ((Invoke-WebRequest ('http://127.0.0.1:' + $port + '/json/version') -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) }
  catch { return $false }
}

# Chrome fails SILENTLY when it cannot bind the debug port, so diagnose the two
# known bind blockers up front and name them in the FAILED message:
#   AccessDenied        -> Windows reserved the port (excluded port range, see above)
#   AddressAlreadyInUse -> some other program is listening on it
function Get-BindBlocker {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    $l.Start(); $l.Stop(); return ''
  } catch {
    $se = $_.Exception.InnerException
    if ($se -and $se.SocketErrorCode -eq 'AccessDenied') { return 'reserved' }
    if ($se -and $se.SocketErrorCode -eq 'AddressAlreadyInUse') { return 'inuse' }
    return 'unknown (' + $(if ($se) { $se.Message } else { $_.Exception.Message }) + ')'
  }
}

if (Test-DebugPort) { Write-Output 'READY (already up)'; exit 0 }

$blocker = Get-BindBlocker
if ($blocker -eq 'reserved') {
  Write-Output ('FAILED: port ' + $port + ' is reserved by Windows (excluded port range; check: netsh int ipv4 show excludedportrange protocol=tcp). Chrome cannot bind it. Do NOT retry launching; report to user.')
  exit 2
}
if ($blocker -eq 'inuse') {
  Write-Output ('FAILED: another process is already listening on port ' + $port + ' but it is not the scrape Chrome (json/version probe failed). Check: netstat -ano | findstr :' + $port)
  exit 2
}

if (-not (Test-Path $vbs)) { Write-Output ('FAILED: vbs not found at ' + $vbs); exit 2 }

# not up -> launch via wscript (no console window; vbs starts Chrome async and returns)
wscript $vbs
Start-Sleep -Seconds 4
if (Test-DebugPort) { Write-Output 'READY (launched)'; exit 0 }

# slow start / busy machine: one more wait
Start-Sleep -Seconds 3
if (Test-DebugPort) { Write-Output 'READY (launched, slow start)'; exit 0 }

# A stale scrape Chrome holding the profile WITHOUT a live debug port swallows
# new launches (Chrome singleton hands off and drops the port flag). Hint it.
Write-Output ('FAILED: ' + $port + ' not up after launch. If a scrape Chrome window is open, a stale instance may hold the profile: run scripts/close-scrape-chrome.ps1 once, then retry this script.')
exit 2

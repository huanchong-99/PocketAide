# close-scrape-chrome.ps1
# Close ONLY the scrape debug Chrome (the instance launched with a
# --remote-debugging-port / the dedicated .scrape-chrome-profile). Never touches
# your normal daily Chrome, because we match on the dedicated profile path /
# debug port in the command line. Port-agnostic on purpose: also cleans up
# strays left over from before the 9222 -> 19222 port move.
$ErrorActionPreference = 'SilentlyContinue'
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'scrape-chrome-profile' -or $_.CommandLine -match 'remote-debugging-port=\d+' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
Write-Output "closed scrape chrome processes: $killed"

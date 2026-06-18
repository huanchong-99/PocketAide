# register-archive.ps1 -- register the daily task archiver as a Windows Scheduled Task.
# ASCII-only by design (PS5.1 reads a no-BOM script as GBK; any non-ASCII char would corrupt).
# The repo path contains Chinese, so NO Chinese path is ever written into the runner .ps1;
# the runner derives every path from $PSScriptRoot at runtime (it lives in tasks\archive\,
# so repo = two levels up). archive.py itself is NOT modified by this script.
#
#   Register (default: runs at every logon):
#       powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1
#   Register daily at a fixed wall-clock time (local floating, catches up if missed):
#       powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1 -Mode daily -At 03:00
#   Verify (registers a task that runs archive.py --dry-run -- touches nothing):
#       powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1 -DryRun
#   Remove:
#       powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1 -Remove
#
# The scheduled task launches a generated runner (.archive-runner.ps1) that calls
#   python tools\tasks\archive.py --days <N> [ --dry-run ]
# captures stdout + exit code, and appends one line to tasks\archive\archive.log.
# archive.py is idempotent and skips anything not done / not past retention, so running
# multiple times a day (e.g. several logons) is harmless.

param(
    # Trigger mode. 'logon' = at every logon (default; never missed since logon is required to
    # use the PC). 'daily' = every day at -At (local floating; -StartWhenAvailable catches up).
    [ValidateSet('logon','daily')][string]$Mode = 'logon',
    # daily only: wall-clock time "HH:mm". Ignored in logon mode.
    [string]$At = '09:00',
    # Retention days before a done task is archived (passed to archive.py --days). Default 7.
    [int]$Days = 7,
    # Register a task that runs archive.py --dry-run (verification; no file is moved/deleted).
    [switch]$DryRun,
    # Unregister the task and delete the generated runner + log.
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'PocketAide-Archive'
$Repo       = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ArchiveDir = Join-Path $Repo 'tasks\archive'
$ArchivePy  = Join-Path $Repo 'tools\tasks\archive.py'
$runnerFile = Join-Path $ArchiveDir '.archive-runner.ps1'
$logFile    = Join-Path $ArchiveDir 'archive.log'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Task '$TaskName' not found; nothing to remove."
    }
    Remove-Item -LiteralPath $runnerFile, $logFile -Force -ErrorAction SilentlyContinue
    return
}

if (-not (Test-Path $ArchivePy)) { throw "tools\tasks\archive.py not found at $ArchivePy" }
if (-not (Test-Path $ArchiveDir)) { New-Item -ItemType Directory -Path $ArchiveDir -Force | Out-Null }

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw "python not found on PATH (archive.py needs it). Ensure python is on PATH." }

# --- build the runner .ps1 (ASCII-only) ---
# CRITICAL: the repo path contains Chinese, so no path may be a literal here (ASCII encoding
# would turn the Chinese into '?' and break the runner). The runner derives every path from
# $PSScriptRoot at runtime: it lives in tasks\archive\, so repo = two levels up.
$dryLine = if ($DryRun) { '$a += ''--dry-run''' } else { '' }

$runner = @"
# AUTO-GENERATED runner for archive (ASCII-only). Do not edit by hand.
# All paths derived from `$PSScriptRoot at runtime; no non-ASCII path literal is needed.
`$ErrorActionPreference = 'Continue'
`$archiveDir = `$PSScriptRoot
`$repo       = (Resolve-Path (Join-Path `$archiveDir '..\..')).Path
`$logFile    = Join-Path `$archiveDir 'archive.log'
`$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not `$py) { `$py = 'python' }
Set-Location `$repo
`$prevEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# Force Python stdout to UTF-8 too; Chinese Windows defaults to cp936, which would garble the
# log (Console is set to UTF-8 above). Setting only Console side would mismatch and corrupt.
`$env:PYTHONIOENCODING = 'utf-8'
`$a = @('tools\tasks\archive.py', '--days', '$Days')
$dryLine
`$out  = & `$py @a 2>&1
`$code = `$LASTEXITCODE
try { [Console]::OutputEncoding = `$prevEnc } catch {}
`$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
`$one = (`$out -join ' ') -replace '\s+',' '
"`$ts exit=`$code `$one" | Out-File -FilePath `$logFile -Append -Encoding UTF8
exit `$code
"@

# Write runner as ASCII (no BOM). Guard: refuse if any non-ASCII slipped in.
$asciiEnc = New-Object System.Text.ASCIIEncoding
if ($runner -match '[^\x00-\x7F]') { throw "Runner content has non-ASCII chars; aborting to avoid corruption." }
[System.IO.File]::WriteAllText($runnerFile, $runner, $asciiEnc)

# --- build trigger ---
# Run as the current interactive user either way (reliable access to repo files; archive.py
# is plain file I/O, but staying in the user session avoids any SYSTEM-vs-user boundary).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($Mode -eq 'logon') {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
} else {
    $when = [datetime]::Parse($At)
    $trigger = New-ScheduledTaskTrigger -Daily -At $when
    # Floating LOCAL time: replace the UTC 'Z' StartBoundary that PowerShell emits by default
    # with an offset-free string, so the task fires at that wall-clock time under the PC's
    # CURRENT timezone (follows the system clock). -StartWhenAvailable (settings) also makes it
    # catch up after a shutdown/restart that missed the slot.
    $trigger.StartBoundary = $when.ToString('yyyy-MM-ddTHH:mm:ss')
}

$runnerArg = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$runnerFile`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runnerArg -WorkingDirectory $Repo
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered: $TaskName"
Write-Host "  mode    : $Mode"
if ($Mode -eq 'daily') { Write-Host "  at      : $At (local floating)" }
Write-Host "  days    : $Days"
Write-Host "  dry-run : $(if($DryRun){'yes (verifies, touches nothing)'}else{'no (real archive)'})"
Write-Host "  runner  : $runnerFile"
Write-Host "  log     : $logFile"

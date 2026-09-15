# register-panel-weekly.ps1 -- register the weekly task health push as a Windows Scheduled Task.
# ASCII-only by design (PS5.1 reads a no-BOM script as GBK; any non-ASCII char would corrupt).
# The repo path contains Chinese, so NO Chinese path is ever written into the runner .ps1;
# the runner derives every path from $PSScriptRoot at runtime (it lives in tasks\reminders\,
# so repo = two levels up).
#
# Why NOT register-reminder.ps1: that one pushes a FIXED text written into a sidecar at
# registration time. This push must be COMPUTED at fire time (stale days, overdue, duplicates
# all move). So it is the same family as register-archive.ps1 -- run a script on a schedule --
# not the same family as a static reminder.
#
#   Register (default: every Monday 09:00 local):
#       powershell -ExecutionPolicy Bypass -File scripts\register-panel-weekly.ps1
#   Another day/time:
#       powershell -ExecutionPolicy Bypass -File scripts\register-panel-weekly.ps1 -DayOfWeek Friday -At 18:00
#   Verify (runs weekly.js --dry-run: computes and logs, sends nothing to Feishu):
#       powershell -ExecutionPolicy Bypass -File scripts\register-panel-weekly.ps1 -DryRun
#   Remove:
#       powershell -ExecutionPolicy Bypass -File scripts\register-panel-weekly.ps1 -Remove
#
# The task launches a generated runner (.panel-weekly-runner.ps1) that calls
#   node tools\panel\weekly.js [--dry-run]
# and appends one line (timestamp + exit code + collapsed output) to
# tasks\reminders\panel-weekly.log.
#
# The push does NOT need the panel server or the bridge to be running: weekly.js reads the task
# files off disk and calls bridge\send-reminder.js directly. That is the whole point -- a task
# stalled for 92 days will not open the panel by itself, but it will show up in this message.

param(
    # Day of the weekly trigger.
    [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
    [string]$DayOfWeek = 'Monday',
    # Wall-clock time "HH:mm". Local floating (follows the PC's current timezone).
    [string]$At = '09:00',
    # Register a task that runs weekly.js --dry-run (computes + logs, sends nothing).
    [switch]$DryRun,
    # Unregister the task and delete the generated runner + log.
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'PocketAide-PanelWeekly'
$Repo       = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RemindDir  = Join-Path $Repo 'tasks\reminders'
$WeeklyJs   = Join-Path $Repo 'tools\panel\weekly.js'
$runnerFile = Join-Path $RemindDir '.panel-weekly-runner.ps1'
$logFile    = Join-Path $RemindDir 'panel-weekly.log'

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

if (-not (Test-Path $WeeklyJs))  { throw "tools\panel\weekly.js not found at $WeeklyJs" }
if (-not (Test-Path $RemindDir)) { New-Item -ItemType Directory -Path $RemindDir -Force | Out-Null }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH (weekly.js needs it). Ensure node is on PATH." }

# --- build the runner .ps1 (ASCII-only) ---
# CRITICAL: no path may be a literal here (ASCII encoding would turn the repo's Chinese into '?'
# and break the runner). The runner lives in tasks\reminders\, so repo = two levels up.
$dryLine = if ($DryRun) { '$a += ''--dry-run''' } else { '' }

$runner = @"
# AUTO-GENERATED runner for the weekly task health push (ASCII-only). Do not edit by hand.
# All paths derived from `$PSScriptRoot at runtime; no non-ASCII path literal is needed.
`$ErrorActionPreference = 'Continue'
`$remindDir = `$PSScriptRoot
`$repo      = (Resolve-Path (Join-Path `$remindDir '..\..')).Path
`$logFile   = Join-Path `$remindDir 'panel-weekly.log'
`$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not `$node) { `$node = 'node' }
Set-Location `$repo
`$prevEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
`$a = @('tools\panel\weekly.js')
$dryLine
`$out  = & `$node @a 2>&1
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
# Interactive user: send-reminder.js reads bridge credentials from the user profile.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$when    = [datetime]::Parse($At)
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $when
# Floating LOCAL time: PowerShell writes StartBoundary as UTC with a 'Z' by default, which would
# drift to the wrong wall-clock hour after a timezone change. Strip it to an offset-free string.
$trigger.StartBoundary = $when.ToString('yyyy-MM-ddTHH:mm:ss')

$runnerArg = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$runnerFile`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runnerArg -WorkingDirectory $Repo
# -StartWhenAvailable: catch up if the PC was off at the slot. -WakeToRun: fire from sleep.
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered: $TaskName"
Write-Host "  when    : every $DayOfWeek $At (local floating)"
Write-Host "  dry-run : $(if($DryRun){'yes (computes + logs, sends nothing)'}else{'no (real Feishu push)'})"
Write-Host "  runner  : $runnerFile"
Write-Host "  log     : $logFile"

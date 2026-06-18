# register-reminder.ps1 -- register a Feishu reminder as a Windows Scheduled Task.
# ASCII-only by design (PS5.1 reads no-BOM scripts as GBK; non-ASCII would corrupt).
# Chinese body/title are NEVER written into any .ps1; they live in UTF-8 sidecar files
# and are read at runtime with -Encoding UTF8, then passed to node.
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-reminder.ps1 `
#       -Name buy-milk -Text "<body markdown>" -Title "<title>" -Mode once  -At "2026-06-16 18:30"
#       -Name standup  -Text "<body markdown>" -Title "<title>" -Mode daily -At "09:00"
#       -Name weekly   -Text "<body markdown>" -Title "<title>" -Mode weekly -At "09:00" -DayOfWeek Monday
#       -Name bkk      -Text "<body markdown>" -Title "<title>" -Mode once  -At "2026-06-16 18:00" -TimeZone "SE Asia Standard Time"
#
# Modes: once | daily | weekly
#   once   -At = full datetime ("yyyy-MM-dd HH:mm") -> fires once, then SELF-DELETES.
#   daily  -At = time of day ("HH:mm")             -> fires every day, KEPT.
#   weekly -At = time of day, plus -DayOfWeek       -> fires weekly on that day, KEPT.
#
# Timezone:
#   (default, no -TimeZone) -At is the LOCAL wall-clock time -> trigger FLOATS with the PC's
#       current timezone (fires at that wall-clock time; follows the system clock).
#   -TimeZone "<id|offset>"  -> -At is wall-clock IN THAT timezone; the trigger is PINNED to the
#       matching absolute instant (UTC), so it fires when that zone reaches the time no matter the
#       PC's own timezone. Use when the user EXPLICITLY names a timezone -- works for ANY country,
#       not a fixed list. Accepts (a) any Windows tz id (~140 zones; DST handled by the Windows tz
#       DB) e.g. "India Standard Time", "W. Europe Standard Time"(Germany), "Eastern Standard
#       Time"(US East), or (b) a raw offset "UTC+7" / "GMT-3" / "+05:30". List all ids with:
#       [System.TimeZoneInfo]::GetSystemTimeZones() | Select Id,DisplayName,BaseUtcOffset

param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Text,
    [string]$Title = 'reminder',
    [Parameter(Mandatory=$true)][ValidateSet('once','daily','weekly')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$At,
    [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
    [string]$DayOfWeek = 'Monday',
    # Optional: a Windows time zone id. Empty => default floating local time (follow system clock).
    [string]$TimeZone = ''
)

$ErrorActionPreference = 'Stop'

# Validate slug: ASCII letters/digits/dash/underscore only (used in task name + filenames).
if ($Name -notmatch '^[A-Za-z0-9_-]+$') {
    throw "Name (slug) must be ASCII letters/digits/dash/underscore only. Got: $Name"
}

$Repo      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RemindDir = Join-Path $Repo 'tasks\reminders'
$Sender    = Join-Path $Repo 'bridge\send-reminder.js'
$TaskName  = "PocketAide-Remind-$Name"

if (-not (Test-Path $RemindDir)) { New-Item -ItemType Directory -Path $RemindDir -Force | Out-Null }
if (-not (Test-Path $Sender))    { throw "send-reminder.js not found at $Sender" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH." }

# --- sidecar files (UTF-8, hold Chinese) ---
$bodyFile   = Join-Path $RemindDir "$Name.body.txt"
$titleFile  = Join-Path $RemindDir "$Name.title.txt"
$runnerFile = Join-Path $RemindDir "$Name.runner.ps1"
$recordFile = Join-Path $RemindDir "$Name.md"

# Write body/title as UTF-8 (no BOM) so node reads them cleanly.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($bodyFile,  $Text,  $utf8NoBom)
[System.IO.File]::WriteAllText($titleFile, $Title, $utf8NoBom)

# --- build the runner .ps1 (ASCII-only) ---
# CRITICAL: the repo path contains Chinese, so NO path may be hardcoded as a literal
# (ASCII encoding would turn the Chinese into '?' and break the runner). Instead the
# runner derives every path from $PSScriptRoot at runtime: it lives in tasks\reminders\,
# so repo = two levels up. Only the ASCII-validated slug appears as a literal.
$selfDelete = ''
if ($Mode -eq 'once') {
    $selfDelete = @"
    # once: fired -> unregister self and delete own files
    try { Unregister-ScheduledTask -TaskName `$taskName -Confirm:`$false -ErrorAction SilentlyContinue } catch {}
    Remove-Item -LiteralPath `$bodyFile, `$titleFile, `$recordFile, `$runnerFile -Force -ErrorAction SilentlyContinue
"@
}

$runner = @"
# AUTO-GENERATED runner for reminder '$Name' (ASCII-only). Do not edit by hand.
# All paths derived from `$PSScriptRoot at runtime so no non-ASCII path literal is needed.
`$ErrorActionPreference = 'Continue'
`$slug       = '$Name'
`$taskName   = '$TaskName'
`$remindDir  = `$PSScriptRoot
`$repo       = (Resolve-Path (Join-Path `$remindDir '..\..')).Path
`$sender     = Join-Path `$repo 'bridge\send-reminder.js'
`$bodyFile   = Join-Path `$remindDir (`$slug + '.body.txt')
`$titleFile  = Join-Path `$remindDir (`$slug + '.title.txt')
`$recordFile = Join-Path `$remindDir (`$slug + '.md')
`$runnerFile = Join-Path `$remindDir (`$slug + '.runner.ps1')
`$logFile    = Join-Path `$remindDir (`$slug + '.log')
`$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not `$node) { `$node = 'node' }
Set-Location `$repo
`$body  = Get-Content -LiteralPath `$bodyFile  -Raw -Encoding UTF8
`$title = Get-Content -LiteralPath `$titleFile -Raw -Encoding UTF8
# Force UTF-8 so argv reaches node uncorrupted.
`$prevEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
`$out = & `$node `$sender `$body `$title 2>&1
`$code = `$LASTEXITCODE
try { [Console]::OutputEncoding = `$prevEnc } catch {}
"`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') exit=`$code `$out" | Out-File -FilePath `$logFile -Append -Encoding UTF8
if (`$code -eq 0) {
$selfDelete
}
"@

# Write runner as ASCII (no BOM). Guard: refuse if any non-ASCII slipped in.
$asciiEnc = New-Object System.Text.ASCIIEncoding
if ($runner -match '[^\x00-\x7F]') { throw "Runner content has non-ASCII chars; aborting to avoid corruption." }
[System.IO.File]::WriteAllText($runnerFile, $runner, $asciiEnc)

# --- build trigger ---
# $At is a wall-clock time string ("yyyy-MM-dd HH:mm" for once, "HH:mm" for daily/weekly).
$when = [datetime]::Parse($At)
switch ($Mode) {
    'once'   { $trigger = New-ScheduledTaskTrigger -Once   -At $when }
    'daily'  { $trigger = New-ScheduledTaskTrigger -Daily  -At $when }   # time-of-day; date part ignored
    'weekly' { $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $when }
}

# TIMEZONE SEMANTICS (the whole point of the StartBoundary override below):
# PowerShell's New-ScheduledTaskTrigger writes StartBoundary in UTC ("...Z"), i.e. "synchronize
# across time zones" -- it would fire at a DIFFERENT wall-clock time if the PC's timezone changed.
# We replace StartBoundary explicitly so the behavior is exactly what the caller asked for:
if ([string]::IsNullOrWhiteSpace($TimeZone)) {
    # DEFAULT: floating LOCAL time. Emit offset-free ("yyyy-MM-ddTHH:mm:ss", no 'Z") so the task
    # fires at that wall-clock time under the PC's CURRENT timezone (follows the system clock).
    # With -StartWhenAvailable (settings below) it also catches up after shutdown/restart.
    if ($Mode -eq 'once' -and $when -le (Get-Date)) { throw "once -At must be in the future. Got: $At (now $(Get-Date))" }
    $trigger.StartBoundary = $when.ToString('yyyy-MM-ddTHH:mm:ss')
} else {
    # EXPLICIT timezone -- works for ANY country/zone the user names, not a fixed list. Treat $At as
    # wall-clock IN that zone and PIN to the matching absolute instant (UTC 'Z'), so it fires when
    # THAT zone reaches the time regardless of the PC's own timezone.
    # Accept EITHER: (a) any Windows time zone id (~140 zones, every country; DST handled by the
    # Windows tz database), OR (b) a raw UTC offset like "UTC+7" / "GMT-3" / "+05:30" / "-0500"
    # (fixed offset, no DST) -- a fallback for when a raw offset is given instead of a zone name.
    $wall = [datetime]::SpecifyKind($when, [System.DateTimeKind]::Unspecified)
    $tzi = $null
    try { $tzi = [System.TimeZoneInfo]::FindSystemTimeZoneById($TimeZone) } catch {}
    if ($tzi) {
        $utc = [System.TimeZoneInfo]::ConvertTimeToUtc($wall, $tzi)
    } else {
        $om = [regex]::Match($TimeZone.Trim(), '^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$', 'IgnoreCase')
        if (-not $om.Success) {
            throw "Unknown -TimeZone '$TimeZone'. Pass a Windows time zone id for ANY country (list them: [System.TimeZoneInfo]::GetSystemTimeZones() | Select Id,DisplayName,BaseUtcOffset; e.g. 'India Standard Time', 'W. Europe Standard Time', 'Eastern Standard Time'), OR a raw UTC offset like 'UTC+7' / 'GMT-3' / '+05:30'."
        }
        $sign = if ($om.Groups[1].Value -eq '-') { -1 } else { 1 }
        $mins = $sign * ([int]$om.Groups[2].Value * 60 + $(if ($om.Groups[3].Success) { [int]$om.Groups[3].Value } else { 0 }))
        $utc  = $wall.AddMinutes(-$mins)   # wall-clock at that offset -> UTC
    }
    if ($Mode -eq 'once' -and $utc -le [datetime]::UtcNow) { throw "once -At (in $TimeZone) must be in the future. Got: $At ($TimeZone)" }
    $trigger.StartBoundary = $utc.ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
}

$runnerArg = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$runnerFile`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runnerArg -WorkingDirectory $Repo
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# --- record file (UTF-8 md, holds Chinese) ---
$createdAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
# NOTE: record body kept ASCII-only here; $Title/$Text carry the Chinese (via params).
$weeklyNote = if ($Mode -eq 'weekly') { " ($DayOfWeek)" } else { '' }
$tzNote     = if ([string]::IsNullOrWhiteSpace($TimeZone)) { 'local (system clock)' } else { $TimeZone }
$record = @"
---
type: reminder
slug: $Name
task: $TaskName
mode: $Mode
at: $At
timezone: $tzNote
day_of_week: $DayOfWeek
created: $createdAt
---

# Reminder: $Title

## Mode
$Mode @ $At$weeklyNote [tz: $tzNote]

## Body
$Text

## ScheduledTask
$TaskName
"@
[System.IO.File]::WriteAllText($recordFile, $record, $utf8NoBom)

Write-Host "Registered: $TaskName"
Write-Host "  mode    : $Mode"
Write-Host "  at      : $At$(if($Mode -eq 'weekly'){" ($DayOfWeek)"})"
Write-Host "  tz      : $(if([string]::IsNullOrWhiteSpace($TimeZone)){'local floating (system clock)'}else{$TimeZone + ' (pinned)'})"
Write-Host "  runner  : $runnerFile"
Write-Host "  record  : $recordFile"
Write-Host "  self-del: $(if($Mode -eq 'once'){'yes (after fire)'}else{'no (recurring)'})"

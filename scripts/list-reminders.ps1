# list-reminders.ps1 -- list all PocketAide-Remind-* scheduled tasks + tasks/reminders records.
# ASCII-only.
$ErrorActionPreference = 'Continue'

$Repo      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RemindDir = Join-Path $Repo 'tasks\reminders'

Write-Host "=== Scheduled tasks (PocketAide-Remind-*) ==="
$tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'PocketAide-Remind-*' }
if (-not $tasks) {
    Write-Host "  (none)"
} else {
    foreach ($t in $tasks) {
        $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        $trig = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
        $next = if ($info) { $info.NextRunTime } else { '?' }
        $last = if ($info) { $info.LastRunTime } else { '?' }
        Write-Host ("  - {0}" -f $t.TaskName)
        Write-Host ("      state   : {0}" -f $t.State)
        Write-Host ("      trigger : {0}" -f $trig)
        Write-Host ("      next run: {0}" -f $next)
        Write-Host ("      last run: {0}" -f $last)
    }
}

Write-Host ""
Write-Host "=== Records (tasks/reminders/*.md) ==="
$records = Get-ChildItem -Path $RemindDir -Filter '*.md' -File -ErrorAction SilentlyContinue
if (-not $records) {
    Write-Host "  (none)"
} else {
    foreach ($r in $records) {
        Write-Host ("  - {0}" -f $r.Name)
        # Show a few frontmatter lines so the (possibly Chinese) content is visible.
        $lines = Get-Content -LiteralPath $r.FullName -Encoding UTF8 -TotalCount 12
        foreach ($ln in $lines) {
            if ($ln -match '^(slug|task|mode|at|day_of_week|created):') {
                Write-Host ("      {0}" -f $ln)
            }
        }
    }
}

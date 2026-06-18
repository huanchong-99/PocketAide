# cancel-reminder.ps1 -Name <slug> -- unregister the task + delete runner/sidecar/record.
# ASCII-only. Only ever touches PocketAide-Remind-<slug>; never other system tasks.
param([Parameter(Mandatory=$true)][string]$Name)

$ErrorActionPreference = 'Continue'

if ($Name -notmatch '^[A-Za-z0-9_-]+$') {
    throw "Name (slug) must be ASCII letters/digits/dash/underscore only. Got: $Name"
}

$Repo      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RemindDir = Join-Path $Repo 'tasks\reminders'
$TaskName  = "PocketAide-Remind-$Name"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered task: $TaskName"
} else {
    Write-Host "Task not found (already gone?): $TaskName"
}

$files = @(
    (Join-Path $RemindDir "$Name.body.txt"),
    (Join-Path $RemindDir "$Name.title.txt"),
    (Join-Path $RemindDir "$Name.runner.ps1"),
    (Join-Path $RemindDir "$Name.md"),
    (Join-Path $RemindDir "$Name.log")
)
foreach ($f in $files) {
    if (Test-Path -LiteralPath $f) {
        Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
        Write-Host "Deleted: $f"
    }
}
Write-Host "Cancel done for: $Name"

# Register / remove the bridge autostart (Windows Task Scheduler, trigger = at logon).
# Runs in YOUR user session (ConPTY behaves like a real terminal; avoids Session 0 issues).
# Scope-isolated: one fixed command launching only the bridge tray host, cwd pinned to this repo.
#
#   Register:  powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -Remove
#
# NOTE: do NOT register until bridge\.env is filled (the bridge exits early without creds).

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'PocketAide-Bridge'
$Repo     = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Main     = Join-Path $Repo 'bridge\main.js'
$Vbs      = Join-Path $Repo 'bridge\tray-launch.vbs'
$WScript  = Join-Path $env:SystemRoot 'System32\wscript.exe'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Task '$TaskName' not found; nothing to remove."
    }
    return
}

if (-not (Test-Path $Main)) { throw "bridge\main.js not found at $Main" }
if (-not (Test-Path $Vbs))  { throw "bridge\tray-launch.vbs not found at $Vbs" }

Write-Host "wscript : $WScript"
Write-Host "vbs     : $Vbs"
Write-Host "main    : $Main"
Write-Host "cwd     : $Repo"

# Launch via wscript -> tray-launch.vbs -> hidden PowerShell tray host -> hidden node.
# wscript is a GUI host (no console), so nothing flashes a window; the bridge lives in the
# system tray (NotifyIcon) instead of a visible node/CMD window on the desktop. The tray
# host launches node with CreateNoWindow and owns Restart/Open Log/Exit. Logging is handled
# inside main.js (writes bridge\bridge.log).
$action  = New-ScheduledTaskAction -Execute $WScript -Argument "`"$Vbs`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Interactive principal => runs in your desktop session so ConPTY behaves like a real terminal.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (runs at logon). Remove with -Remove."

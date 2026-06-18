# PocketAide Bridge - system tray host.
# ASCII ONLY (no non-ASCII literals): Windows PowerShell 5.1 reads a no-BOM .ps1 as GBK, so any
# Chinese written here would corrupt. ALL user-facing text lives in bridge\tray-labels.json (UTF-8)
# and is read at runtime with an explicit UTF-8 decoder, which is immune to this file's own encoding.
# Runtime paths (which contain Chinese) come from $PSScriptRoot at run time, not source literals.
#
# It launches `node bridge\main.js` with NO window (CreateNoWindow) and shows a real tray icon
# (NotifyIcon) with: status / Open Log / Restart / language toggle (中文<->English) / Exit.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$BridgeDir  = $PSScriptRoot
$RepoDir    = Split-Path -Parent $BridgeDir
$MainJs     = Join-Path $BridgeDir 'main.js'
$LogFile    = Join-Path $BridgeDir 'bridge.log'
$LabelsFile = Join-Path $BridgeDir 'tray-labels.json'
$LangFile   = Join-Path $BridgeDir '.tray-lang'

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = 'C:\Program Files\nodejs\node.exe' }

# ASCII fallback used only if the labels JSON is missing/corrupt, so the tray always works.
$Fallback = [pscustomobject]@{
  tooltip = 'PocketAide Bridge (in tray)'; balloonTitle = 'PocketAide Bridge';
  statusStarting = 'Status: starting...'; statusRunning = 'Status: running (pid {0})';
  statusStopped = 'Status: stopped'; statusAutoRestarted = 'Status: auto-restarted';
  statusTooMany = 'Status: stopped (too many crashes)';
  openLog = 'Open Log'; restart = 'Restart Bridge'; restarted = 'Bridge restarted.';
  exit = 'Exit'; toggle = 'Switch language'
}

# Load both label sets via an explicit UTF-8 read (correct regardless of BOM / this file's encoding).
$ALL = $null
try {
  $json = [System.IO.File]::ReadAllText($LabelsFile, [System.Text.Encoding]::UTF8)
  $ALL = $json | ConvertFrom-Json
} catch { $ALL = $null }
if (-not $ALL) { $ALL = [pscustomobject]@{ zh = $Fallback; en = $Fallback } }

# Persisted language choice; default to Chinese.
$global:lang = 'zh'
try { $saved = ([System.IO.File]::ReadAllText($LangFile, [System.Text.Encoding]::ASCII)).Trim(); if ($saved -eq 'en' -or $saved -eq 'zh') { $global:lang = $saved } } catch {}
function Get-Labels { $l = $ALL.($global:lang); if (-not $l) { $l = $Fallback }; return $l }
$global:L = Get-Labels

$global:child    = $null
$global:stopping = $false
$global:restarts = @()

function Start-Bridge {
  if ($global:child -and -not $global:child.HasExited) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName         = $NodeExe
  $psi.Arguments        = '"' + $MainJs + '"'
  $psi.WorkingDirectory = $RepoDir
  $psi.UseShellExecute  = $false
  $psi.CreateNoWindow   = $true
  $psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $global:child = [System.Diagnostics.Process]::Start($psi)
}

# Kill the whole tree (node + its claude ConPTY child); plain .Kill() would orphan claude.
function Stop-Bridge {
  try {
    if ($global:child -and -not $global:child.HasExited) {
      Start-Process -FilePath 'taskkill.exe' -ArgumentList '/PID', $global:child.Id, '/T', '/F' `
        -NoNewWindow -Wait -ErrorAction SilentlyContinue
    }
  } catch {}
}

# Read-only status refresh (no restart logic); used on language toggle.
function Update-Status {
  if ($global:child -and -not $global:child.HasExited) {
    $global:miStatus.Text = ($global:L.statusRunning -f $global:child.Id)
  } else {
    $global:miStatus.Text = $global:L.statusStopped
  }
}

# Re-apply current language to all static items + tooltip.
function Apply-Lang {
  $global:L = Get-Labels
  $global:miLog.Text     = $global:L.openLog
  $global:miRestart.Text = $global:L.restart
  $global:miToggle.Text  = $global:L.toggle
  $global:miExit.Text    = $global:L.exit
  try { $notify.Text     = $global:L.tooltip } catch {}
  Update-Status
}

function Toggle-Lang {
  if ($global:lang -eq 'zh') { $global:lang = 'en' } else { $global:lang = 'zh' }
  try { [System.IO.File]::WriteAllText($LangFile, $global:lang, [System.Text.Encoding]::ASCII) } catch {}
  Apply-Lang
  try {
    $notify.BalloonTipTitle = $global:L.balloonTitle
    $notify.BalloonTipText  = $global:L.tooltip
    $notify.ShowBalloonTip(1500)
  } catch {}
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon    = [System.Drawing.SystemIcons]::Application
$notify.Text    = $global:L.tooltip
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$global:miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miStatus.Text = $global:L.statusStarting
$global:miStatus.Enabled = $false
[void]$menu.Items.Add($global:miStatus)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$global:miLog = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miLog.Text = $global:L.openLog
$global:miLog.add_Click({ try { Start-Process notepad.exe -ArgumentList $LogFile } catch {} })
[void]$menu.Items.Add($global:miLog)

$global:miRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miRestart.Text = $global:L.restart
$global:miRestart.add_Click({
  $global:stopping = $true
  Stop-Bridge
  Start-Sleep -Milliseconds 1000
  $global:restarts = @()
  $global:stopping = $false
  Start-Bridge
  try {
    $notify.BalloonTipTitle = $global:L.balloonTitle
    $notify.BalloonTipText  = $global:L.restarted
    $notify.ShowBalloonTip(2000)
  } catch {}
})
[void]$menu.Items.Add($global:miRestart)

$global:miToggle = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miToggle.Text = $global:L.toggle
$global:miToggle.add_Click({ Toggle-Lang })
[void]$menu.Items.Add($global:miToggle)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$global:miExit = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miExit.Text = $global:L.exit
$global:miExit.add_Click({
  $global:stopping = $true
  Stop-Bridge
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($global:miExit)

$notify.ContextMenuStrip = $menu

# Status refresh + bounded self-heal: if node dies on its own (not via our menu), relaunch it,
# but cap at 5 restarts / 5 min so a hard-failing start cannot loop forever.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($global:child -and -not $global:child.HasExited) {
    $global:miStatus.Text = ($global:L.statusRunning -f $global:child.Id)
  } elseif (-not $global:stopping) {
    $now = Get-Date
    $global:restarts = @($global:restarts | Where-Object { ($now - $_).TotalSeconds -lt 300 })
    if ($global:restarts.Count -lt 5) {
      $global:restarts += $now
      Start-Bridge
      $global:miStatus.Text = $global:L.statusAutoRestarted
    } else {
      $global:miStatus.Text = $global:L.statusTooMany
    }
  } else {
    $global:miStatus.Text = $global:L.statusStopped
  }
})
$timer.Start()

Start-Bridge
[System.Windows.Forms.Application]::Run()

# Reached only after Exit(): clean up.
try { $timer.Stop() } catch {}
$global:stopping = $true
Stop-Bridge
try { $notify.Dispose() } catch {}

# PocketAide Bridge - system tray host.
# ASCII ONLY (no non-ASCII literals): Windows PowerShell 5.1 reads a no-BOM .ps1 as GBK, so any
# Chinese written here would corrupt. ALL user-facing text lives in bridge\tray-labels.json (UTF-8)
# and is read at runtime with an explicit UTF-8 decoder, which is immune to this file's own encoding.
# Runtime paths (which contain Chinese) come from $PSScriptRoot at run time, not source literals.
#
# It launches `node bridge\main.js` with NO window (CreateNoWindow) and shows a real tray icon
# (NotifyIcon) with: status / provider switch / settings page / Open Log / Restart /
# language toggle (Chinese<->English) / Exit.
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
$global:panelChild    = $null
$global:panelRestarts = @()

# ---- Provider switcher (tools/switch) integration -------------------------------------------
# The switcher owns which provider/model this system runs on. The tray only drives it; all the
# real work (probe -> write config -> restart session) happens in switch.js so the tray and the
# CLI can never drift apart in behaviour.
$SwitchJs   = Join-Path $RepoDir 'tools\switch\switch.js'
$WebUiJs    = Join-Path $RepoDir 'tools\switch\webui.js'
$PanelJs    = Join-Path $RepoDir 'tools\panel\server.js'
$PanelTokenFile = Join-Path $RepoDir 'tools\panel\.token'
$SwitchOut  = Join-Path $env:TEMP 'aicanmou-switch-result.json'
$global:switchBusy = $false
$global:pendingName = ''

# Run switch.js and parse its JSON. StandardOutputEncoding must be pinned to UTF-8: PS 5.1 would
# otherwise decode node's UTF-8 output as the OEM codepage and mangle every non-ASCII label.
function Invoke-SwitchJson([string]$ArgLine) {
  if (-not (Test-Path -LiteralPath $SwitchJs)) { return $null }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $NodeExe
    $psi.Arguments              = '"' + $SwitchJs + '" ' + $ArgLine
    $psi.WorkingDirectory       = $RepoDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit(8000) | Out-Null
    if (-not $out) { return $null }
    return $out | ConvertFrom-Json
  } catch { return $null }
}

# Kick off a switch WITHOUT blocking the UI thread. A probe can take seconds; doing it inline
# would freeze the tray menu. Result lands in $SwitchOut and the 3s timer picks it up.
function Start-SwitchUse([string]$Name) {
  if ($global:switchBusy) { return }
  $global:switchBusy  = $true
  $global:pendingName = $Name
  Remove-Item -LiteralPath $SwitchOut -Force -ErrorAction SilentlyContinue
  Show-Balloon ($global:L.switching -f $Name)
  try {
    Start-Process -FilePath $NodeExe `
      -ArgumentList @('"' + $SwitchJs + '"', 'use', $Name, '--json') `
      -WorkingDirectory $RepoDir -WindowStyle Hidden `
      -RedirectStandardOutput $SwitchOut -RedirectStandardError ($SwitchOut + '.err') | Out-Null
  } catch {
    $global:switchBusy = $false
    Show-Balloon ($global:L.switchFail -f $Name, $_.Exception.Message)
  }
}

# Read the async switch result once node has written it, then report honestly: a switch is only
# real if the session actually restarted, so surface any terminal sessions left on the old config.
function Poll-SwitchResult {
  if (-not $global:switchBusy) { return }
  if (-not (Test-Path -LiteralPath $SwitchOut)) { return }
  Start-Sleep -Milliseconds 120          # let the writer finish flushing
  $txt = ''
  try { $txt = [System.IO.File]::ReadAllText($SwitchOut, [System.Text.Encoding]::UTF8) } catch { return }
  if (-not $txt.Trim()) { return }
  $global:switchBusy = $false
  $r = $null
  try { $r = $txt | ConvertFrom-Json } catch {
    $err = ''
    try { $err = [System.IO.File]::ReadAllText($SwitchOut + '.err', [System.Text.Encoding]::UTF8) } catch {}
    if (-not $err) { $err = $txt }
    Show-Balloon ($global:L.switchFail -f $global:pendingName, $err.Trim())
    Remove-Item -LiteralPath $SwitchOut, ($SwitchOut + '.err') -Force -ErrorAction SilentlyContinue
    return
  }
  Remove-Item -LiteralPath $SwitchOut, ($SwitchOut + '.err') -Force -ErrorAction SilentlyContinue
  $pending = 0
  try { if ($r.restart -and $r.restart.terminal -and $r.restart.terminal.pending) { $pending = @($r.restart.terminal.pending).Count } } catch {}
  if ($pending -gt 0) { Show-Balloon ($global:L.switchPendingTerm -f $r.switched, $pending) }
  else { Show-Balloon ($global:L.switchOk -f $r.switched, $r.label) }
  Update-Provider
}

function Show-Balloon([string]$Text) {
  try {
    $notify.BalloonTipTitle = $global:L.balloonTitle
    $notify.BalloonTipText  = $Text
    $notify.ShowBalloonTip(3000)
  } catch {}
}

# Refresh the "Current: <provider> / <model>" line. Cheap enough to call on menu open.
function Update-Provider {
  if (-not $global:miProvider) { return }
  $s = Invoke-SwitchJson 'status --json'
  if (-not $s) { $global:miProvider.Text = $global:L.providerErr; return }
  try {
    $g = $s.scopes | Where-Object { $_.scope -eq 'global' } | Select-Object -First 1
    $name = if ($s.current) { $s.current } else { '?' }
    $model = if ($g -and $g.configuredModel) { $g.configuredModel } else { '?' }
    $global:miProvider.Text = ($global:L.provider -f $name, $model)
  } catch { $global:miProvider.Text = $global:L.providerErr }
}

# Rebuild the "Switch provider" submenu from the switcher's own list, ticking the active one.
# Rebuilt on every menu open so edits made in the web UI show up immediately.
function Update-SwitchMenu {
  if (-not $global:miSwitch) { return }
  $global:miSwitch.DropDownItems.Clear()
  $list = Invoke-SwitchJson 'list --json'
  if (-not $list -or -not $list.providers -or @($list.providers).Count -eq 0) {
    $empty = New-Object System.Windows.Forms.ToolStripMenuItem
    $empty.Text = $global:L.switchNone
    $empty.Enabled = $false
    [void]$global:miSwitch.DropDownItems.Add($empty)
    return
  }
  foreach ($p in $list.providers) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $label = $p.label
    if (-not $label) { $label = $p.name }
    $item.Text    = $label + '  (' + $p.model + ')'
    $item.Checked = [bool]$p.current
    $item.Enabled = -not [bool]$p.current
    $item.Tag     = $p.name
    $item.add_Click({ Start-SwitchUse $this.Tag }.GetNewClosure())
    [void]$global:miSwitch.DropDownItems.Add($item)
  }
}

# Launch the local web UI (random port + one-time token, printed as JSON on its first stdout line)
# and open the browser at that URL. The server exits on its own once the page stops heart-beating.
function Open-SwitchUi {
  Show-Balloon $global:L.uiOpening
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $NodeExe
    # --no-open: the tray opens the browser itself so it can report failures via balloon.
    $psi.Arguments              = '"' + $WebUiJs + '" --no-open'
    $psi.WorkingDirectory       = $RepoDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $line = $p.StandardOutput.ReadLine()            # webui.js prints {url,port,token} then serves
    if (-not $line) { throw 'no output from webui.js' }
    $info = $line | ConvertFrom-Json
    Start-Process $info.url | Out-Null
  } catch { Show-Balloon ($global:L.uiFail -f $_.Exception.Message) }
}

# --- Task panel ---------------------------------------------------------------
# Unlike the switch UI this one is a fixed-port RESIDENT service, because it must support PWA
# install/offline: a random port would break the installed shortcut on every restart.
#
# It starts with the tray (not lazily on menu click) and dies with it. Lazy start looked
# cheaper but was wrong in practice: an installed PWA icon, a bookmark, or the phone opening
# 127.0.0.1:8787 all bypass the menu entirely, and would just hit a dead port. A resident
# service is the only thing that makes those entry points work.

function Get-PanelPort {
  if ($env:PANEL_PORT) { return [int]$env:PANEL_PORT }
  return 8787
}

function Test-PanelLive {
  param([int]$Port)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port); $c.Close(); return $true
  } catch { return $false }
}

# Idempotent: if something is already listening on the port we leave it alone (it may be a
# panel started by hand, and double-binding would just make the second one exit with EADDRINUSE).
function Start-Panel {
  $port = Get-PanelPort
  if (Test-PanelLive -Port $port) { return $true }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = $NodeExe
    $psi.Arguments        = '"' + $PanelJs + '" --no-open'
    $psi.WorkingDirectory = $RepoDir
    $psi.UseShellExecute  = $false
    $psi.CreateNoWindow   = $true
    $psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $global:panelChild = [System.Diagnostics.Process]::Start($psi)
  } catch { return $false }
  for ($i = 0; $i -lt 40; $i++) {          # up to ~4s for the listener to come up
    Start-Sleep -Milliseconds 100
    if (Test-PanelLive -Port $port) { return $true }
  }
  return $false
}

function Stop-Panel {
  try {
    if ($global:panelChild -and -not $global:panelChild.HasExited) {
      Start-Process -FilePath 'taskkill.exe' -ArgumentList '/PID', $global:panelChild.Id, '/T', '/F' `
        -NoNewWindow -Wait -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Open-TaskPanel {
  Show-Balloon $global:L.panelOpening
  try {
    $port = Get-PanelPort
    if (-not (Start-Panel)) { throw 'panel did not start listening on port ' + $port }
    # Token comes from the .token file, not stdout: the running instance may not be our child.
    # The server sets a cookie and 302s to a clean '/', so the token does not stay in history.
    $token = ''
    if (Test-Path $PanelTokenFile) { $token = (Get-Content -Raw -Path $PanelTokenFile).Trim() }
    $url = 'http://127.0.0.1:' + $port + '/'
    if ($token) { $url = $url + '?t=' + $token }
    Start-Process $url | Out-Null
  } catch { Show-Balloon ($global:L.panelFail -f $_.Exception.Message) }
}

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
  if ($global:miSwitch)   { $global:miSwitch.Text   = $global:L.switchTo }
  if ($global:miSettings) { $global:miSettings.Text = $global:L.settings }
  if ($global:miPanel) { $global:miPanel.Text = $global:L.taskPanel }
  try { $notify.Text     = $global:L.tooltip } catch {}
  Update-Status
  if ($global:miProvider) { Update-Provider }
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

# Provider block: current provider/model, a submenu to switch, and the settings page.
# Switching from here runs the full probe -> write -> restart path (see Start-SwitchUse); it is
# never a config-only change, otherwise the menu would claim a switch that never took effect.
$global:miProvider = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miProvider.Text = $global:L.providerUnknown
$global:miProvider.Enabled = $false
[void]$menu.Items.Add($global:miProvider)

$global:miSwitch = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miSwitch.Text = $global:L.switchTo
[void]$menu.Items.Add($global:miSwitch)

$global:miSettings = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miSettings.Text = $global:L.settings
$global:miSettings.add_Click({ Open-SwitchUi })
[void]$menu.Items.Add($global:miSettings)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$global:miPanel = New-Object System.Windows.Forms.ToolStripMenuItem
$global:miPanel.Text = $global:L.taskPanel
$global:miPanel.add_Click({ Open-TaskPanel })
[void]$menu.Items.Add($global:miPanel)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# Refresh provider info only when the menu is actually opened: keeps the 3s timer from spawning
# a node process every tick just to keep a label warm.
$menu.add_Opening({ Update-Provider; Update-SwitchMenu })

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
  Stop-Panel
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
  Poll-SwitchResult          # async switch finished? report it (never blocks the UI thread)
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

  # Same self-heal for the panel. It is resident, so "died and stayed dead" would silently turn
  # the PWA icon / bookmark into a white screen with nothing telling you why. Checked by port
  # rather than by process handle, so a panel someone started by hand also counts as alive.
  # Capped the same way (5 per 5 min) so a panel that cannot bind never loops forever.
  if (-not $global:stopping) {
    if (-not (Test-PanelLive -Port (Get-PanelPort))) {
      $pnow = Get-Date
      $global:panelRestarts = @($global:panelRestarts | Where-Object { ($pnow - $_).TotalSeconds -lt 300 })
      if ($global:panelRestarts.Count -lt 5) {
        $global:panelRestarts += $pnow
        [void](Start-Panel)
      }
    }
  }
})
$timer.Start()

Start-Bridge
# Panel is resident, not lazy: an installed PWA icon / bookmark / the phone hitting
# 127.0.0.1:8787 never goes through our menu, and a dead port makes all of those fail.
[void](Start-Panel)
[System.Windows.Forms.Application]::Run()

# Reached only after Exit(): clean up.
try { $timer.Stop() } catch {}
$global:stopping = $true
Stop-Bridge
Stop-Panel
try { $notify.Dispose() } catch {}

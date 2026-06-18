' Launch the PocketAide Bridge tray host with NO visible window.
' ASCII ONLY: WSH reads a no-BOM .vbs as GBK, so keep this file ASCII.
' wscript.exe is a GUI-subsystem host (no console), and Run(..., 0, ...) starts
' PowerShell hidden (SW_HIDE), so neither PowerShell nor node ever flashes a window.
Option Explicit
Dim sh, scriptDir, cmd
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
cmd = "powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "tray-host.ps1"""
sh.Run cmd, 0, False

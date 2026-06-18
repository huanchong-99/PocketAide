' launch-scrape-chrome.vbs
' Launch a "debug mode" Chrome for web scraping: remote-debugging port 9222 + a
' dedicated persistent profile. Launched via VBS so there is NO console/CMD window
' to close (a .bat would leave a black window). Does not kill your main Chrome; the
' dedicated profile keeps its own login state, isolated from daily browsing.
' Called by the web-scrape skill: probe 9222 first, run this only if it is down.
'
' NOTE: keep this file ASCII-only. wscript reads a no-BOM .vbs as the system codepage
' (GBK on zh-CN), and non-ASCII comment bytes corrupt parsing.

Option Explicit
Dim fso, shell, scriptDir, repoRoot, profile, chrome, paths, i, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' repo root = parent of this script's folder (scripts\)
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot  = fso.GetParentFolderName(scriptDir)
profile   = repoRoot & "\.scrape-chrome-profile"

' locate chrome.exe (default path first, then fallbacks)
paths = Array( _
  "C:\Program Files\Google\Chrome\Application\chrome.exe", _
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", _
  shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe" )
chrome = ""
For i = 0 To UBound(paths)
  If fso.FileExists(paths(i)) Then
    chrome = paths(i)
    Exit For
  End If
Next
If chrome = "" Then
  WScript.Echo "chrome.exe not found; edit the paths array in this script."
  WScript.Quit 1
End If

cmd = """" & chrome & """" & _
      " --remote-debugging-port=9222" & _
      " --user-data-dir=""" & profile & """" & _
      " --no-first-run --no-default-browser-check"

' arg2 = 1 (normal visible window, so you can log into sites); arg3 = False (don't wait)
shell.Run cmd, 1, False

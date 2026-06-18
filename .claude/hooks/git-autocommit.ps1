# PostToolUse(Edit|Write|MultiEdit) hook.
# Purpose: auto git add + commit after every file change (C2 data-safety backstop;
#   does not rely on the model remembering). Quiet, non-blocking, never pushes.
# NOTE: keep this file ASCII-only. PowerShell 5.1 decodes a no-BOM .ps1 as the system
#   codepage (GBK), and non-ASCII comment bytes can eat the trailing newline, silently
#   commenting out the following line.

$ErrorActionPreference = 'SilentlyContinue'

# Drain the hook payload on stdin; only read when redirected to avoid blocking on no-EOF.
if ([Console]::IsInputRedirected) { try { [Console]::In.ReadToEnd() | Out-Null } catch {} }

# Repo root = two levels up from this script (.claude\hooks).
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $repo

# Stage everything (respects .gitignore; .env / .index etc. stay out).
git add -A | Out-Null

# Use git's exit code to detect staged changes (0 = no diff, non-0 = has diff).
# More robust than parsing output under PS 5.1 native-stderr quirks.
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { exit 0 }

$tmp = Join-Path $env:TEMP ("PocketAide-commit-$PID.txt")
[System.IO.File]::WriteAllText($tmp, 'auto-commit: working tree change', (New-Object System.Text.UTF8Encoding($false)))

git commit -q -F $tmp | Out-Null

Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
exit 0

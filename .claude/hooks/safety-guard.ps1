# PreToolUse(Bash) hook for the AI-Canmou bridge.
# Purpose: in the "skip-permissions + ingesting external web content" setup, block a
#   small set of destructive / exfiltration commands. Blast radius is further limited
#   by pinning cwd to this repo. Non-blocking: safe commands always pass.
# Block mechanism: exit 2 + stderr message (Claude Code blocks the tool call and feeds
#   the reason back to the model).
# NOTE: keep this file ASCII-only. PowerShell 5.1 decodes a no-BOM .ps1 as the system
#   codepage (GBK), and non-ASCII comment bytes can eat the trailing newline, silently
#   commenting out the following line.

$ErrorActionPreference = 'SilentlyContinue'

$raw = ''
if ([Console]::IsInputRedirected) { try { $raw = [Console]::In.ReadToEnd() } catch {} }
if (-not $raw) { exit 0 }

try { $payload = $raw | ConvertFrom-Json } catch { exit 0 }

$cmd = ''
if ($payload.tool_input -and $payload.tool_input.command) {
    $cmd = [string]$payload.tool_input.command
}
if (-not $cmd) { exit 0 }

$lc = $cmd.ToLower()

# Dangerous / exfiltration regex patterns (matched against the lowercased command).
$denyPatterns = @(
    'rm\s+-rf?\s+[~/]',                                  # rm -rf /   rm -r ~
    'rm\s+-rf?\s+\*',                                    # rm -rf *
    'rm\s+-rf?\s+\.\s*$',                                # rm -rf .
    'remove-item.*-recurse.*-force',                    # PS recursive force delete
    'rmdir\s+/s',                                        # rmdir /s
    'del\s+/[a-z]*s',                                    # del /s
    'format\s+[a-z]:',                                   # format c:
    'diskpart',
    'git\s+push',                                        # push is done by the bridge, not the model
    '\.ssh[\\/]',                                        # read keys outside repo
    'id_rsa',
    '\.aws[\\/]credentials',
    '\.npmrc',
    'invoke-expression',                                # download-and-run
    'iwr[^|]*\|[^|]*iex',
    '(curl|wget)[^|]*\|[^|]*(sh|bash|pwsh|powershell)'
)

foreach ($p in $denyPatterns) {
    if ($lc -match $p) {
        [Console]::Error.WriteLine("safety-guard blocked: command matched dangerous/exfil pattern [$p]. If truly needed, run it manually in a real terminal. Command: $cmd")
        exit 2
    }
}

exit 0

<#
.SYNOPSIS
  Run the live end-to-end Zen test (test\integration\zen_live.py --live) with the stored,
  DPAPI-encrypted Anthropic key.

.DESCRIPTION
  Decrypts the key saved by anthropic-key.ps1 and exposes it as ZEN_TIDY_LIVE_KEY only to the python
  child process. zen_live.py removes it from its own environment at once (so Zen, node and PowerShell
  children never inherit it) and hands it to the extension through the self-test page's saveKey
  message, in a throwaway profile under spike\profiles\ that is always deleted. The variable is removed
  from this process afterwards, and the key is never printed.

  Afterwards, while the key is still at hand, every file in spike\results\live\ and the call ledger are
  scanned for the exact key; only the number of matching files is printed. As a backstop, the throwaway
  profile is deleted here too if it still exists (after stopping only the Zen processes started on it).

  This SPENDS MONEY, far more on Sonnet and Opus than on Haiku. Roughly, per run on
  test\fixtures\synthetic-tabs.json: Haiku 5.5 (the default) half a cent to a cent; Sonnet 5.5 $0.10 to
  $0.25; Opus 5.5 $0.25 to $0.60 (its thinking can't be turned off); up to about three times that if a run
  needs all 12 reserved calls. Per million input / output tokens: Haiku 5.5 $0.10 / $0.50, Sonnet 5.5
  $2 / $10, Opus 5.5 $4 / $20. zen_live.py keeps the books in
  %LOCALAPPDATA%\zen-tidy-dev\live-call-ledger.json: it reserves the worst case (6 calls: pass 1, the sweep
  and the extra sweep, plus a margin for a refusal split or a retry) before each tidy, a chrome-scope
  request counter cancels anything beyond the reservation, and the run refuses to start without 12 calls
  per repetition left (2 tidies). Only zen_live.py writes the ledger. It is never created implicitly:
  this script refuses to decrypt the key until it exists. Create it once, free and without the key:
    python test\integration\zen_live.py --init-ledger 25
  Top it up the same way (free, no key; refused next to --live, so not through this script):
    python test\integration\zen_live.py --add-budget 10
  Rehearse first, free: python test\integration\zen_live.py --mock [--headed]

  Results land in spike\results\live\ as live-* files (summary, local-only detail, log, screenshots); a mock
  rehearsal writes mock-* files and cannot overwrite them.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\zen-live.ps1

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\zen-live.ps1 --headed --repeat 2 --max-calls 24

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\zen-live.ps1 --model claude-sonnet-5-5 --tabs-file test\fixtures\synthetic-tabs.json

  Sonnet 5.5 (or claude-opus-5-5) instead of the default Haiku, on the made-up tabs: zen_live.py refuses a live
  Sonnet or Opus run on a tab file whose "source" is not "synthetic". Run it from the repo root.
#>
# No param() block on purpose: PowerShell would try to bind --flags itself. $args passes them through.

$ErrorActionPreference = 'Stop'
$devData = Join-Path $env:LOCALAPPDATA 'zen-tidy-dev'
$keyFile = Join-Path $devData 'anthropic-bench-key.xml'
$ledger = Join-Path $devData 'live-call-ledger.json'
if (-not (Test-Path $keyFile)) {
    throw "No Anthropic key stored. Run scripts\anthropic-key.ps1 first."
}
$repo = Split-Path -Parent $PSScriptRoot
$test = Join-Path $repo 'test\integration\zen_live.py'
if (-not (Test-Path $test)) {
    throw "Missing $test"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "python is not on PATH."
}
$liveArgs = @($args | ForEach-Object { [string]$_ })
# Also catches --flag=value. zen_live.py turns argparse abbreviations off, so --kee cannot stand in for --keep.
if (@($liveArgs | Where-Object { $_ -match '^--(live|mock|keep|init-ledger|self-check)(=|$)' }).Count -gt 0) {
    throw "Don't pass --live, --mock, --keep, --init-ledger or --self-check; zen-live.ps1 always runs --live, the profile is always deleted, and the ledger is created by running zen_live.py directly."
}
# The spending cap. Checked before the key is decrypted; zen_live.py refuses a missing ledger as well.
if (-not (Test-Path -LiteralPath $ledger)) {
    throw "No call ledger at $ledger. Create it first (free, no key): python test\integration\zen_live.py --init-ledger 25"
}
$profileDir = Join-Path $repo 'spike\profiles\zen-live-live'
$resultsDir = Join-Path $repo 'spike\results\live'

$cred = Import-Clixml -Path $keyFile
$exitCode = 1
try {
    $env:ZEN_TIDY_LIVE_KEY = $cred.GetNetworkCredential().Password
    & python $test --live @liveArgs
    $exitCode = $LASTEXITCODE
    Remove-Item Env:ZEN_TIDY_LIVE_KEY -ErrorAction SilentlyContinue

    # Exact-key scan of everything the run wrote, the ledger included. Only a count is printed.
    $needle = $cred.GetNetworkCredential().Password
    $hits = 0
    $written = @()
    if (Test-Path $resultsDir) { $written += @(Get-ChildItem -LiteralPath $resultsDir -File -Recurse) }
    if (Test-Path -LiteralPath $ledger) { $written += @(Get-Item -LiteralPath $ledger) }
    foreach ($file in $written) {
        if ([System.IO.File]::ReadAllText($file.FullName).Contains($needle)) { $hits++ }
    }
    $needle = $null
    "zen-live.ps1: exact-key scan of spike\results\live and the call ledger: $hits file(s) contain the key"
    if ($hits -gt 0) { $exitCode = 3 }
} finally {
    Remove-Item Env:ZEN_TIDY_LIVE_KEY -ErrorAction SilentlyContinue
    Remove-Variable cred, needle -ErrorAction SilentlyContinue
    if (Test-Path $profileDir) {
        # The profile holds the key. Stop only zen.exe processes started on it, then delete it.
        Get-CimInstance Win32_Process -Filter "Name='zen.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
        Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $profileDir) { "zen-live.ps1: COULD NOT DELETE $profileDir - delete it by hand (it holds the key)" }
        else { "zen-live.ps1: removed the leftover throwaway profile" }
    }
}
exit $exitCode

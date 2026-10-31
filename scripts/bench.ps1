<#
.SYNOPSIS
  Run the Zen Tidy benchmark against the Anthropic API with the stored, DPAPI-encrypted key.

.DESCRIPTION
  Decrypts the key saved by anthropic-key.ps1 and exposes it as ZEN_TIDY_BENCH_KEY only to the
  node child process running "scripts\bench.mjs --send". It is removed from this process's
  environment afterwards and never printed. All arguments are passed through to bench.mjs.

  This SPENDS MONEY. bench.mjs counts tokens first (free), prints a cost estimate and asks before
  sending; every attempt is held under a hard cap (--cap-usd, default $0.50). Run a dry run first:
    node scripts\bench.mjs

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\bench.ps1 --configs low-adaptive --repeats 1 --limit 40

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\bench.ps1 --fixture .\test\fixtures\synthetic-tabs.json --cap-usd 0.25
#>
# No param() block on purpose: with one, PowerShell would try to bind --flags itself. $args passes
# them through; only "a,b" lists need re-joining, since PowerShell turns them into arrays.

$ErrorActionPreference = 'Stop'
$keyFile = Join-Path $env:LOCALAPPDATA 'zen-tidy-dev\anthropic-bench-key.xml'
if (-not (Test-Path $keyFile)) {
    throw "No Anthropic benchmark key stored. Run scripts\anthropic-key.ps1 first."
}
$bench = Join-Path $PSScriptRoot 'bench.mjs'
if (-not (Test-Path $bench)) {
    throw "Missing $bench"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node is not on PATH."
}
$benchArgs = @($args | ForEach-Object { if ($_ -is [array]) { $_ -join ',' } else { [string]$_ } })
if ($benchArgs -contains '--send') {
    throw "Don't pass --send; bench.ps1 adds it."
}

$cred = Import-Clixml -Path $keyFile
try {
    $env:ZEN_TIDY_BENCH_KEY = $cred.GetNetworkCredential().Password
    & node $bench --send @benchArgs
    if ($LASTEXITCODE -ne 0) { throw "bench.mjs failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item Env:ZEN_TIDY_BENCH_KEY -ErrorAction SilentlyContinue
    Remove-Variable cred -ErrorAction SilentlyContinue
}

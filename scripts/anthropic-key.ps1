<#
.SYNOPSIS
  Store, check or remove the Anthropic API key used by the Zen Tidy benchmark (scripts\bench.mjs).

.DESCRIPTION
  Prompts for the key (input hidden) and saves it encrypted with Windows DPAPI, so only your Windows
  account on this PC can decrypt it. The file lives outside the repository:
    %LOCALAPPDATA%\zen-tidy-dev\anthropic-bench-key.xml
  The key is never echoed or printed. scripts\bench.ps1 decrypts it only for the benchmark process.

  Use a dedicated key for the benchmark, scoped to your "zen-tidy" workspace (which has a spend limit).
  It is separate from the key you will later paste into the extension's settings page.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\anthropic-key.ps1
  Prompts for the key and saves it.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\anthropic-key.ps1 -Check
  Says whether a key is stored, without showing it.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\anthropic-key.ps1 -Remove
  Deletes the stored key (do this after revoking the key in the Claude Console).
#>
param(
    [switch]$Check,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'zen-tidy-dev'
$file = Join-Path $dir 'anthropic-bench-key.xml'

if ($Remove) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        'Removed the stored Anthropic benchmark key.'
    } else {
        'No Anthropic benchmark key stored.'
    }
    return
}

if ($Check) {
    if (Test-Path $file) {
        $cred = Import-Clixml -Path $file
        $plain = $cred.GetNetworkCredential().Password
        $prefix = if ($plain.StartsWith('sk-ant-')) { 'sk-ant-...' } else { 'unexpected prefix' }
        "Anthropic benchmark key stored ($prefix, length $($plain.Length))."
        Remove-Variable plain
    } else {
        'No Anthropic benchmark key stored.'
    }
    return
}

$secret = Read-Host 'Anthropic API key (input hidden)' -AsSecureString
if ($secret.Length -eq 0) {
    throw 'No key entered.'
}
$probe = (New-Object System.Management.Automation.PSCredential('x', $secret)).GetNetworkCredential().Password
if (-not $probe.StartsWith('sk-ant-')) {
    Write-Warning "The key doesn't start with 'sk-ant-'. Saving anyway; run -Remove and retry if it's wrong."
}
Remove-Variable probe

New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Object System.Management.Automation.PSCredential('anthropic-bench', $secret) | Export-Clixml -Path $file
"Saved, encrypted for your Windows account, to $file"

<#
.SYNOPSIS
  Store, check or remove the Mozilla Add-ons (AMO) API credentials used to sign Zen Tidy.

.DESCRIPTION
  Prompts for the JWT issuer and JWT secret from https://addons.mozilla.org/developers/addon/api/key/
  and saves them encrypted with Windows DPAPI, so only your Windows account on this PC can decrypt
  them. The file lives outside the repository:
    %LOCALAPPDATA%\zen-tidy-dev\amo-credentials.xml
  The secret is never echoed or printed. The signing step loads it only for the duration of
  `web-ext sign`.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1
  Prompts for both values and saves them.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1 -Check
  Says whether credentials are stored, without showing them.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1 -Remove
  Deletes the stored credentials (do this after revoking the key on AMO).
#>
param(
    [switch]$Check,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'zen-tidy-dev'
$file = Join-Path $dir 'amo-credentials.xml'

if ($Remove) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        'Removed stored AMO credentials.'
    } else {
        'No AMO credentials stored.'
    }
    return
}

if ($Check) {
    if (Test-Path $file) {
        $cred = Import-Clixml -Path $file
        $issuer = $cred.UserName
        $tail = $issuer.Substring([Math]::Max(0, $issuer.Length - 4))
        "AMO credentials stored (issuer ending ...$tail, secret length $($cred.Password.Length))."
    } else {
        'No AMO credentials stored.'
    }
    return
}

$issuer = (Read-Host 'AMO JWT issuer (looks like user:12345:678)').Trim()
$secret = Read-Host 'AMO JWT secret (input hidden)' -AsSecureString
if (-not $issuer -or $secret.Length -eq 0) {
    throw 'Both the JWT issuer and the JWT secret are required.'
}
if ($issuer -notmatch '^user:\d+:\d+$') {
    Write-Warning "The issuer doesn't look like 'user:<digits>:<digits>'. Saving anyway; run -Remove and retry if it's wrong."
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Object System.Management.Automation.PSCredential($issuer, $secret) | Export-Clixml -Path $file
"Saved, encrypted for your Windows account, to $file"

<#
.SYNOPSIS
  Store, check, test or remove the Mozilla Add-ons (AMO) API credentials used to sign Zen Tidy.

.DESCRIPTION
  Prompts for the JWT issuer and JWT secret from https://addons.mozilla.org/developers/addon/api/key/,
  then for a passphrase (twice; at least 12 characters, and not the secret itself), and saves the key
  locked with both the passphrase and Windows DPAPI: only your Windows account on this PC, given the
  passphrase, can unlock it. The file lives outside the repository:
    %LOCALAPPDATA%\zen-tidy-dev\amo-credentials.xml
  The secret and the passphrase are never echoed or printed. Run it in a terminal: it reads its
  answers from the console.

  The key stays stored between releases. The signing step (sign.ps1) asks for the passphrase in a
  Windows dialog and unlocks the key only for the duration of `web-ext sign`. To change the
  passphrase, store the key again. If this PC or the passphrase may be compromised, revoke the key on
  addons.mozilla.org (Developer Hub > Manage API Keys), then run -Remove.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1
  Prompts for both values and the passphrase, and saves them.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1 -Check
  Says whether credentials are stored and locked, without unlocking them.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1 -Test
  Asks for the passphrase and says whether it unlocks the stored credentials.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\amo-credentials.ps1 -Remove
  Deletes the stored credentials (do this after revoking the key on AMO).
#>
param(
    [switch]$Check,
    [switch]$Test,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
# The passphrase lock, shared with sign.ps1, which says why it runs from the file's text.
. ([scriptblock]::Create((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'lib\amo-key.ps1') -Raw)))
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

# Reads only what isn't secret: the passphrase isn't asked and nothing is unsealed.
if ($Check) {
    $stored = Import-AmoKey -LiteralPath $file
    if ($null -eq $stored) {
        'No AMO credentials stored.'
        return
    }
    $problem = Get-AmoKeyProblem $stored
    if ($problem) {
        "The stored AMO key $problem`: store it again (run this script without -Check)."
    } else {
        "AMO credentials stored, locked with a passphrase ($($stored.Format), $($stored.Iterations) iterations, stored $($stored.Created))."
    }
    return
}

if ($Test) {
    $stored = Import-AmoKey -LiteralPath $file
    if ($null -eq $stored) {
        throw 'No AMO credentials stored.'
    }
    $problem = Get-AmoKeyProblem $stored
    if ($problem) {
        throw "The stored AMO key $problem`: store it again."
    }
    $passphrase = Read-Host 'Passphrase of the stored AMO key (input hidden)' -AsSecureString
    try {
        $cred = Unprotect-AmoKey -Stored $stored -Passphrase $passphrase
    } finally {
        $passphrase.Dispose()
    }
    $issuer = $cred.UserName
    $tail = $issuer.Substring([Math]::Max(0, $issuer.Length - 4))
    "The passphrase unlocks the stored AMO credentials (issuer ending ...$tail)."
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
# sign.ps1 asks for it at each release; a passphrase that is the secret itself would lock nothing.
$passphrase = Read-Host "Passphrase to lock them (at least $AmoKeyMinPassphrase characters, input hidden)" -AsSecureString
$again = Read-Host 'The same passphrase again' -AsSecureString
try {
    if ($passphrase.Length -lt $AmoKeyMinPassphrase) {
        throw "The passphrase needs at least $AmoKeyMinPassphrase characters. Nothing was saved."
    }
    if (-not (Test-AmoKeySame $passphrase $again)) {
        throw 'The two passphrases differ. Nothing was saved.'
    }
    if (Test-AmoKeySame $passphrase $secret) {
        throw "The passphrase can't be the JWT secret. Nothing was saved."
    }
    $stored = Protect-AmoKey -Issuer $issuer -Secret $secret -Passphrase $passphrase
} finally {
    $passphrase.Dispose()
    $again.Dispose()
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stored | Export-Clixml -LiteralPath $file
"Saved to $file, locked with your passphrase and encrypted for your Windows account. It stays there between releases."

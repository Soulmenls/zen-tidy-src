<#
.SYNOPSIS
  Sign an extension folder with Mozilla (AMO) using the stored, DPAPI-encrypted credentials.

.DESCRIPTION
  Decrypts the credentials saved by amo-credentials.ps1 and exposes them as WEB_EXT_API_KEY /
  WEB_EXT_API_SECRET only to the web-ext child process. They are removed from this process's
  environment afterwards and never printed. Uploads the extension to addons.mozilla.org, so run it
  only when you mean to submit.

  web-ext is the pinned one in tools\web-ext (installed from its committed lockfile by
  `npm run tools`), run with node: -WebExtBin, or that folder's bin next to this script's repo, and
  -NodeExe, or the first node on PATH (release.mjs passes both, and its own node). The script
  refuses, before it touches the credentials, when either file is missing or web-ext's package is
  not -WebExtVersion. It never installs anything.

  The web-ext child gets no WEB_EXT_* option, NODE_OPTIONS or NODE_PATH from this session, no update
  check (NO_UPDATE_NOTIFIER) and no config file (--no-config-discovery), however the script was
  started; the variables it changes are put back afterwards.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File .\scripts\sign.ps1 -SourceDir .\extension -ArtifactsDir .\dist
#>
param(
    [Parameter(Mandatory)] [string]$SourceDir,
    [Parameter(Mandatory)] [string]$ArtifactsDir,
    [ValidateSet('unlisted', 'listed')] [string]$Channel = 'unlisted',
    [string]$WebExtBin = '',
    [string]$WebExtVersion = '10.7.0',
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
if (-not $WebExtBin) {
    $WebExtBin = Join-Path $PSScriptRoot '..\tools\web-ext\node_modules\web-ext\bin\web-ext.js'
}
if (-not (Test-Path -LiteralPath $WebExtBin -PathType Leaf)) {
    throw "The pinned web-ext is not installed ($WebExtBin is missing). Run: npm run tools"
}
# bin\web-ext.js sits in the package's own folder, next to its package.json.
$webExtPackage = Join-Path (Split-Path -Parent (Split-Path -Parent $WebExtBin)) 'package.json'
$installed = $null
if (Test-Path -LiteralPath $webExtPackage -PathType Leaf) {
    $installed = (Get-Content -LiteralPath $webExtPackage -Raw | ConvertFrom-Json).version
}
if ($installed -ne $WebExtVersion) {
    throw "The web-ext at $WebExtBin is version '$installed', not $WebExtVersion. Run: npm run tools"
}
# The node that ran release.mjs's preflight and lint, rather than whichever node.exe a folder earlier on PATH holds.
if (-not $NodeExe) {
    $NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw "node not found at $NodeExe"
}

$credFile = Join-Path $env:LOCALAPPDATA 'zen-tidy-dev\amo-credentials.xml'
if (-not (Test-Path -LiteralPath $credFile)) {
    throw "No AMO credentials stored. Run scripts\amo-credentials.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'manifest.json'))) {
    throw "No manifest.json in $SourceDir"
}

$cred = Import-Clixml -LiteralPath $credFile
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
# Left in this session, a WEB_EXT_* option could send the signed request elsewhere or change what is signed,
# NODE_OPTIONS or NODE_PATH load other code into the process that holds the secret, and web-ext's update check starts a
# detached node that inherits it. Saved first, so a session that runs this script keeps its own values.
$saved = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'WEB_EXT_*' -or $_.Name -eq 'NODE_OPTIONS' -or $_.Name -eq 'NODE_PATH' } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Name; Value = $_.Value } })
$notifier = $env:NO_UPDATE_NOTIFIER
try {
    foreach ($variable in $saved) { Remove-Item -LiteralPath "Env:$($variable.Name)" }
    $env:NO_UPDATE_NOTIFIER = '1'
    $env:WEB_EXT_API_KEY = $cred.UserName
    $env:WEB_EXT_API_SECRET = $cred.GetNetworkCredential().Password
    & $NodeExe $WebExtBin sign `
        --channel $Channel `
        --source-dir $SourceDir `
        --artifacts-dir $ArtifactsDir `
        --no-config-discovery `
        --no-input
    if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item Env:WEB_EXT_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
    foreach ($variable in $saved) { Set-Item -LiteralPath "Env:$($variable.Name)" -Value $variable.Value }
    if ($null -eq $notifier) { Remove-Item Env:NO_UPDATE_NOTIFIER -ErrorAction SilentlyContinue } else { $env:NO_UPDATE_NOTIFIER = $notifier }
}

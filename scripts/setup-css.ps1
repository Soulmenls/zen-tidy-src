<#
.SYNOPSIS
  Install or remove Zen Tidy's folder look (zen-tidy.css) in one Zen profile. Run it with that profile closed.

.DESCRIPTION
  Install:
    1. -ProfilePath must look like a Zen (Firefox) profile: it holds prefs.js or times.json. The profile must be
       closed: while Zen runs on it, Zen holds the profile's parent.lock exclusively. Other profiles may stay open.
       The script then holds parent.lock the same way until it ends, so neither Zen nor a second run can start on the
       profile while it works; a parent.lock it had to create is gone again when it ends.
    2. chrome\userChrome.css and user.js are backed up before they change, as
       <name>.zen-tidy-backup-<yyyyMMdd-HHmmss> (Gregorian, whatever the culture; with -2, -3, ... when that name
       is taken: a backup is never overwritten). The backup and the change are one step, so -Confirm can't let a
       change through without its backup.
    3. css\zen-tidy.css (or -CssPath) is copied to chrome\zen-tidy.css. One already there is Zen Tidy's when it starts
       with the generator's header ('/* Zen Tidy:') or install.json says the install created it. Any other is yours:
       it is backed up the same way before it is replaced, and -Uninstall puts it back.
    4. '@import "zen-tidy.css"; /* zen-tidy */' becomes the first rule of chrome\userChrome.css. Only an
       '@charset "...";' at the very start stays in front of it (in exactly that form, the one CSS reads the
       encoding from), because CSS ignores an @import placed after any other rule. Everything else in the file is
       kept byte for byte: its encoding, a BOM, its line endings. An import already in the first rule's place is
       left alone, even mid-line after the @charset or a comment; elsewhere only a copy that starts a line counts
       as the install's (it is moved, and further copies are removed; text after it on its line stays a line of its
       own).
    5. 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true); // zen-tidy' becomes the last
       setting of that pref in user.js: Zen loads no userChrome.css without it. If your user.js sets it to false,
       you are warned and the zen-tidy line overrides it. Only a line that is exactly that line counts as the
       install's: one with more text after it is your own setting of the pref.
    chrome\zen-tidy.install.json records what the first install found: whether you had set that pref yourself and
    to what, which of chrome\, userChrome.css, user.js and zen-tidy.css the install created, and the backup of a
    zen-tidy.css of yours that it replaced. A second run changes nothing, and makes no backup, unless something needs
    changing (a new zen-tidy.css, a moved line).

  -Uninstall removes exactly what the install added: the @import (each copy that starts a line, with its line, and a
  mid-line copy in the first rule's place, the rest of that line kept), the user.js line (your own setting of the
  pref is put back as install.json recorded it, if it went missing), zen-tidy.css (yours is put back from its backup
  if the install replaced one; one that is not Zen Tidy's is kept) and install.json. A file or the chrome folder the
  install created is deleted once nothing else is left in it. Backups are kept. Zen may keep the pref switched on in
  prefs.js afterwards, which is harmless with the @import gone.

  -WhatIf lists what would change and writes nothing.

  -Confirm asks before each step. Declining one skips what depends on it: an install stops when chrome\ or
  install.json is declined (nothing after them could be undone), and after a declined step -Uninstall keeps
  install.json and chrome\, so a later -Uninstall can finish. The summary then says the run was only partly done.

  Text files are edited as one character per byte (Latin-1), so every byte the script does not add or remove is
  written back unchanged, whatever the file holds. Nothing is written until every check has passed and every
  change is planned, including a check that each existing file it will rewrite or delete can be written (is not
  read-only). Each file is written to <name>.zen-tidy-tmp beside it, which then takes the old file's place in one
  step (the same step makes the backup), so a write that fails at any point leaves the file as it was. A chrome\,
  userChrome.css, user.js, zen-tidy.css or install.json that is a junction, a symbolic link or a hard link is refused:
  it may be shared with other profiles. Compatible with Windows PowerShell 5.1: keep this file ASCII-only (5.1 reads
  a BOM-less script as ANSI).

  Exit codes:
    0  done, nothing to do, or partly done because -Confirm steps were declined
    1  unexpected error, or an argument PowerShell itself rejects before the script runs (through -File: a switch
       given a value, such as -Uninstall:$false, or a parameter with no value)
    2  bad arguments (no -ProfilePath, or one the script doesn't know), or no CSS to copy
    3  -ProfilePath is not a profile folder
    4  the profile is open in Zen, or this script is already working on it (parent.lock is held)
    5  a file the script would edit is in a form it can't edit safely (UTF-16, an invalid install.json), is
       read-only, or is a link (a junction, a symbolic link or a hard link)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-css.ps1 -ProfilePath "$env:APPDATA\zen\Profiles\abcd1234.Default (release)" -WhatIf

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-css.ps1 -ProfilePath "$env:APPDATA\zen\Profiles\abcd1234.Default (release)" -Uninstall
#>
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, PositionalBinding = $false)]
param(
    [string]$ProfilePath,
    [string]$CssPath,
    [switch]$Uninstall,
    # Whatever else is given (a misspelt parameter, a stray value) lands here and is refused with exit 2. Without it,
    # PowerShell's own binder would stop the script with exit 1, which this script keeps for unexpected errors.
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Usage = 'usage: setup-css.ps1 -ProfilePath <profile folder> [-Uninstall] [-WhatIf]'
$ImportLine = '@import "zen-tidy.css"; /* zen-tidy */'
$PrefName = 'toolkit.legacyUserProfileCustomizations.stylesheets'
$PrefLine = 'user_pref("' + $PrefName + '", true); // zen-tidy'
# How css\zen-tidy.css starts (scripts/gen-css.mjs writes it): a chrome\zen-tidy.css that starts so is Zen Tidy's.
$CssHeader = '/* Zen Tidy:'
# A backup of chrome\zen-tidy.css, as install.json may name it (a bare name in chrome\, nothing else).
$CssBackupRe = '^zen-tidy\.css\.zen-tidy-backup-\d{8}-\d{6}(-\d+)?$'
# Each write goes to <file> plus this first, then takes the file's place (Write-FileSafely).
$TmpSuffix = '.zen-tidy-tmp'
# One char per byte both ways: edits made on this text keep every other byte exactly as it was.
$Latin1 = [System.Text.Encoding]::GetEncoding(28591)
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$Bom = [string][char]0xEF + [char]0xBB + [char]0xBF
$Ordinal = [System.StringComparison]::Ordinal
# Invariant culture: Get-Date -Format would follow the culture's calendar (Buddhist in th-TH, Hijri in ar-SA).
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
# An @charset statement at the very start of the file (after a BOM), in the one form CSS reads the encoding from:
# '@charset "', the name, '";'. \G anchors it where the match starts.
$CharsetRe = New-Object System.Text.RegularExpressions.Regex '\G@charset "[^"\r\n]*";'
# Any user.js line that sets the pref. Group 2 is the value. A line starts at the start of the text or right after a
# CR or an LF: Firefox's pref parser ends a line at a lone CR as well, and (?m)^ would only see one after an LF.
$PrefRe = New-Object System.Text.RegularExpressions.Regex ('(?<![^\r\n])[ \t]*user_pref[ \t]*\([ \t]*(["''])' +
    [regex]::Escape($PrefName) + '\1[ \t]*,[ \t]*(true|false)[ \t]*\)')

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

function Stop-Setup([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("setup-css: $Message")
    exit $Code
}

function Test-Eol([char]$Char) { return $Char -eq [char]13 -or $Char -eq [char]10 }

function Get-BomLength([string]$Text) {
    if ($Text.StartsWith($Bom, $Ordinal)) { return 3 }
    return 0
}

# The file's first line break, or CRLF when it has none.
function Get-Eol([string]$Text) {
    $at = $Text.IndexOfAny([char[]]@([char]13, [char]10))
    if ($at -lt 0) { return "`r`n" }
    if ($Text[$at] -eq [char]10) { return "`n" }
    if ($at + 1 -lt $Text.Length -and $Text[$at + 1] -eq [char]10) { return "`r`n" }
    return "`r"
}

# Where each copy of Marker starts a line (at Start, or right after a line break). With -WholeLine, only a copy that
# is the whole line: a line break or the end of the text follows it.
function Find-Marker([string]$Text, [string]$Marker, [int]$Start, [switch]$WholeLine) {
    $at = $Text.IndexOf($Marker, $Start, $Ordinal)
    while ($at -ge 0) {
        $end = $at + $Marker.Length
        $lineStart = $at -eq $Start -or (Test-Eol $Text[$at - 1])
        $lineEnd = $end -ge $Text.Length -or (Test-Eol $Text[$end])
        if ($lineStart -and (-not $WholeLine -or $lineEnd)) { $at }
        $at = $Text.IndexOf($Marker, $at + 1, $Ordinal)
    }
}

# Removes every copy of Marker that Find-Marker finds, the exact inverse of Add-Import and Add-LastLine: with the line
# break after it; at the end of the text, with the line break before it. With more text after it on its line, the
# line break before it goes only when that break directly follows the leading @charset (Add-Import broke the @charset
# line there); otherwise only the marker goes, so the rest of its line is never joined onto the line above.
function Remove-Marker([string]$Text, [string]$Marker, [int]$Start, [switch]$WholeLine) {
    $hits = @(Find-Marker $Text $Marker $Start -WholeLine:$WholeLine)
    $charset = $CharsetRe.Match($Text, $Start)
    $charsetEnd = if ($charset.Success) { $charset.Index + $charset.Length } else { -1 }
    for ($k = $hits.Count - 1; $k -ge 0; $k--) {
        $from = $hits[$k]
        $to = $from + $Marker.Length
        if ($to -lt $Text.Length -and (Test-Eol $Text[$to])) {
            if ($Text[$to] -eq [char]13 -and $to + 1 -lt $Text.Length -and $Text[$to + 1] -eq [char]10) { $to += 2 } else { $to += 1 }
        } elseif ($from -gt $Start) {
            $break = if ($Text[$from - 1] -eq [char]10 -and $from - 2 -ge $Start -and $Text[$from - 2] -eq [char]13) { $from - 2 } else { $from - 1 }
            if ($to -ge $Text.Length -or $break -eq $charsetEnd) { $from = $break }
        }
        $Text = $Text.Remove($from, $to - $from)
    }
    return $Text
}

# Skips whitespace and /* comments */, which CSS does not count as rules.
function Skip-CssTrivia([string]$Text, [int]$At) {
    while ($At -lt $Text.Length) {
        $c = $Text[$At]
        if ($c -eq [char]32 -or $c -eq [char]9 -or $c -eq [char]12 -or (Test-Eol $c)) { $At++; continue }
        if ($c -eq [char]'/' -and $At + 1 -lt $Text.Length -and $Text[$At + 1] -eq [char]'*') {
            $close = $Text.IndexOf('*/', $At + 2, $Ordinal)
            if ($close -lt 0) { return $Text.Length }
            $At = $close + 2
            continue
        }
        break
    }
    return $At
}

# Inserts the @import as the first rule: at the top, or right after a leading @charset statement.
function Add-Import([string]$Text, [int]$Start) {
    $charset = $CharsetRe.Match($Text, $Start)
    if (-not $charset.Success) { return $Text.Insert($Start, $ImportLine + (Get-Eol $Text)) }
    $after = $charset.Index + $charset.Length
    $j = $after
    while ($j -lt $Text.Length -and ($Text[$j] -eq [char]32 -or $Text[$j] -eq [char]9)) { $j++ }
    if ($j -lt $Text.Length -and (Test-Eol $Text[$j])) {
        # The @charset line ends here, with the file's first line break: the import becomes the next line, ended
        # the same way.
        $eol = Get-Eol $Text
        return $Text.Insert($j + $eol.Length, $ImportLine + $eol)
    }
    # Something else follows on the @charset line (or nothing at all): break the line before the import.
    return $Text.Insert($after, (Get-Eol $Text) + $ImportLine)
}

# Where the first rule starts: past a leading @charset statement, whitespace and comments.
function Get-FirstRule([string]$Text, [int]$Start) {
    $at = $Start
    $charset = $CharsetRe.Match($Text, $Start)
    if ($charset.Success) { $at = $charset.Index + $charset.Length }
    return Skip-CssTrivia $Text $at
}

function Test-ImportAt([string]$Text, [int]$At) {
    return $Text.IndexOf($ImportLine, $At, $Ordinal) -eq $At
}

# userChrome.css text with the import as its first rule. Change: '' (already first), 'added' or 'moved'.
# The import in the first rule's place is ours even when it doesn't start a line (put there by hand, after the
# @charset or a comment on the same line): CSS uses it all the same, so nothing changes. Anywhere else, only a copy
# that starts a line is ours.
function Set-ImportFirst([string]$Text) {
    $start = Get-BomLength $Text
    if (Test-ImportAt $Text (Get-FirstRule $Text $start)) { return [pscustomobject]@{ Text = $Text; Change = '' } }
    $ours = @(Find-Marker $Text $ImportLine $start)
    $change = if ($ours.Count -gt 0) { 'moved' } else { 'added' }
    $clean = Remove-Marker $Text $ImportLine $start
    return [pscustomobject]@{ Text = (Add-Import $clean $start); Change = $change }
}

# userChrome.css text without the import: every copy that starts a line (Remove-Marker), and the copy in the first
# rule's place that doesn't start one (see Set-ImportFirst). Of that copy only the import itself goes; the rest of its
# line stays as it is.
function Remove-Import([string]$Text) {
    $start = Get-BomLength $Text
    $first = Get-FirstRule $Text $start
    if ($first -gt $start -and -not (Test-Eol $Text[$first - 1]) -and (Test-ImportAt $Text $first)) {
        $Text = $Text.Remove($first, $ImportLine.Length)
    }
    return Remove-Marker $Text $ImportLine $start
}

# Appends Line as the last line, keeping the file's line breaks.
function Add-LastLine([string]$Text, [string]$Line) {
    $eol = Get-Eol $Text
    if ($Text.Length -eq (Get-BomLength $Text)) { return $Text + $Line + $eol }
    if (Test-Eol $Text[$Text.Length - 1]) { return $Text + $Line + $eol }
    return $Text + $eol + $Line
}

# The zen-tidy lines in user.js (only whole lines: Add-LastLine never puts anything after ours, so a line that goes on
# is the user's), and the user's own last setting of the pref (Index, Value), if any.
function Get-PrefState([string]$Text) {
    $start = Get-BomLength $Text
    $ours = @(Find-Marker $Text $PrefLine $start -WholeLine)
    $last = $null
    foreach ($m in $PrefRe.Matches($Text.Substring($start))) {
        $at = $m.Index + $start
        if ($ours -contains $at) { continue }
        $last = [pscustomobject]@{ Index = $at; Value = [string]::Equals($m.Groups[2].Value, 'true', $Ordinal) }
    }
    return [pscustomobject]@{ Ours = $ours; Last = $last }
}

# user.js text with the zen-tidy line as the pref's last setting. Change: '', 'added' or 'moved'.
function Set-PrefLast([string]$Text) {
    $state = Get-PrefState $Text
    $ours = $state.Ours
    if ($ours.Count -gt 0 -and ($null -eq $state.Last -or $ours[$ours.Count - 1] -gt $state.Last.Index)) {
        return [pscustomobject]@{ Text = $Text; Change = ''; UserValue = $state.Last }
    }
    $change = if ($ours.Count -gt 0) { 'moved' } else { 'added' }
    $clean = Remove-Marker $Text $PrefLine (Get-BomLength $Text) -WholeLine
    return [pscustomobject]@{ Text = (Add-LastLine $clean $PrefLine); Change = $change; UserValue = $state.Last }
}

# A profile file as one-char-per-byte text, or $null when it doesn't exist.
function Read-ProfileText([string]$Path, [string]$Name) {
    if (Test-Path -LiteralPath $Path -PathType Container) { throw "$Name is a folder, not a file." }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $utf16 = $bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))
    $utf32 = $bytes.Length -ge 4 -and $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0xFE -and $bytes[3] -eq 0xFF
    if ($utf16 -or $utf32) { Stop-Setup 5 "$Name is saved as UTF-16 or UTF-32. Save it as UTF-8 and run again." }
    return $Latin1.GetString($bytes)
}

# A field of a record object that older records lack: $null when it isn't there (Set-StrictMode stops on a missing
# property otherwise).
function Get-Optional($Object, [string]$Name) {
    $field = $Object.PSObject.Properties[$Name]
    if ($null -eq $field) { return $null }
    return $field.Value
}

function Read-Record([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $record = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
        $ok = $record.version -eq 1 -and $record.created.chromeDir -is [bool] -and $record.created.userChrome -is [bool] -and
            $record.created.userJs -is [bool] -and $record.pref.setByUser -is [bool] -and
            (-not $record.pref.setByUser -or $record.pref.value -is [bool])
        if ($ok) {
            # Added after the first records: whether the install created zen-tidy.css, and the backup of the user's own.
            $css = Get-Optional $record.created 'css'
            $backup = Get-Optional $record 'cssBackup'
            $ok = ($null -eq $css -or $css -is [bool]) -and ($null -eq $backup -or ($backup -is [string] -and $backup -cmatch $CssBackupRe))
        }
    } catch {
        $ok = $false
    }
    if (-not $ok) {
        Stop-Setup 5 'chrome\zen-tidy.install.json is not a valid install record. Restore it from a backup, or delete it (-Uninstall then keeps files it cannot prove the install created).'
    }
    return $record
}

# Whether chrome\zen-tidy.css (at Path) is Zen Tidy's: install.json says the install created it, or it starts with
# the generator's header. Any other file of that name is the user's own. The file is read only when the record
# doesn't settle it (a scanner may be holding it for a moment).
function Test-OurCss([string]$Path, $Record) {
    if ($null -ne $Record -and (Get-Optional $Record.created 'css') -eq $true) { return $true }
    return $Latin1.GetString([System.IO.File]::ReadAllBytes($Path)).StartsWith($CssHeader, $Ordinal)
}

# Holds the profile's parent.lock as Zen does, with no sharing, until the script ends; stops (exit 4) when Zen, or
# another run of this script, holds it. A parent.lock that isn't there is created delete-on-close, so it is gone again
# when the handle closes, however the script ends. (Zen leaves its own in the profile when it quits; that one is only
# opened.)
function Lock-Profile([string]$Dir) {
    $lock = Join-Path $Dir 'parent.lock'
    if (-not [System.IO.File]::Exists($lock)) {
        try {
            return [System.IO.FileStream]::new($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
        } catch [System.IO.IOException] { }   # created in the meantime: open it as below
    }
    try {
        return [System.IO.File]::Open($lock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    } catch {
        Stop-Setup 4 'this profile is open in Zen, or setup-css is already running on it (its parent.lock is held). Close Zen and run again.'
    }
}

function Get-BackupPath([string]$Path) {
    $base = "$Path.zen-tidy-backup-$Stamp"
    $candidate = $base
    $n = 1
    while (Test-Path -LiteralPath $candidate) {
        $n++
        $candidate = "$base-$n"
    }
    return $candidate
}

# Runs a file operation, retrying for up to 3 s while another process (a virus scanner, the search indexer) briefly
# holds the file: Windows reports that as an IOException (sharing violation).
function Invoke-FileOp([scriptblock]$Operation) {
    for ($attempt = 1; ; $attempt++) {
        try {
            & $Operation
            return
        } catch [System.IO.IOException] {
            if ($attempt -ge 30) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}

# Writes Data to Path through Path + $TmpSuffix, which then takes the file's place in one step: File.Replace, or
# File.Move when there is no file yet. Whatever fails, wherever, Path keeps its old bytes (it is never truncated or
# half written) and the temporary file is removed, so Invoke-FileOp can safely try again. Backup, when given, becomes
# the old file, renamed in that same step: it exists only once the change is made. Replace keeps the file's
# attributes and permissions, so a hidden file stays hidden (and, unlike an in-place rewrite, can be written at all).
function Write-FileSafely([string]$Path, [byte[]]$Data, [string]$Backup) {
    $tmp = $Path + $TmpSuffix
    try {
        $stream = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($Data, 0, $Data.Length)
            $stream.Flush($true)   # on disk before it replaces anything
        } finally {
            $stream.Dispose()
        }
        if (-not [System.IO.File]::Exists($Path)) {
            [System.IO.File]::Move($tmp, $Path)
        } elseif ($Backup) {
            [System.IO.File]::Replace($tmp, $Path, $Backup)
        } else {
            [System.IO.File]::Replace($tmp, $Path, [NullString]::Value)   # a plain $null would reach .NET as ''
        }
    } catch {
        if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
        throw
    }
}

function Format-JsonBool([bool]$Value) {
    if ($Value) { return 'true' }
    return 'false'
}

function Test-SameBytes([byte[]]$A, [byte[]]$B) {
    return $A.Length -eq $B.Length -and [string]::Equals($Latin1.GetString($A), $Latin1.GetString($B), $Ordinal)
}

# Stops (exit 5) before anything is written when an existing file a step rewrites or deletes is read-only, or the
# user may not write it, rather than failing halfway through the plan. A file another process holds for a moment
# is no reason to stop: the step itself waits for it (Invoke-FileOp).
function Assert-Writable([string]$Path) {
    if (-not [System.IO.File]::Exists($Path)) { return }
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $stream.Close()
    } catch [System.UnauthorizedAccessException] {
        Stop-Setup 5 "$Path is read-only or not writable. Clear its read-only attribute (or fix its permissions) and run again."
    } catch [System.IO.IOException] {
        return   # held by another process: Invoke-FileOp waits for it when the step runs
    }
}

$plan = New-Object System.Collections.Generic.List[object]
# Backup: for a write over an existing file, that file's name as the output shows it; BackupPath is where the old file
# goes (Get-BackupPath, unless the caller already picked it). The write makes the backup and the change in one step
# (Write-FileSafely), as one decision, so -Confirm can't let the change through without its backup.
function Add-Step([string]$Kind, [string]$Path, [string]$What, [string]$Done, $Data, [string]$Backup = '', [string]$BackupPath = '') {
    if ($Backup -and -not $BackupPath) { $BackupPath = Get-BackupPath $Path }
    $plan.Add([pscustomobject]@{ Kind = $Kind; Path = $Path; What = $What; Done = $Done; Data = $Data; Backup = $Backup; BackupPath = $BackupPath })
}

$profileLock = $null
try {
    if ($null -ne $Rest -and $Rest.Count -gt 0) { Stop-Setup 2 "unknown argument(s): $($Rest -join ' '). $Usage" }
    if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
        Stop-Setup 2 "$Usage. Zen shows the folder in about:support, under ""Profile Folder""."
    }
    $profileItem = Get-Item -LiteralPath $ProfilePath -Force -ErrorAction SilentlyContinue
    if ($null -eq $profileItem -or -not $profileItem.PSIsContainer) { Stop-Setup 3 "not a folder: $ProfilePath" }
    $profileDir = $profileItem.FullName
    if (-not ((Test-Path -LiteralPath (Join-Path $profileDir 'prefs.js') -PathType Leaf) -or
            (Test-Path -LiteralPath (Join-Path $profileDir 'times.json') -PathType Leaf))) {
        Stop-Setup 3 "$profileDir does not look like a Zen profile (it has no prefs.js or times.json)."
    }
    $profileLock = Lock-Profile $profileDir
    $mode = if ($Uninstall) { 'uninstall' } else { 'install' }
    Write-Line "Zen Tidy CSS ($mode): $profileDir"

    $chromeDir = Join-Path $profileDir 'chrome'
    $userChromePath = Join-Path $chromeDir 'userChrome.css'
    $cssDest = Join-Path $chromeDir 'zen-tidy.css'
    $recordPath = Join-Path $chromeDir 'zen-tidy.install.json'
    $userJsPath = Join-Path $profileDir 'user.js'
    # A link would take the writes out of this profile, and install.json, which describes this profile's user.js,
    # could be shared with other profiles; replacing a linked file would also quietly unlink it. So stop before
    # anything is read.
    foreach ($path in @($chromeDir, $userChromePath, $userJsPath, $cssDest, $recordPath)) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        $kind = switch ([string]$item.LinkType) { 'Junction' { 'junction' } 'SymbolicLink' { 'symbolic link' } 'HardLink' { 'hard link' } default { '' } }
        if ($kind) {
            Stop-Setup 5 "$path is a $kind (it may be shared with other profiles). Replace it with a real file or folder of this profile's own and run again."
        }
    }
    foreach ($path in @($cssDest, $recordPath)) {
        if (Test-Path -LiteralPath $path -PathType Container) { throw "$path is a folder, not a file." }
    }
    $record = Read-Record $recordPath
    $userChrome = Read-ProfileText $userChromePath 'chrome\userChrome.css'
    $userJs = Read-ProfileText $userJsPath 'user.js'
    $chromeExists = Test-Path -LiteralPath $chromeDir -PathType Container

    if (-not $Uninstall) {
        if ($CssPath) {
            $cssItem = Get-Item -LiteralPath $CssPath -Force -ErrorAction SilentlyContinue
            if ($null -eq $cssItem -or $cssItem.PSIsContainer) { Stop-Setup 2 "-CssPath: no such file: $CssPath" }
        } else {
            $defaultCss = Join-Path ([System.IO.Path]::GetDirectoryName($PSScriptRoot)) 'css\zen-tidy.css'
            $cssItem = Get-Item -LiteralPath $defaultCss -Force -ErrorAction SilentlyContinue
            if ($null -eq $cssItem -or $cssItem.PSIsContainer) {
                Stop-Setup 2 "no CSS to copy: $defaultCss is missing. Generate it with: node scripts/gen-css.mjs"
            }
        }
        $cssBytes = [System.IO.File]::ReadAllBytes($cssItem.FullName)

        if (-not $chromeExists) { Add-Step 'mkdir' $chromeDir 'create chrome\' 'created chrome\' $null }
        $chromeText = if ($null -eq $userChrome) { '' } else { $userChrome }
        $jsText = if ($null -eq $userJs) { '' } else { $userJs }
        $importPlan = Set-ImportFirst $chromeText
        $prefPlan = Set-PrefLast $jsText
        # chrome\zen-tidy.css: copied when missing, updated when it differs. One that isn't Zen Tidy's is the user's,
        # so it is backed up first, and install.json names that backup for -Uninstall to put back.
        $cssExisted = [System.IO.File]::Exists($cssDest)
        $cssUpdate = $false
        $cssBackupPath = ''
        if ($cssExisted) {
            $currentCss = [System.IO.File]::ReadAllBytes($cssDest)
            $cssUpdate = -not (Test-SameBytes $currentCss $cssBytes)
            if ($cssUpdate -and -not (Test-OurCss $cssDest $record)) { $cssBackupPath = Get-BackupPath $cssDest }
        }
        if ($null -eq $record) {
            # Written first, so an install that stops halfway can still be undone.
            $userValue = $prefPlan.UserValue
            $value = if ($null -eq $userValue) { 'null' } else { (Format-JsonBool $userValue.Value) }
            $savedCss = if ($cssBackupPath) { '"' + [System.IO.Path]::GetFileName($cssBackupPath) + '"' } else { 'null' }
            $json = @(
                '{'
                '  "version": 1,'
                '  "note": "Written by zen-tidy setup-css.ps1: what the first install found, so -Uninstall can put it back.",'
                ('  "created": { "chromeDir": ' + (Format-JsonBool (-not $chromeExists)) + ', "userChrome": ' +
                    (Format-JsonBool ($null -eq $userChrome)) + ', "userJs": ' + (Format-JsonBool ($null -eq $userJs)) +
                    ', "css": ' + (Format-JsonBool (-not $cssExisted)) + ' },')
                ('  "cssBackup": ' + $savedCss + ',')
                ('  "pref": { "name": "' + $PrefName + '", "setByUser": ' + (Format-JsonBool ($null -ne $userValue)) + ', "value": ' + $value + ' }')
                '}'
                ''
            ) -join "`r`n"
            Add-Step 'write' $recordPath 'write chrome\zen-tidy.install.json' 'wrote chrome\zen-tidy.install.json (what -Uninstall restores)' ($Utf8NoBom.GetBytes($json))
        }
        if (-not $cssExisted) {
            Add-Step 'write' $cssDest "copy $($cssItem.FullName) to chrome\zen-tidy.css" 'copied zen-tidy.css to chrome\' $cssBytes
        } elseif ($cssUpdate) {
            $backup = if ($cssBackupPath) { 'chrome\zen-tidy.css' } else { '' }
            Add-Step 'write' $cssDest "update chrome\zen-tidy.css from $($cssItem.FullName)" 'updated chrome\zen-tidy.css' $cssBytes $backup $cssBackupPath
        }
        if ($importPlan.Change) {
            if ($null -eq $userChrome) {
                Add-Step 'write' $userChromePath 'create chrome\userChrome.css with the @import' 'created chrome\userChrome.css with the @import' ($Latin1.GetBytes($importPlan.Text))
            } else {
                $verb = if ($importPlan.Change -eq 'moved') { 'move' } else { 'add' }
                Add-Step 'write' $userChromePath "$verb the @import as the first rule of chrome\userChrome.css" "$($importPlan.Change) the @import as the first rule of chrome\userChrome.css" ($Latin1.GetBytes($importPlan.Text)) 'chrome\userChrome.css'
            }
        }
        if ($prefPlan.Change) {
            if ($null -ne $prefPlan.UserValue -and -not $prefPlan.UserValue.Value) {
                Write-Warning 'user.js sets the userChrome.css pref to false; the zen-tidy line after it overrides that.'
            }
            if ($null -eq $userJs) {
                Add-Step 'write' $userJsPath 'create user.js with the stylesheet pref' 'created user.js with the stylesheet pref' ($Latin1.GetBytes($prefPlan.Text))
            } else {
                $verb = if ($prefPlan.Change -eq 'moved') { 'move' } else { 'add' }
                Add-Step 'write' $userJsPath "$verb the stylesheet pref as the last line of user.js" "$($prefPlan.Change) the stylesheet pref as the last line of user.js" ($Latin1.GetBytes($prefPlan.Text)) 'user.js'
            }
        }
    } else {
        # chrome\ entries the steps delete. (A step that rewrites userChrome.css leaves it there, so chrome\ stays.)
        $leaving = New-Object System.Collections.Generic.List[string]
        if ($null -ne $userChrome) {
            $clean = Remove-Import $userChrome
            if (-not [string]::Equals($clean, $userChrome, $Ordinal)) {
                if ($null -ne $record -and $record.created.userChrome -and $clean.Length -eq 0) {
                    Add-Step 'delete' $userChromePath 'delete chrome\userChrome.css (the install created it)' 'deleted chrome\userChrome.css (the install created it)' $null
                    $leaving.Add('userChrome.css')
                } else {
                    Add-Step 'write' $userChromePath 'remove the @import from chrome\userChrome.css' 'removed the @import from chrome\userChrome.css' ($Latin1.GetBytes($clean)) 'chrome\userChrome.css'
                }
            }
        }
        $jsText = if ($null -eq $userJs) { '' } else { $userJs }
        $clean = Remove-Marker $jsText $PrefLine (Get-BomLength $jsText) -WholeLine
        $restored = $false
        if ($null -ne $record -and $record.pref.setByUser -and $null -eq (Get-PrefState $clean).Last) {
            $value = if ($record.pref.value) { 'true' } else { 'false' }
            $clean = Add-LastLine $clean ('user_pref("' + $PrefName + '", ' + $value + ');')
            $restored = $true
        }
        if (-not [string]::Equals($clean, $jsText, $Ordinal)) {
            if ($null -ne $userJs -and $null -ne $record -and $record.created.userJs -and $clean.Length -eq 0) {
                Add-Step 'delete' $userJsPath 'delete user.js (the install created it)' 'deleted user.js (the install created it)' $null
            } else {
                $backup = if ($null -ne $userJs) { 'user.js' } else { '' }
                $restore = if ($restored) { " and put back your own setting ($value)" } else { '' }
                Add-Step 'write' $userJsPath "remove the stylesheet pref from user.js$restore" "removed the stylesheet pref from user.js$restore" ($Latin1.GetBytes($clean)) $backup
            }
        }
        if ([System.IO.File]::Exists($cssDest)) {
            if (-not (Test-OurCss $cssDest $record)) {
                Write-Line 'kept chrome\zen-tidy.css (the install did not write it)'
            } else {
                # The user's own zen-tidy.css that the install replaced comes back from its backup, if it is still there.
                $savedCss = if ($null -ne $record) { Get-Optional $record 'cssBackup' } else { $null }
                $savedPath = if ($savedCss) { Join-Path $chromeDir $savedCss } else { '' }
                if ($savedPath -and [System.IO.File]::Exists($savedPath)) {
                    Add-Step 'write' $cssDest "put back your own chrome\zen-tidy.css from $savedCss" "put back your own chrome\zen-tidy.css from $savedCss" ([System.IO.File]::ReadAllBytes($savedPath))
                } else {
                    Add-Step 'delete' $cssDest 'delete chrome\zen-tidy.css' 'deleted chrome\zen-tidy.css' $null
                    $leaving.Add('zen-tidy.css')
                }
            }
        }
        if ($null -ne $record) {
            Add-Step 'delete' $recordPath 'delete chrome\zen-tidy.install.json' 'deleted chrome\zen-tidy.install.json' $null
            $leaving.Add('zen-tidy.install.json')
            if ($record.created.chromeDir -and $chromeExists) {
                $left = @(Get-ChildItem -LiteralPath $chromeDir -Force | ForEach-Object { $_.Name } | Where-Object { $leaving -notcontains $_ })
                if ($left.Count -eq 0) { Add-Step 'rmdir' $chromeDir 'delete the empty chrome\ (the install created it)' 'deleted the empty chrome\ (the install created it)' $null }
            }
        } elseif ($plan.Count -gt 0) {
            Write-Line 'note: no chrome\zen-tidy.install.json, so files the install may have created are kept, even if empty.'
        }
    }

    if ($plan.Count -eq 0) {
        Write-Line 'nothing to do'
        exit 0
    }
    foreach ($step in $plan) {
        if ($step.Kind -eq 'write' -or $step.Kind -eq 'delete') { Assert-Writable $step.Path }
    }
    $declined = 0
    $applied = 0
    foreach ($step in $plan) {
        $what = $step.What
        $done = $step.Done
        if ($step.BackupPath) {
            $name = [System.IO.Path]::GetFileName($step.BackupPath)
            $what = "back up $($step.Backup) as $name, then $what"
            $done = "backed up $($step.Backup) as $name, then $done"
        }
        # After a declined -Confirm step, -Uninstall keeps what a later -Uninstall needs to finish: install.json, and
        # chrome\ (planned as empty once the declined step's file was gone).
        if ($declined -gt 0 -and ($step.Kind -eq 'rmdir' -or ($step.Kind -eq 'delete' -and $step.Path -eq $recordPath))) {
            $kept = if ($step.Kind -eq 'rmdir') { 'chrome\' } else { 'chrome\zen-tidy.install.json' }
            Write-Line "  kept $kept (a step before it was declined)"
            continue
        }
        if (-not $PSCmdlet.ShouldProcess($what, "${what}?", 'Zen Tidy CSS')) {
            if ($WhatIfPreference) { continue }
            $declined++
            # An install can't go on without chrome\ or install.json: nothing after them could be written, or undone.
            if (-not $Uninstall -and ($step.Kind -eq 'mkdir' -or $step.Path -eq $recordPath)) { break }
            continue
        }
        switch ($step.Kind) {
            'mkdir' { [void][System.IO.Directory]::CreateDirectory($step.Path) }
            'write' { Invoke-FileOp { Write-FileSafely $step.Path $step.Data $step.BackupPath } }
            'delete' { Invoke-FileOp { [System.IO.File]::Delete($step.Path) } }
            'rmdir' { [System.IO.Directory]::Delete($step.Path, $false) }   # not recursive: fails rather than delete anything in it
        }
        $applied++
        Write-Line "  $done"
    }
    if ($WhatIfPreference) {
        Write-Line '-WhatIf: nothing was written.'
    } elseif ($declined -gt 0 -and $applied -eq 0) {
        Write-Line 'Nothing was changed: a step was declined.'
    } elseif ($declined -gt 0) {
        Write-Line "Partly done: $declined step(s) declined, and what depends on them was left as it is. Run again to finish."
    } elseif ($Uninstall) {
        Write-Line 'Removed. Start Zen to see the change.'
    } else {
        Write-Line 'Installed. Start Zen to load the folder look.'
    }
    exit 0
} catch {
    Stop-Setup 1 $_.Exception.Message
} finally {
    # Lets go of parent.lock (and deletes it, if the script created it), however the script ends: exit runs this too.
    if ($null -ne $profileLock) { $profileLock.Dispose() }
}

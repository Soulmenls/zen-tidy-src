# The passphrase lock on the stored Mozilla Add-ons (AMO) API key, dot-sourced by scripts\amo-credentials.ps1 (which
# stores the key) and scripts\sign.ps1 (which unlocks it to sign). Runs in Windows PowerShell 5.1 (.NET Framework 4.8)
# and PowerShell 7, on Windows only: DPAPI and the dialog are Windows'.
#
# The key stays on this PC between releases, so two locks hold it. The passphrase goes through PBKDF2-HMAC-SHA256 with a
# random salt, and the result is DPAPI's optional entropy: DPAPI (CurrentUser) then seals the issuer and secret so only
# this Windows account can open them, and only with that entropy. DPAPI authenticates what it sealed, so a wrong
# passphrase, or a change on disk to the salt, the iteration count or the sealed content, fails as a
# CryptographicException instead of giving back other bytes. Malware running as this account could still read the passphrase as it is typed; the lock
# keeps the key from being used silently while no release is being signed.
#
# The passphrase only ever comes from a person: Read-AmoPassphrase's dialog in sign.ps1, Read-Host -AsSecureString in
# amo-credentials.ps1 (run in a terminal). Neither script takes it as a parameter, a variable, a file or pipeline input.
# Every byte or char array these functions hold it, the entropy or the unsealed key in is cleared once used; copies
# DPAPI makes inside its own calls are out of their reach.
#
# No cmdlet is ever handed the secret in clear, here or in the two scripts: with PowerShell's module logging on (a
# common hardening policy), every argument a cmdlet is given goes to the event log, which outlives the release. So the
# secret is sealed and unsealed with .NET calls only, as the issuer, a line feed and the secret in UTF-8: no JSON cmdlet.

Add-Type -AssemblyName System.Security

$AmoKeyFormat = 'zen-tidy-amo-key/2'
$AmoKeyKdf = 'PBKDF2-HMAC-SHA256'
# About 1.8 s in Windows PowerShell 5.1 on this PC (0.2 s in PowerShell 7), once per release. A stored count outside the
# range is refused, so a changed file can't make the derivation trivial or endless.
$AmoKeyIterations = 1000000
$AmoKeyMinIterations = 600000
$AmoKeyMaxIterations = 10000000
$AmoKeySaltBytes = 16
$AmoKeyMinPassphrase = 12
$AmoPassphraseTimeoutSeconds = 300
# The one message for a passphrase that doesn't unlock the key: DPAPI can't tell a wrong passphrase from a changed file.
$AmoKeyWrongPassphrase = 'Wrong passphrase, or the stored AMO key was changed.'

# A SecureString's characters as UTF-8 bytes, without a managed string in between. The caller clears the array.
function ConvertTo-AmoKeyBytes {
    param([Parameter(Mandatory)] [securestring]$Value)
    $chars = New-Object char[] $Value.Length
    # Allocated inside the try, so the unmanaged copy is zeroed and freed whatever throws after it.
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Value)
        [Runtime.InteropServices.Marshal]::Copy($pointer, $chars, 0, $chars.Length)
        # The comma keeps PowerShell from unrolling the array into its bytes.
        return , [Text.Encoding]::UTF8.GetBytes($chars)
    } finally {
        [Array]::Clear($chars, 0, $chars.Length)
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }
    }
}

# DPAPI's entropy for this passphrase: 32 bytes of PBKDF2-HMAC-SHA256. The 4-argument constructor is in .NET Framework
# 4.7.2 and later; the static Pbkdf2 method is not in 4.8. The caller clears the array.
function Get-AmoKeyEntropy {
    param([Parameter(Mandatory)] [securestring]$Passphrase, [Parameter(Mandatory)] [byte[]]$Salt, [Parameter(Mandatory)] [int]$Iterations)
    $bytes = ConvertTo-AmoKeyBytes $Passphrase
    $kdf = $null
    try {
        $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($bytes, $Salt, $Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
        return , $kdf.GetBytes(32)
    } finally {
        if ($kdf) { $kdf.Dispose() }
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

# Whether two SecureStrings hold the same characters, compared as bytes.
function Test-AmoKeySame {
    param([Parameter(Mandatory)] [securestring]$First, [Parameter(Mandatory)] [securestring]$Second)
    $one = ConvertTo-AmoKeyBytes $First
    $two = ConvertTo-AmoKeyBytes $Second
    try {
        if ($one.Length -ne $two.Length) { return $false }
        for ($i = 0; $i -lt $one.Length; $i++) {
            if ($one[$i] -ne $two[$i]) { return $false }
        }
        return $true
    } finally {
        [Array]::Clear($one, 0, $one.Length)
        [Array]::Clear($two, 0, $two.Length)
    }
}

# The object amo-credentials.ps1 saves with Export-Clixml: the issuer, a line feed and the secret as UTF-8, sealed with
# DPAPI and the passphrase's entropy, next to what unlocking them needs (none of it secret). The secret goes from its
# SecureString to those bytes without a string in between.
function Protect-AmoKey {
    param([Parameter(Mandatory)] [string]$Issuer, [Parameter(Mandatory)] [securestring]$Secret, [Parameter(Mandatory)] [securestring]$Passphrase)
    # Unprotect-AmoKey ends the issuer at the first line feed.
    if ($Issuer.IndexOfAny([char[]]"`r`n") -ge 0) { throw 'The JWT issuer must be a single line.' }
    # amo-credentials.ps1 checks both first; this keeps a key that could never be unlocked or used from being stored.
    if ($Secret.Length -eq 0) { throw 'The JWT secret is empty.' }
    if ($Passphrase.Length -lt $AmoKeyMinPassphrase) { throw "The passphrase needs at least $AmoKeyMinPassphrase characters." }
    $salt = New-Object byte[] $AmoKeySaltBytes
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($salt) } finally { $random.Dispose() }
    $issuerBytes = [Text.Encoding]::UTF8.GetBytes($Issuer)
    $entropy = $null
    $secretBytes = $null
    $plain = $null
    try {
        $entropy = Get-AmoKeyEntropy -Passphrase $Passphrase -Salt $salt -Iterations $AmoKeyIterations
        $secretBytes = ConvertTo-AmoKeyBytes $Secret
        $plain = [byte[]]::new($issuerBytes.Length + 1 + $secretBytes.Length)
        [Array]::Copy($issuerBytes, 0, $plain, 0, $issuerBytes.Length)
        $plain[$issuerBytes.Length] = 10
        [Array]::Copy($secretBytes, 0, $plain, $issuerBytes.Length + 1, $secretBytes.Length)
        $sealed = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    } finally {
        if ($entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
        if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
    }
    [pscustomobject]@{
        Format = $AmoKeyFormat
        Kdf = $AmoKeyKdf
        Iterations = $AmoKeyIterations
        Salt = [Convert]::ToBase64String($salt)
        Sealed = [Convert]::ToBase64String($sealed)
        Created = [DateTime]::UtcNow.ToString('s') + 'Z'
    }
}

# The saved object, or $null when nothing is stored at that path.
function Import-AmoKey {
    param([Parameter(Mandatory)] [string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $null }
    Import-Clixml -LiteralPath $LiteralPath
}

# Why a saved object can't be unlocked, as the end of a sentence about "The stored AMO key", or $null when it can be
# tried. Reads only the parts that are not secret: nothing is unsealed.
function Get-AmoKeyProblem {
    param([Parameter(Mandatory)] $Stored)
    if (@($Stored.PSObject.Properties.Name) -notcontains 'Format') {
        # The PSCredential amo-credentials.ps1 saved before the passphrase lock: DPAPI alone.
        if ($Stored -is [System.Management.Automation.PSCredential]) { return 'is an old one, stored without a passphrase' }
        return 'is not one amo-credentials.ps1 stored'
    }
    if ($Stored.Format -ne $AmoKeyFormat) { return "has the format '$($Stored.Format)', not $AmoKeyFormat" }
    if ($Stored.Kdf -ne $AmoKeyKdf) { return "uses the key derivation '$($Stored.Kdf)', not $AmoKeyKdf" }
    if ($Stored.Iterations -isnot [int] -or $Stored.Iterations -lt $AmoKeyMinIterations -or $Stored.Iterations -gt $AmoKeyMaxIterations) {
        return "has the iteration count '$($Stored.Iterations)', not one from $AmoKeyMinIterations to $AmoKeyMaxIterations"
    }
    try { $salt = [Convert]::FromBase64String([string]$Stored.Salt) } catch { return 'has a salt that is not base64' }
    if ($salt.Length -ne $AmoKeySaltBytes) { return "has a $($salt.Length)-byte salt, not $AmoKeySaltBytes bytes" }
    try { $sealed = [Convert]::FromBase64String([string]$Stored.Sealed) } catch { return 'has a sealed part that is not base64' }
    if ($sealed.Length -eq 0) { return 'has nothing sealed' }
    return $null
}

# The key as a PSCredential (the issuer as UserName, the secret as a SecureString), the way sign.ps1 used the DPAPI-only
# one. A passphrase that doesn't unlock it throws a CryptographicException with $AmoKeyWrongPassphrase, which sign.ps1
# catches to ask again; anything else wrong with the object throws before the passphrase is used.
function Unprotect-AmoKey {
    param([Parameter(Mandatory)] $Stored, [Parameter(Mandatory)] [securestring]$Passphrase)
    $problem = Get-AmoKeyProblem $Stored
    if ($problem) { throw "The stored AMO key $problem." }
    $salt = [Convert]::FromBase64String($Stored.Salt)
    $sealed = [Convert]::FromBase64String($Stored.Sealed)
    $entropy = $null
    $plain = $null
    $chars = $null
    try {
        $entropy = Get-AmoKeyEntropy -Passphrase $Passphrase -Salt $salt -Iterations $Stored.Iterations
        try {
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        } catch [System.Security.Cryptography.CryptographicException] {
            throw [System.Security.Cryptography.CryptographicException]::new($AmoKeyWrongPassphrase)
        }
        # .NET calls only from here on: no cmdlet or pipeline sees the unsealed key. The issuer is what comes before the
        # first line feed; the secret's characters go straight from the array into the SecureString.
        $chars = [Text.Encoding]::UTF8.GetChars($plain)
        $split = [Array]::IndexOf($chars, [char]10)
        if ($split -lt 1 -or $split -eq $chars.Length - 1) {
            throw 'The stored AMO key unlocked, but holds no issuer and secret: store it again.'
        }
        $secret = [System.Security.SecureString]::new()
        for ($i = $split + 1; $i -lt $chars.Length; $i++) { $secret.AppendChar($chars[$i]) }
        $secret.MakeReadOnly()
        [System.Management.Automation.PSCredential]::new([string]::new($chars, 0, $split), $secret)
    } finally {
        if ($entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
        if ($chars) { [Array]::Clear($chars, 0, $chars.Length) }
    }
}

# Asks for the passphrase in a window: sign.ps1 runs as a child of release.mjs, which a tool may have started with no
# console input to read from. The window stays on top, masks what is typed, says what it unlocks and for what, shows
# $Problem (the last attempt's error) in red, and closes itself after $AmoPassphraseTimeoutSeconds. Returns the
# passphrase as a read-only SecureString, or $null when cancelled, closed or timed out.
function Read-AmoPassphrase {
    param([Parameter(Mandatory)] [string]$Subject, [string]$Problem = '')
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Zen Tidy: unlock the AMO key'
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.TopMost = $true
    $form.ClientSize = New-Object System.Drawing.Size(440, 190)

    $about = New-Object System.Windows.Forms.Label
    $about.Location = New-Object System.Drawing.Point(12, 12)
    $about.Size = New-Object System.Drawing.Size(416, 48)
    $about.Text = 'The passphrase of the Mozilla Add-ons (AMO) API key stored on this PC. ' +
        "It unlocks the key once, to sign $Subject on addons.mozilla.org."

    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(12, 66)
    $box.Width = 416
    $box.UseSystemPasswordChar = $true

    $errorLine = New-Object System.Windows.Forms.Label
    $errorLine.Location = New-Object System.Drawing.Point(12, 96)
    $errorLine.Size = New-Object System.Drawing.Size(416, 40)
    $errorLine.ForeColor = [System.Drawing.Color]::Firebrick
    $errorLine.Text = $Problem

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'Unlock and sign'
    $ok.Location = New-Object System.Drawing.Point(222, 148)
    $ok.Size = New-Object System.Drawing.Size(120, 28)
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.Enabled = $false

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object System.Drawing.Point(348, 148)
    $cancel.Size = New-Object System.Drawing.Size(80, 28)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

    $form.Controls.AddRange(@($about, $box, $errorLine, $ok, $cancel))
    $form.AcceptButton = $ok
    $form.CancelButton = $cancel

    # Nothing to unlock with until something is typed.
    $box.Add_TextChanged({ $ok.Enabled = $box.TextLength -gt 0 })
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $AmoPassphraseTimeoutSeconds * 1000
    $timer.Add_Tick({
        $timer.Stop()
        $form.Close()
    })
    $form.Add_Shown({
        $form.Activate()
        [void]$box.Focus()
        $timer.Start()
    })

    # The text box holds what is typed as a managed string, which can't be cleared; the box is emptied once read, and
    # the copy made here is cleared.
    $chars = $null
    try {
        if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
        $passphrase = [System.Security.SecureString]::new()
        $chars = $box.Text.ToCharArray()
        foreach ($char in $chars) { $passphrase.AppendChar($char) }
        $passphrase.MakeReadOnly()
        return $passphrase
    } finally {
        if ($chars) { [Array]::Clear($chars, 0, $chars.Length) }
        $box.Clear()
        $timer.Dispose()
        $form.Dispose()
    }
}

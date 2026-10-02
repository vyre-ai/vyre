# install-windows.ps1: install the Vyre Windows app (tray, Alt+Space panel, autostart,
# self-update -- docs/design/windows-plan.md section 9, plans/windows.md sections 2-4). This is
# what `$env:VYRE_CODE='...'; irm https://vyre.run/w | iex` runs (PLAN-setup-redo.md blocker B2).
#
# STATUS (2026-10-02): the app ships unsigned for 0.2 (Authenticode later). release.yml builds VyreSetup.exe
# into every release (and Vyre_<version>_x64-setup.exe, the same bytes, which the app's updater reads), and
# lists both in the release's SHA256SUMS. This script takes the newest plain stable vX.Y.Z release that carries
# VyreSetup.exe and SHA256SUMS (a prerelease tag is never chosen; VYRE_RELEASE_BASE names another one), checks
# the installer's SHA-256 against its line there, and tells the person about "More info, then Run anyway".
# It first verifies SHA256SUMS.sig (Ed25519) against the pinned Vyre release key and refuses a release with no
# signature or a bad one; the installer is only fetched after that, and checked against the signed list.
# This file is also what https://vyre.run/w serves (scripts/build-site.sh).
#
# Env: VYRE_CODE (the single-use setup ticket, plans/windows.md section 3 "Pairing" -- read from
# the environment or a prompt, NEVER written to a file or passed as an argv token per reviewer
# N-M5), VYRE_INSTALL_DIR (default $env:LOCALAPPDATA\Vyre), VYRE_RELEASE_BASE (default: the newest
# stable vX.Y.Z GitHub release that carries VyreSetup.exe).
#
#   -Uninstall     stop the app, remove the tray/autostart/protocol-key registration and the
#                  install dir (reviewer W-M5/N-L3: also revokes this device's session on the box
#                  -- see Remove-VyreWindows)
#   -DryRun        print every step, change nothing

param(
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# --- W-M2: Constrained Language Mode / AppLocker / EDR detection (build step 9b) -----------------
# `irm | iex` itself can't run at all under CLM (no Add-Type, no .NET reflection some verification
# paths need), and several EDR products specifically flag the "download and iex an exe" shape.
# Detect early and give a first-class alternative rather than a confusing failure mid-script.
function Test-ConstrainedLanguageMode {
    $mode = $ExecutionContext.SessionState.LanguageMode
    if ($mode -ne "FullLanguage") {
        Write-Host ""
        Write-Host "Your PowerShell session is running in $mode, most likely set by your" -ForegroundColor Yellow
        Write-Host "organization's security policy. This installer needs FullLanguage mode." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Download the signed installer instead:" -ForegroundColor Yellow
        Write-Host "  https://github.com/vyre-ai/vyre/releases (the newest stable release, file VyreSetup.exe)"
        Write-Host ""
        exit 1
    }
}

# --- Install trust (0.2.2): the first install verifies the release signature --------------------------
# The Vyre release key (Ed25519) signs "vyre-release-sums\n" + the exact bytes of SHA256SUMS
# (SHA256SUMS.sig, the one signature Linux, Mac and the Windows updater all use). Windows PowerShell 5.1
# has no Ed25519, so the check below is plain .NET BigInteger arithmetic (RFC 8032 verification, a few
# milliseconds). The order is: fetch SHA256SUMS and its signature, verify, and only then fetch the
# installer and check its SHA-256 against the signed list. A release with no signature is refused.
# The key is pinned here and must equal RELEASE_KEY in core/vyre-core/release.js
# (scripts/check-release-key.mjs checks it). VYRE_RELEASE_KEY is a test seam, like box/vyre's.
# The app is still not Authenticode-signed, so Windows shows its "unrecognized app" notice.
$ReleaseKey = if ($env:VYRE_RELEASE_KEY) { $env:VYRE_RELEASE_KEY } else { "MCowBQYDK2VwAyEAKXSdujH7tO/gscXCJZmYCjB+Cv1sVlOfdgLNedMR7FU=" }

Add-Type -AssemblyName System.Numerics
$script:Fp = [System.Numerics.BigInteger]::Pow(2, 255) - 19
$script:Fl = [System.Numerics.BigInteger]::Pow(2, 252) + [System.Numerics.BigInteger]::Parse("27742317777372353535851937790883648493")

function ConvertFrom-LittleEndian([byte[]]$Bytes) {
    $x = New-Object byte[] ($Bytes.Length + 1)
    [Array]::Copy($Bytes, $x, $Bytes.Length)
    [System.Numerics.BigInteger]::new($x)
}
function Get-FieldMod($a) { $r = [System.Numerics.BigInteger]::Remainder($a, $script:Fp); if ($r.Sign -lt 0) { $r += $script:Fp }; $r }
function Get-FieldInverse($a) { [System.Numerics.BigInteger]::ModPow((Get-FieldMod $a), $script:Fp - 2, $script:Fp) }

$script:Fd = Get-FieldMod ([System.Numerics.BigInteger]::MinusOne * 121665 * (Get-FieldInverse 121666))
$script:F2d = Get-FieldMod (2 * $script:Fd)
$script:Fsqrtm1 = [System.Numerics.BigInteger]::ModPow(2, ($script:Fp - 1) / 4, $script:Fp)

# A point is @(X, Y, Z, T) in extended coordinates (twisted Edwards, a = -1).
function ConvertFrom-PointBytes([byte[]]$Bytes) {
    if ($Bytes.Length -ne 32) { return $null }
    $sign = ($Bytes[31] -shr 7) -band 1
    $copy = [byte[]]$Bytes.Clone(); $copy[31] = $copy[31] -band 0x7f
    $y = ConvertFrom-LittleEndian $copy
    if ($y -ge $script:Fp) { return $null }
    $y2 = Get-FieldMod ($y * $y)
    $x2 = Get-FieldMod ((Get-FieldMod ($y2 - 1)) * (Get-FieldInverse ($script:Fd * $y2 + 1)))
    $x = [System.Numerics.BigInteger]::ModPow($x2, ($script:Fp + 3) / 8, $script:Fp)
    if ((Get-FieldMod ($x * $x - $x2)) -ne 0) { $x = Get-FieldMod ($x * $script:Fsqrtm1) }
    if ((Get-FieldMod ($x * $x - $x2)) -ne 0) { return $null }
    if ($x.IsZero -and $sign -eq 1) { return $null }
    if (([int]($x % 2)) -ne $sign) { $x = Get-FieldMod ($script:Fp - $x) }
    @($x, $y, [System.Numerics.BigInteger]::One, (Get-FieldMod ($x * $y)))
}

function Add-Point($p, $q) {
    $a = Get-FieldMod (($p[1] - $p[0]) * ($q[1] - $q[0]))
    $b = Get-FieldMod (($p[1] + $p[0]) * ($q[1] + $q[0]))
    $c = Get-FieldMod ($p[3] * $script:F2d * $q[3])
    $d = Get-FieldMod (2 * $p[2] * $q[2])
    $e = $b - $a; $f = $d - $c; $g = $d + $c; $h = $b + $a
    @((Get-FieldMod ($e * $f)), (Get-FieldMod ($g * $h)), (Get-FieldMod ($f * $g)), (Get-FieldMod ($e * $h)))
}

function Invoke-ScalarMultiply([System.Numerics.BigInteger]$k, $point) {
    $r = @([System.Numerics.BigInteger]::Zero, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::Zero)
    $bytes = $k.ToByteArray()
    for ($i = ($bytes.Length * 8) - 1; $i -ge 0; $i--) {
        $r = Add-Point $r $r
        if ((($bytes[[int][Math]::Floor($i / 8)] -shr ($i % 8)) -band 1) -eq 1) { $r = Add-Point $r $point }
    }
    $r
}

# RFC 8032 verification: [S]B == R + [h]A, with h = SHA-512(R || A || message) mod L and S < L.
function Test-Ed25519([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature) {
    if ($PublicKey.Length -ne 32 -or $Signature.Length -ne 64) { return $false }
    $A = ConvertFrom-PointBytes $PublicKey
    $R = ConvertFrom-PointBytes ([byte[]]$Signature[0..31])
    if (-not $A -or -not $R) { return $false }
    $S = ConvertFrom-LittleEndian ([byte[]]$Signature[32..63])
    if ($S -ge $script:Fl) { return $false }
    $sha = [System.Security.Cryptography.SHA512]::Create()
    $h = ConvertFrom-LittleEndian ($sha.ComputeHash([byte[]]($Signature[0..31] + $PublicKey + $Message)))
    $k = [System.Numerics.BigInteger]::Remainder($h, $script:Fl)
    $B = ConvertFrom-PointBytes ([byte[]](,0x58 + (,0x66 * 31)))
    $lhs = Invoke-ScalarMultiply $S $B
    $rhs = Add-Point $R (Invoke-ScalarMultiply $k $A)
    ((Get-FieldMod ($lhs[0] * $rhs[2] - $rhs[0] * $lhs[2])) -eq 0) -and ((Get-FieldMod ($lhs[1] * $rhs[2] - $rhs[1] * $lhs[2])) -eq 0)
}

# True when `Signature` (base64) is the release key's signature over "vyre-release-sums\n" + SumsBytes.
function Test-ReleaseSignature([byte[]]$SumsBytes, [string]$Signature, [string]$Key = $ReleaseKey) {
    try {
        $spki = [Convert]::FromBase64String($Key)
        $head = [byte[]](0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
        if ($spki.Length -ne 44) { return $false }
        for ($i = 0; $i -lt 12; $i++) { if ($spki[$i] -ne $head[$i]) { return $false } }
        $sig = [Convert]::FromBase64String($Signature.Trim())
        $msg = [byte[]]([System.Text.Encoding]::ASCII.GetBytes("vyre-release-sums`n") + $SumsBytes)
        Test-Ed25519 ([byte[]]$spki[12..43]) $msg $sig
    } catch { $false }
}

# A test can load just the functions above: VYRE_LIB_ONLY=1 and dot-source this file.
if ($env:VYRE_LIB_ONLY -eq "1") { return }

function Verify-Sha256 {
    param([string]$Path, [string]$ExpectedHex)
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
    if ($actual -ine $ExpectedHex) {
        throw "SHA-256 mismatch for $Path`nexpected: $ExpectedHex`nactual:   $actual"
    }
}

function Get-VerifiedInstaller {
    param([string]$ReleaseBase, [string]$Dest)

    Write-Host "Windows may say it does not recognize this app. Choose More info, then Run anyway."

    $sumsPath = Join-Path $Dest "SHA256SUMS"
    $sigPath  = Join-Path $Dest "SHA256SUMS.sig"
    $exePath  = Join-Path $Dest "VyreSetup.exe"

    # A key from the environment is a test seam; never let it pass quietly (reviewer-2).
    if ($env:VYRE_RELEASE_KEY) { Write-Host "Using a test release key from VYRE_RELEASE_KEY, not Vyre's." -ForegroundColor Yellow }

    # 1. The signed list first: nothing is run, or even downloaded, before its signature holds.
    Invoke-WebRequest -Uri "$ReleaseBase/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
    try { Invoke-WebRequest -Uri "$ReleaseBase/SHA256SUMS.sig" -OutFile $sigPath -UseBasicParsing }
    catch { throw "This release has no signature (SHA256SUMS.sig), so it is not installed." }
    $sumsBytes = [System.IO.File]::ReadAllBytes($sumsPath)
    if (-not (Test-ReleaseSignature $sumsBytes (Get-Content $sigPath -Raw))) {
        throw "The release signature does not match the Vyre release key, so nothing was installed."
    }
    Write-Host "Release signature verified."

    # 2. Only now the installer, which must be the file the signed list names.
    $lines = @([System.Text.Encoding]::UTF8.GetString($sumsBytes) -split "`n" | Where-Object { $_ -match '^[0-9a-fA-F]{64}\s+\*?VyreSetup\.exe\s*$' })
    if ($lines.Count -ne 1) { throw "SHA256SUMS must list VyreSetup.exe exactly once; refusing to run it." }
    $expected = ($lines[0].Trim() -split '\s+')[0]
    Invoke-WebRequest -Uri "$ReleaseBase/VyreSetup.exe" -OutFile $exePath -UseBasicParsing
    Verify-Sha256 -Path $exePath -ExpectedHex $expected

    return $exePath
}

# --- Autostart / uninstall (plans/windows.md 6.6, reviewer W-M5 re-review) ------------------------
# schtasks, not a Windows Service: vyred/the shell run as the signed-in person, never elevated,
# same "runs as the person" boundary the rest of this plan assumes (docs/design/windows-plan.md
# section 8, the Windows Solo design this borrows the schtasks shape from).
function Register-VyreAutostart {
    param([string]$ExePath)
    schtasks /create /tn "Vyre" /tr "`"$ExePath`"" /sc onlogon /rl limited /f | Out-Null
}

function Remove-VyreWindows {
    param([string]$InstallDir)
    Write-Host "Uninstalling Vyre..."
    schtasks /delete /tn "Vyre" /f 2>$null | Out-Null
    # TODO (reviewer W-M5 re-review, still open): revoke this device's session on the box on EVERY
    # presence path, not just when the KeyCredentialManager fallback shipped -- needs a real box
    # call (device.remove/presence.remove per plans/windows.md 6.6), which needs the app's own
    # pairing-record file read here to know which box to call. Deliberately not guessed at in this
    # draft; tracked in docs/work/windows.md "Next".
    # TODO: remove the vyre:// protocol-handler registry key and the Start-menu shortcut (both are
    # written by the installer .exe itself, once it exists -- this script only removes what IT
    # registers directly, which today is only the scheduled task).
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
    }
    Write-Host "Done."
}

# --- main ------------------------------------------------------------------------------------------

$InstallDir = $env:VYRE_INSTALL_DIR
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "Vyre" }

if ($Uninstall) {
    if ($DryRun) { Write-Host "(dry run) would remove $InstallDir and the Vyre scheduled task"; exit 0 }
    Remove-VyreWindows -InstallDir $InstallDir
    exit 0
}

Test-ConstrainedLanguageMode

# The setup code (reviewer N-M5): read from the environment only, per B2/B3. NEVER written to a
# file, NEVER passed as an argv token (both would leak it into process-list snapshots or disk).
$code = $env:VYRE_CODE
if (-not $code) {
    $code = Read-Host -Prompt "Enter your Vyre setup code" -AsSecureString
    $code = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($code))
}

if ($DryRun) {
    Write-Host "(dry run) would install to $InstallDir, register autostart, launch with the setup code"
    exit 0
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$releaseBase = $env:VYRE_RELEASE_BASE
if (-not $releaseBase) {
    # GitHub's "latest" release is often an Android one with no Windows files, and the REST API answers 403 to a
    # shared address after 60 calls an hour. So read the public releases feed, take the newest plain vX.Y.Z tag,
    # and use it only if it carries the installer and its checksums.
    $feed = (Invoke-WebRequest "https://github.com/vyre-ai/vyre/releases.atom" -UseBasicParsing).Content
    $tag = [regex]::Matches($feed, '/releases/tag/(v\d+\.\d+\.\d+)(?=["<&])') | ForEach-Object { $_.Groups[1].Value } |
        Sort-Object { [version]($_.TrimStart('v')) } -Descending -Unique | Select-Object -First 1
    if (-not $tag) { throw "No release found." }
    $releaseBase = "https://github.com/vyre-ai/vyre/releases/download/$tag"
    foreach ($f in "VyreSetup.exe", "SHA256SUMS") {
        try { Invoke-WebRequest "$releaseBase/$f" -Method Head -UseBasicParsing | Out-Null } catch { throw "No Windows release has been published yet ($tag has no $f)." }
    }
}

$exe = Get-VerifiedInstaller -ReleaseBase $releaseBase -Dest $InstallDir
# Run the installer quietly (per-user, no elevation), then start the installed app.
Start-Process -FilePath $exe -ArgumentList "/S" -Wait
$app = Join-Path $env:LOCALAPPDATA "Vyre\Vyre.exe"
if (-not (Test-Path $app)) { throw "The installer finished but $app is not there." }
Register-VyreAutostart -ExePath $app

# The setup code is not handed to the app yet: how the app claims with it is launch's contract,
# still open. Until then the app starts at its own first-run screen, and $code stays in memory only.
Start-Process -FilePath $app

Write-Host ""
Write-Host "Vyre is starting. A window will open to finish setup."
Write-Host ""

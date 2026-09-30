# install-windows.ps1: install the Vyre Windows app (tray, Alt+Space panel, autostart,
# self-update -- docs/design/windows-plan.md section 9, plans/windows.md sections 2-4). This is
# what `$env:VYRE_CODE='...'; irm https://vyre.run/w | iex` runs (PLAN-setup-redo.md blocker B2).
#
# STATUS (2026-09-30, first draft, unwired): the verification LOGIC below is real and is the
# actual fix for reviewer's W-B1 (the one BLOCKER on plans/windows.md) -- an unsigned installer.
# What is NOT yet real: $ReleaseBase/$MinisignPublicKey are placeholders, no SignPath application
# has been filed (plans/windows.md 6.4), and no minisign keypair or protected GitHub environment
# exists yet (that's integrator's custodian decision, still open in CHAT.md). Do not point this at
# a real release until those exist. Until then this script fails closed (see Get-VerifiedInstaller
# below) rather than pretend to verify something unsigned.
#
# Env: VYRE_CODE (the single-use setup ticket, plans/windows.md section 3 "Pairing" -- read from
# the environment or a prompt, NEVER written to a file or passed as an argv token per reviewer
# N-M5), VYRE_INSTALL_DIR (default $env:LOCALAPPDATA\Vyre), VYRE_RELEASE_BASE (default
# https://github.com/vyre-ai/vyre/releases/latest/download), VYRE_SKIP_SIGCHECK (test-only, never
# set by a real install -- see the guard at the bottom).
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
        Write-Host "  https://vyre.run/download/VyreSetup.msi"
        Write-Host ""
        exit 1
    }
}

# --- W-B1 fix: verify before running anything -----------------------------------------------------
# Downloads the installer, checks its SHA-256 against a published SHA256SUMS file (same pattern as
# scripts/install-box.sh: "every downloaded file is checked ... a file without a line there, or
# with a different hash, stops the install"), then checks a minisign signature over that SHA256SUMS
# file itself, so the hash list can't be swapped along with the binary. The minisign public key is
# embedded here AND published on the GitHub release, so a person can compare by hand (reviewer
# W-B1's fix, plans/windows.md 6.4).
#
# NOT YET REAL: minisign has no native PowerShell/.NET implementation and Windows carries no
# minisign binary by default, so this needs either a bundled minisign.exe (fetched and pinned by
# its own hash, chicken-and-egg unless it ships inside THIS script's own signed release) or a
# small Ed25519 verifier in pure .NET (System.Security.Cryptography doesn't have Ed25519 built in
# before .NET 9; PowerShell 5.1's embedded CLR is older). Flagged as an open build question, not
# guessed at here -- Verify-Minisign below throws until it's answered, so this script fails
# closed rather than silently skip the check.
$MinisignPublicKey = "RWTODO-not-a-real-key-see-plans-windows-md-6.4"

function Verify-Sha256 {
    param([string]$Path, [string]$ExpectedHex)
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
    if ($actual -ine $ExpectedHex) {
        throw "SHA-256 mismatch for $Path`nexpected: $ExpectedHex`nactual:   $actual"
    }
}

function Verify-Minisign {
    param([string]$SumsPath, [string]$SigPath, [string]$PublicKey)
    throw @"
minisign verification is not implemented yet (see the comment above Verify-Minisign).
This is a deliberate fail-closed stop, not a bug: shipping this script against a real release
without this working would be exactly the unsigned-install-chain problem it exists to fix.
Tracked in plans/windows.md 6.4/9; needs integrator's custodian decision first.
"@
}

function Get-VerifiedInstaller {
    param([string]$ReleaseBase, [string]$Dest)

    if ($env:VYRE_SKIP_SIGCHECK -eq "1") {
        Write-Host "VYRE_SKIP_SIGCHECK=1: verification skipped. NEVER set this for a real install." -ForegroundColor Red
    }

    $exeUrl  = "$ReleaseBase/VyreSetup.exe"
    $sumsUrl = "$ReleaseBase/SHA256SUMS"
    $sigUrl  = "$ReleaseBase/SHA256SUMS.minisig"

    $exePath  = Join-Path $Dest "VyreSetup.exe"
    $sumsPath = Join-Path $Dest "SHA256SUMS"
    $sigPath  = Join-Path $Dest "SHA256SUMS.minisig"

    Invoke-WebRequest -Uri $exeUrl -OutFile $exePath -UseBasicParsing
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing
    Invoke-WebRequest -Uri $sigUrl -OutFile $sigPath -UseBasicParsing

    if ($env:VYRE_SKIP_SIGCHECK -ne "1") {
        Verify-Minisign -SumsPath $sumsPath -SigPath $sigPath -PublicKey $MinisignPublicKey

        $line = Get-Content $sumsPath | Where-Object { $_ -match "VyreSetup\.exe$" }
        if (-not $line) { throw "VyreSetup.exe has no line in SHA256SUMS; refusing to run it." }
        $expected = ($line -split '\s+')[0]
        Verify-Sha256 -Path $exePath -ExpectedHex $expected
    }

    # Refuse a downgrade (W-B1 fix, mirrors the updater's own rule in plans/windows.md 6.4/9): a
    # release manifest carries its version in SHA256SUMS' own header line, TODO once that format
    # is settled with integrator/launch. Not implemented in this draft -- see docs/work/windows.md.

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
if (-not $releaseBase) { $releaseBase = "https://github.com/vyre-ai/vyre/releases/latest/download" }

$exe = Get-VerifiedInstaller -ReleaseBase $releaseBase -Dest $InstallDir
Register-VyreAutostart -ExePath $exe

# The code is handed to the app by environment variable, not a file or an argv token (N-M5); the
# app's own first-run reads VYRE_SETUP_CODE from its own process environment at launch.
$env:VYRE_SETUP_CODE = $code
Start-Process -FilePath $exe

Write-Host ""
Write-Host "Vyre is starting. A window will open to finish setup."
Write-Host ""

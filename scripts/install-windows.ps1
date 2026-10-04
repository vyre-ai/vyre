# install-windows.ps1: install the Vyre Windows app (tray, Alt+Space panel, autostart,
# self-update -- docs/design/windows-plan.md section 9, plans/windows.md sections 2-4). This is
# what `$env:VYRE_CODE='...'; irm https://vyre.run/w | iex` runs (PLAN-setup-redo.md blocker B2).
#
# STATUS (2026-10-02): the app ships unsigned for 0.2 (Authenticode later). release.yml builds VyreSetup.exe
# into every release (and Vyre_<version>_x64-setup.exe, the same bytes, which the app's updater reads), and
# lists both in the release's SHA256SUMS. This script takes the newest plain stable vX.Y.Z release that carries
# VyreSetup.exe and SHA256SUMS (a prerelease tag is never chosen; VYRE_RELEASE_BASE names another one), checks
# the installer's SHA-256 against its line there, and tells the person about "More info, then Run anyway".
# It does NOT check SHA256SUMS.sig (Ed25519): Windows PowerShell 5.1 cannot, so the first install trusts
# GitHub's https for SHA256SUMS; every later update is verified by the app against the Vyre release key, and
# anything unsigned is refused there. This file is also what https://vyre.run/w serves (scripts/build-site.sh).
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

# --- Install trust (user decision 2026-09-30: the app ships unsigned for 0.2) -----------------------
# The first install is checked for damage, not for origin: the installer's SHA-256 must match its
# line in the release SHA256SUMS, both fetched over https from the release. PowerShell 5.1 has no
# Ed25519, so this script cannot verify SHA256SUMS.sig itself; the installed app does, on every
# update (local/capsule/native-win/src/update.rs, the Vyre release key), and refuses anything
# unsigned. Windows will show its "unrecognized app" warning because there is no Authenticode
# signature yet, so the script says the one line the person needs first.

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

    $exeUrl  = "$ReleaseBase/VyreSetup.exe"
    $sumsUrl = "$ReleaseBase/SHA256SUMS"

    $exePath  = Join-Path $Dest "VyreSetup.exe"
    $sumsPath = Join-Path $Dest "SHA256SUMS"

    Invoke-WebRequest -Uri $exeUrl -OutFile $exePath -UseBasicParsing
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing

    $lines = @(Get-Content $sumsPath | Where-Object { $_ -match '^[0-9a-fA-F]{64}\s+\*?VyreSetup\.exe$' })
    if ($lines.Count -ne 1) { throw "SHA256SUMS must list VyreSetup.exe exactly once; refusing to run it." }
    $expected = ($lines[0] -split '\s+')[0]
    Verify-Sha256 -Path $exePath -ExpectedHex $expected

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
Write-Host "About your keys: Sealed data on this PC is only as protected as this PC's own Windows account: any program running as you can read the key file."
Write-Host ""

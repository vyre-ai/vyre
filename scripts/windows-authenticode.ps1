# Authenticode-sign one installer, or leave it unsigned and say which secret is missing.
# The password is passed to signtool and never printed. The timestamp server is fixed.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Status
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Exe)) { throw "no installer at $Exe" }

$names = @("WINDOWS_AUTHENTICODE_PFX_B64", "WINDOWS_AUTHENTICODE_PFX_PASSWORD")
$missing = @()
foreach ($n in $names) {
  $v = [Environment]::GetEnvironmentVariable($n)
  if ([string]::IsNullOrEmpty($v)) {
    Write-Output "skip: $n is not set"
    $missing += $n
  }
}

function Write-Status([string]$signed) {
  $lines = @("signed=$signed")
  foreach ($n in $missing) { $lines += "missing=$n" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash.ToLower()
  $base = Split-Path -Leaf $Exe
  $lines += "sha256:${base}=$hash"
  [System.IO.File]::WriteAllText($Status, ($lines -join "`n") + "`n")
}

if ($missing.Count -gt 0) {
  Write-Status "unsigned"
  exit 0
}

$pfx = Join-Path ([System.IO.Path]::GetTempPath()) ("vyre-" + [guid]::NewGuid().ToString() + ".pfx")
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_AUTHENTICODE_PFX_B64))
  $kits = @(Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
  if ($kits.Count -eq 0) {
    Write-Output "skip: signtool is not on this runner"
    $missing += "signtool"
    Write-Status "unsigned"
    exit 0
  }
  & $kits[0].FullName sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f $pfx /p $env:WINDOWS_AUTHENTICODE_PFX_PASSWORD $Exe
  if ($LASTEXITCODE -ne 0) { throw "signtool exited $LASTEXITCODE" }
  Write-Status "authenticode"
} finally {
  if (Test-Path -LiteralPath $pfx) { Remove-Item -Force -LiteralPath $pfx }
}

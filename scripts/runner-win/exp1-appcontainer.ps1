# Experiment 1: what an AppContainer process can and cannot do. Prints P1..P9 as PASS or FAIL.
$ErrorActionPreference = "Stop"
trap { "ERROR: $_ at line $($_.InvocationInfo.ScriptLineNumber)"; exit 1 }
$src = Get-Content -Raw "C:\vyre-spike\AppContainer.cs"
Add-Type -TypeDefinition $src
$name = "vyre.runner.spike"
$sid = [Vyre]::Sid($name)
"container sid: $sid"
$root = "C:\vyre-spike\run"; Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
$ws = "$root\ws"; New-Item -ItemType Directory -Force $ws | Out-Null
$other = "C:\vyre-spike\other"; New-Item -ItemType Directory -Force $other | Out-Null
"OUTSIDE-SECRET" | Set-Content "$other\secret.txt"
icacls $ws /grant "*${sid}:(OI)(CI)M" | Out-Null
# a loopback listener owned by the parent (the stand-in for the egress proxy)
[Vyre]::Serve(18443)
function Probe($label, $cmd) {
  $out = "$ws\$label.txt"; Remove-Item $out -ErrorAction SilentlyContinue
  $code = [Vyre]::Run($name, "cmd.exe /c `"$cmd > `"$out`" 2>&1`"", $ws, 15000)
  $txt = if (Test-Path $out) { (Get-Content $out -Raw) } else { "(no output file)" }
  [pscustomobject]@{ probe = $label; code = $code; out = ($txt -replace "\s+"," ").Trim().Substring(0, [Math]::Min(140, ($txt -replace "\s+"," ").Trim().Length)) }
}
$r = @()
$r += Probe "P1_write_workspace" "echo hello> $ws\w.txt && type $ws\w.txt"
$r += Probe "P2_read_other_folder" "type $other\secret.txt"
$r += Probe "P3_read_user_profile" "dir C:\Users\vyre\Documents"
$r += Probe "P4_write_outside" "(echo x) > C:\vyre-spike\other\w.txt"
$r += Probe "P5_internet" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://93.184.216.34/"
$r += Probe "P6_loopback_no_exempt" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://127.0.0.1:18443/"
"P4 file exists outside: " + (Test-Path "$other\w.txt")
$r | Format-Table -AutoSize -Wrap | Out-String -Width 200
# loopback exemption (needs admin)
$ex = (& CheckNetIsolation.exe LoopbackExempt -a "-p=$sid" 2>&1) -join " "
"exempt: $ex"
$r2 = @()
$r2 += Probe "P7_loopback_exempt" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://127.0.0.1:18443/"
$r2 += Probe "P8_internet_after_exempt" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://93.184.216.34/"
$r2 += Probe "P9_other_loopback_port" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://127.0.0.1:22/"
New-NetFirewallRule -DisplayName vyre-spike-block -Direction Outbound -Action Block -Package $sid -Protocol TCP -RemoteAddress 127.0.0.1 -RemotePort 1-18442,18444-65535 | Out-Null
$r2 += Probe "P10_other_loopback_after_fw_rule" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://127.0.0.1:22/"
$r2 += Probe "P11_proxy_port_after_fw_rule" "curl.exe -s -m 5 --connect-timeout 3 -o NUL -w %{http_code} http://127.0.0.1:18443/"
Remove-NetFirewallRule -DisplayName vyre-spike-block
$r2 | Format-Table -AutoSize -Wrap | Out-String -Width 200
& CheckNetIsolation.exe LoopbackExempt -d "-p=$sid" | Out-Null
[Vyre]::Delete($name)

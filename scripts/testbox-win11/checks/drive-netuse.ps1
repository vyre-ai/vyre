# Drive over `net use` against a WebDAV server on the testbox (wsgidav on 127.0.0.1:8080, reached from
# the guest at 10.0.2.2). Taildrive's fixed address 100.100.100.100 is put on the LOOPBACK pseudo-interface
# and forwarded with portproxy: never add it to the real adapter, that turns DHCP off and drops the guest
# off the network. Run: g-style, `gf.sh checks/drive-netuse.ps1`.
$ProgressPreference = 'SilentlyContinue'
"--- internet / relay"
try { $r = Invoke-WebRequest https://relay.vyre.run/v1/pair -Method POST -ContentType 'application/json' -Body '{"loc":"AAAA"}' -UseBasicParsing -TimeoutSec 20; "relay status " + $r.StatusCode } catch { "relay: " + $_.Exception.Message + " / " + $_.Exception.Response.StatusCode }
"--- loopback alias for the Taildrive address"
$lo = 'Loopback Pseudo-Interface 1'
if (-not (Get-NetIPAddress -IPAddress 100.100.100.100 -ErrorAction SilentlyContinue)) { New-NetIPAddress -InterfaceAlias $lo -IPAddress 100.100.100.100 -PrefixLength 32 -SkipAsSource $true | Out-Null }
netsh interface portproxy delete v4tov4 listenaddress=100.100.100.100 listenport=8080 2>&1 | Out-Null
netsh interface portproxy add v4tov4 listenaddress=100.100.100.100 listenport=8080 connectaddress=10.0.2.2 connectport=8080
"tcp: " + (Test-NetConnection 100.100.100.100 -Port 8080 -WarningAction SilentlyContinue).TcpTestSucceeded
"webclient: " + (Get-Service WebClient).Status
$unc = '\\100.100.100.100@8080\example.com\vyre\projects'
net use Z: /delete /y 2>&1 | Out-Null
"--- map"
net use Z: $unc /persistent:no 2>&1
"--- dir"
Get-ChildItem Z:\ | Select Name,Length | Format-Table -Auto | Out-String
"--- small"
Get-Content Z:\small.txt
"--- 40MB"
try { $sw=[Diagnostics.Stopwatch]::StartNew(); Copy-Item Z:\forty-mb.bin $env:TEMP\f40.bin -Force -ErrorAction Stop; "ok $((Get-Item $env:TEMP\f40.bin).Length) bytes in $([int]$sw.Elapsed.TotalSeconds)s" } catch { "FAIL 40MB: $($_.Exception.Message)" }
"--- 60MB (default limit 50MB)"
try { Copy-Item Z:\sixty-mb.bin $env:TEMP\f60.bin -Force -ErrorAction Stop; "ok $((Get-Item $env:TEMP\f60.bin).Length) bytes" } catch { "FAIL 60MB: $($_.Exception.Message)" }
$k='HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters'
Set-ItemProperty $k -Name FileSizeLimitInBytes -Value 4294967295 -Type DWord
Restart-Service WebClient
Start-Sleep 3
net use Z: /delete /y 2>&1 | Out-Null
net use Z: '\\100.100.100.100@8080\example.com\vyre\projects' /persistent:no 2>&1
try { $sw=[Diagnostics.Stopwatch]::StartNew(); Copy-Item Z:\sixty-mb.bin $env:TEMP\f60.bin -Force -ErrorAction Stop; "ok 60MB: $((Get-Item $env:TEMP\f60.bin).Length) bytes in $([int]$sw.Elapsed.TotalSeconds)s after FileSizeLimitInBytes" } catch { "FAIL 60MB after raising limit: $($_.Exception.Message)" }
net use Z: /delete /y 2>&1

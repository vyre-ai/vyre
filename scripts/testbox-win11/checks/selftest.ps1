# The app's own real-PC checks (DPAPI round trip, taskbar theme read, tray icons decode, pinned path).
$env:VYRE_SELFTEST = "1"
$t = "$env:USERPROFILE\selftest.txt"
Remove-Item $t -ErrorAction SilentlyContinue
Start-Process "$env:LOCALAPPDATA\Vyre\Vyre.exe" -ArgumentList "--selftest", $t -Wait
Get-Content $t

# The real install script against the release files served from the testbox (http://10.0.2.2:8099).
$ProgressPreference = "SilentlyContinue"
$env:VYRE_RELEASE_BASE = "http://10.0.2.2:8099"
$env:VYRE_CODE = "test-code"
Invoke-WebRequest http://10.0.2.2:8099/install-windows.ps1 -OutFile $env:TEMP\i.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\i.ps1
Get-ChildItem "$env:LOCALAPPDATA\Vyre" | Select Name, Length
schtasks /query /tn Vyre /fo list /v | Select-String "Task To Run|Run As User|Logon Mode|Status"

# Live check of the Windows app on a hosted Windows runner, paired with a throwaway Vyre box that runs on the
# testbox (scripts/testbox-win11/box.mjs) and reached through the hosted relay. Called by
# .github/workflows/windows-live.yml; needs VYRE_INSTALLER (path to the NSIS installer) and, to pair, the
# BOX_SSH_* variables the workflow sets. Writes screenshots and a log to $env:OUT_DIR.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$out = $env:OUT_DIR; New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out "live.log"
function Scrub($t) { foreach ($v in $env:BOX_SSH_HOST, $env:BOX_SSH_USER) { if ($v) { $t = $t.Replace($v, "***") } }; $t }
function Say($m) { $l = Scrub ("{0:HH:mm:ss} {1}" -f (Get-Date), $m); Write-Host $l; Add-Content $log $l }
function Result($name, $ok, $detail) { Say ("{0,-5} {1}: {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail); Add-Content (Join-Path $out "results.txt") ("{0} {1} {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail) }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot($name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $out "$name.png")); $g.Dispose(); $bmp.Dispose()
    Say "screenshot $name ($($b.Width)x$($b.Height))"
  } catch { Say "screenshot $name failed: $_" }
}

# ---- Chrome DevTools helpers: the app's WebView2 exposes a debug port in this run only --------------------
# Unrolled one target at a time: Invoke-RestMethod hands back a JSON array as ONE object, which made two open pages look like one page with array-valued fields.
function Pages { try { $r = Invoke-RestMethod http://127.0.0.1:9222/json -TimeoutSec 5; foreach ($x in $r) { $x } } catch { } }
function PageLike($pat) { Pages | Where-Object { $_.type -eq "page" -and $_.url -like $pat } | Select-Object -First 1 }
function Cdp($page, $expr) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  try { $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait() } catch { Say ("cdp: connect to {0} failed: {1}" -f $page.webSocketDebuggerUrl, $_.Exception.InnerException.Message) }
  $msg = @{ id = 1; method = "Runtime.evaluate"; params = @{ expression = $expr; returnByValue = $true; awaitPromise = $true } } | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]$bytes, "Text", $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 262144; $res = $null; $seen = @()
  $cts = New-Object System.Threading.CancellationTokenSource 15000
  try {
    for ($i = 0; $i -lt 40 -and -not $res; $i++) {
      $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $cts.Token).Result
      $s = [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
      if ($s -match '"id":1[,}]') { $res = $s } else { $seen += $s.Substring(0, [Math]::Min(120, $s.Length)) }
    }
  } catch { $seen += "receive: $($_.Exception.Message)" }
  if (-not $res -and $seen) { Say ("cdp: saw " + ($seen -join " || ")) }
  $ws.Dispose()
  if (-not $res) { Say "cdp: no answer for: $expr"; return $null }
  $j = $res | ConvertFrom-Json
  if ($j.result.exceptionDetails -or $j.error) { Say ("cdp: error for '{0}': {1}" -f $expr, ($res.Substring(0, [Math]::Min(300, $res.Length)))) }
  $j.result.result.value
}
function WaitPage($pat, $secs) { $end = (Get-Date).AddSeconds($secs); while ((Get-Date) -lt $end) { $p = PageLike $pat; if ($p) { return $p }; Start-Sleep 2 }; return $null }

# Fallback when DevTools gives no answer for a window: press a button by its visible name through UI Automation.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function UiaPress($name) {
  $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $name
  $found = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  Say "uia: $($found.Count) element(s) named '$name'"
  foreach ($e in $found) {
    try { ($e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); Say "uia: pressed '$name'"; return $true } catch { Say "uia: could not invoke: $($_.Exception.Message)" }
  }
  $false
}

# ---- 1. install with the real install script, from a local release ------------------------------------
$rel = Join-Path $env:RUNNER_TEMP "rel"; New-Item -ItemType Directory -Force -Path $rel | Out-Null
Copy-Item $env:VYRE_INSTALLER (Join-Path $rel "VyreSetup.exe")
$hash = (Get-FileHash (Join-Path $rel "VyreSetup.exe") -Algorithm SHA256).Hash.ToLower()
Set-Content (Join-Path $rel "SHA256SUMS") "$hash  VyreSetup.exe" -Encoding ASCII -NoNewline:$false
# The install script verifies the release signature: sign the local list with a throwaway key and hand the script
# that key through its test seam (the real key's private half is never here).
$signer = @'
const c = require("crypto"), fs = require("fs");
const dir = process.argv[1];
const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
const sums = fs.readFileSync(dir + "/SHA256SUMS");
fs.writeFileSync(dir + "/SHA256SUMS.sig", c.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), privateKey).toString("base64") + "\n");
process.stdout.write(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
'@
$env:VYRE_RELEASE_KEY = (node -e $signer $rel)
Result "release-signature-fixture" ($env:VYRE_RELEASE_KEY.Length -eq 60) "throwaway key and SHA256SUMS.sig made"
$srv = Start-Process python -ArgumentList "-m", "http.server", "8099", "--bind", "127.0.0.1", "-d", $rel -PassThru -WindowStyle Hidden
Start-Sleep 3
$env:VYRE_RELEASE_BASE = "http://127.0.0.1:8099"; $env:VYRE_CODE = "live-check"
$sw = [Diagnostics.Stopwatch]::StartNew()
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "..\install-windows.ps1") 2>&1 | ForEach-Object { Say "install: $_" }
$exe = Join-Path $env:LOCALAPPDATA "Vyre\Vyre.exe"
Result "install-script" (Test-Path $exe) "installed in $([int]$sw.Elapsed.TotalSeconds)s, Vyre.exe $((Get-Item $exe -ErrorAction SilentlyContinue).Length) bytes"
$task = schtasks /query /tn Vyre /fo list /v 2>&1 | Out-String
Result "autostart-task" ($task -match "Interactive only" -and $task -match "Vyre.exe") "ONLOGON task registered"
function KillApp { Stop-Process -Name Vyre -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgewebview2 -Force -ErrorAction SilentlyContinue; Start-Sleep 4 }
# The first launch (by the install script) leaves WebView2 processes on the app's data folder; a relaunch with new
# browser arguments would join them and get no debug port.
KillApp

# ---- 2. the app's own selftest (DPAPI, theme read, icons, live update check) ----------------------------
$env:VYRE_SELFTEST = "1"
$st = Join-Path $out "selftest.txt"
Start-Process $exe -ArgumentList "--selftest", $st -Wait
$env:VYRE_SELFTEST = $null
$stText = if (Test-Path $st) { Get-Content $st -Raw } else { "no output" }
Say "selftest:`n$stText"
foreach ($line in ($stText -split "`n" | Where-Object { $_ })) { Result ("selftest " + ($line -split " ")[1]) ($line.StartsWith("pass")) $line }

# ---- 3. launch for real, drive it through its debug port ------------------------------------------------
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-gpu --remote-debugging-port=9222"
# The environment variable was ignored by this runner's WebView2 (153): set the policy too (the documented machine-wide way).
$pol = "HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
New-Item -Path $pol -Force | Out-Null
New-ItemProperty -Path $pol -Name "Vyre.exe" -Value "--disable-gpu --remote-debugging-port=9222" -PropertyType String -Force | Out-Null
Remove-Item "$env:APPDATA\run.vyre.app\pairing.json", "$env:APPDATA\run.vyre.app\device.key" -ErrorAction SilentlyContinue
$app = Start-Process $exe -PassThru
$first = WaitPage "*first-run.html*" 90
if (-not $first) { Say "debug port answered: $((Pages | Measure-Object).Count) pages; app running: $([bool](Get-Process Vyre -ErrorAction SilentlyContinue)); webview2 procs: $((Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Measure-Object).Count)"; $cl = (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*run.vyre.app*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).CommandLine; Set-Content (Join-Path $out "webview2-cmdline.txt") $cl; Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Vyre|msedgewebview2' -and ($_.Name -eq 'Vyre.exe' -or $_.CommandLine -notlike '*--type=*') } | ForEach-Object { Say ("proc {0} pid {1} parent {2} created {3} cmd {4}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.CreationDate, ($_.CommandLine -replace '\s+', ' ').Substring(0, [Math]::Min(400, $_.CommandLine.Length))) }
  Say "env var in this script: $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
  Say "webview2 has the debug flag: $($cl -match 'remote-debugging-port')"
  try { Say ("raw /json: " + (Invoke-WebRequest http://127.0.0.1:9222/json -UseBasicParsing -TimeoutSec 5).Content.Substring(0, 300)) } catch { Say "raw /json failed: $_" }
  Say ("listening: " + ((netstat -ano | Select-String ":9222") -join " | ")) }
Result "first-run-page" ($null -ne $first) $(if ($first) { "title '$($first.title)'" } else { "no first-run page" })
Start-Sleep 3; Shot "01-first-run"
$wsize = Cdp $first "window.outerWidth + 'x' + window.outerHeight"
Say "first-run window size $wsize"

if ($first) {
  Cdp $first "document.getElementById('pair').click(); 1" | Out-Null
  $words = $null
  for ($i = 0; $i -lt 30 -and -not $words; $i++) {
    Start-Sleep 2
    $w = Cdp $first "Array.from(document.querySelectorAll('#seedbox li')).map(x => x.textContent).join(' ')"
    if ($w -and ($w -split " ").Count -eq 13) { $words = $w }
  }
  Result "pair-code-words" ([bool]$words) $(if ($words) { "13 words and a QR shown" } else { "no words" })
  Shot "02-pair-code"
  $qr = Cdp $first "document.querySelector('#seedbox svg') ? 'svg ' + document.querySelectorAll('#seedbox svg path').length : 'no qr'"
  Say "qr: $qr"

  # ---- 4. hand the words to the throwaway box (a key restricted to writing words.txt) ----------------------
  if ($words -and $env:BOX_SSH_KEY) {
    $key = Join-Path $env:RUNNER_TEMP "box_key"; [IO.File]::WriteAllText($key, (($env:BOX_SSH_KEY -replace "`r", "").Trim() + "`n"))
    icacls $key /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
    $kh = Join-Path $env:RUNNER_TEMP "known_hosts"; Set-Content $kh $env:BOX_SSH_HOSTKEY -Encoding ASCII
    $words | & ssh -i $key -o UserKnownHostsFile=$kh -o StrictHostKeyChecking=yes -o ConnectTimeout=20 "$($env:BOX_SSH_USER)@$($env:BOX_SSH_HOST)" 2>&1 | ForEach-Object { Say "ssh: $_" }
    Result "words-to-box" ($LASTEXITCODE -eq 0) "ssh exit $LASTEXITCODE"
  } else { Say "no BOX_SSH_KEY: not pairing" }

  # ---- 5. the confirm window appears once the app resolves the ticket at the relay -----------------------
  $confirm = WaitPage "*confirm.html*" 120
  if (-not $confirm) { Say ("first-run page state: err='{0}' status='{1}'" -f (Cdp $first "document.getElementById('err').textContent"), (Cdp $first "document.getElementById('seed').textContent")) }
  Result "confirm-window" ($null -ne $confirm) $(if ($confirm) { "appeared" } else { "no confirm window in 120 s" })
  if ($confirm) {
    Say ("pages now: " + ((Pages | ForEach-Object { "$($_.type) $($_.url) $($_.id)" }) -join " ; "))
    Say ("cdp 1+1 on confirm: " + (Cdp $confirm "1+1"))
    $detail = $null
    for ($i = 0; $i -lt 3 -and -not $detail; $i++) { Start-Sleep 2; $d = Cdp $confirm "document.getElementById('detail').textContent"; if ($d) { $detail = (Cdp $confirm "document.getElementById('title').textContent") + " | " + $d } }
    Say "confirm shows: $detail"
    Result "confirm-shows-host" ($detail -match "vyre-lab.invalid" -and $detail -match "not on vyre.run") $detail
    Shot "03-confirm"
    # Press Pair; if the window is still there a few seconds later, press again (the click can land before the page is ready).
    for ($i = 0; $i -lt 6; $i++) {
      $r = Cdp $confirm "document.getElementById('yes').click(); 'clicked'"
      if (-not $r) { UiaPress "Pair" | Out-Null }
      Start-Sleep 5
      if (-not (PageLike "*confirm.html*")) { Say "confirm window closed after the click"; break }
    }
    # finish_pair writes the record with the link
    $rec = "$env:APPDATA\run.vyre.app\pairing.json"
    $end = (Get-Date).AddSeconds(150); $paired = $false
    while ((Get-Date) -lt $end -and -not $paired) { Start-Sleep 3; if (Test-Path $rec) { $j = Get-Content $rec -Raw | ConvertFrom-Json; if ($j.link) { $paired = $true } } }
    if (-not $paired) { Say ("first-run page state after Pair: err='{0}' status='{1}'" -f (Cdp $first "document.getElementById('err').textContent"), (Cdp $first "document.getElementById('seed').textContent")) }
    Result "finish-pair" $paired $(if ($paired) { "pinned $($j.address), link route $($j.link.route.Substring(0,6))..., device $($j.link.device)" } else { "no pairing record with a link" })
    Shot "04-after-pair"
    Say ("after pair: Vyre running={0}; pages: {1}" -f [bool](Get-Process Vyre -ErrorAction SilentlyContinue), ((Pages | ForEach-Object { $_.url }) -join ", "))
    try { Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = (Get-Date).AddMinutes(-15) } -MaxEvents 40 -ErrorAction Stop | Where-Object { $_.Message -match "Vyre" } | Select-Object -First 4 | ForEach-Object { Say ("eventlog: {0} {1}" -f $_.ProviderName, ($_.Message -replace "\s+", " ").Substring(0, [Math]::Min(300, $_.Message.Length))) } } catch { Say "no event log entries for Vyre" }

    # ---- 6. the link window: tray's "Open Vyre Drive" is the same event --------------------------------------
    $link = WaitPage "*link.html*" 60
    Result "link-window" ($null -ne $link) $(if ($link) { "hidden bundled page is running" } else { "no link window" })
    if ($link) {
      Start-Sleep 20   # give it time to dial the box through the relay
      Cdp $link "window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', { target: { kind: 'Window', label: 'link' }, event: 'vyre-drive', payload: null }).then(() => 'emitted')" | Out-Null
      Start-Sleep 45
      $nu = net use 2>&1 | Out-String
      Say "net use:`n$nu"
      $wc = Get-Service WebClient -ErrorAction SilentlyContinue
      Say "WebClient service: $(if ($wc) { $wc.Status } else { 'not installed' })"
      Result "drive-letter" ($nu -match "100\.100\.100\.100@8080") $(if ($nu -match "100\.100\.100\.100@8080") { "mapped" } else { "not mapped (a hosted runner has no WebDAV client; the box call is checked on the box side)" })
      Shot "05-after-drive"
    }
  }

  # ---- 7. the global hotkey -----------------------------------------------------------------------------------
  [System.Windows.Forms.SendKeys]::SendWait("% ")
  Start-Sleep 6
  $main = PageLike "*vyre-lab.invalid*"
  $anyMain = Pages | Where-Object { $_.type -eq "page" } | ForEach-Object { $_.url }
  Say "pages after Alt+Space: $($anyMain -join ', ')"
  Result "hotkey-alt-space" ($null -ne $main) $(if ($main) { "panel window opened at $($main.url)" } else { "no panel window (key injection may not reach a hosted session)" })
  Shot "06-hotkey"
}
Stop-Process -Name Vyre -Force -ErrorAction SilentlyContinue
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
$res = Get-Content (Join-Path $out "results.txt") -ErrorAction SilentlyContinue
"## windows-live results`n" + ($res -join "`n") | Add-Content $env:GITHUB_STEP_SUMMARY

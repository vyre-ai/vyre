# The join proof on the Win11 VM (interactive session, started by scripts/testbox-win11/join-live.sh): the real app, built with
# --features selftest, pairs through the real relay with a throwaway box (box.mjs with BOX_REAL_PRESENCE=1, this tree's link module), then the
# local helper joins that box as a companion: the page's import calls start the helper, the helper asks the app over the app pipe, the app
# builds link.companion.pair and its ES256 proof, the hidden link page makes the call as a person over the relay, and the helper keeps the
# answer. Writes C:\Users\vyre\join.txt as it goes. Not a product script: nothing here ships.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$out = "C:\Users\vyre\join.txt"
Remove-Item $out -ErrorAction SilentlyContinue
function Say($m) { Add-Content $out ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
function Result($name, $ok, $detail) { Say ("{0,-5} {1}: {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail) }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot($name) { try { $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save("C:\Users\vyre\join-$name.png"); $g.Dispose(); $bmp.Dispose() } catch { } }
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

$inst = "C:\vtest\Vyre_setup.exe"
$exe = Join-Path $env:LOCALAPPDATA "Vyre\Vyre.exe"
function KillApp { Stop-Process -Name Vyre -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgewebview2 -Force -ErrorAction SilentlyContinue; Stop-Process -Name node -Force -ErrorAction SilentlyContinue; Start-Sleep 4 }
KillApp
schtasks /Delete /TN Vyre /F 2>$null | Out-Null
Remove-Item "$env:LOCALAPPDATA\Vyre", "$env:LOCALAPPDATA\run.vyre.app", "$env:APPDATA\run.vyre.app", "$env:USERPROFILE\.vyre", "$env:USERPROFILE\.claude" -Recurse -Force -ErrorAction SilentlyContinue
Start-Process $inst -ArgumentList "/S" -Wait
foreach ($f in "WebView2Loader.dll","libwinpthread-1.dll","libgcc_s_seh-1.dll") { Copy-Item "C:\vtest\$f" "$env:LOCALAPPDATA\Vyre\" -Force }
Result "installed" (Test-Path $exe) $exe
$proj = "$env:USERPROFILE\.claude\projects\C--Work-demo"; New-Item -ItemType Directory -Force $proj | Out-Null
Set-Content "$proj\11111111-1111-4111-8111-111111111111.jsonl" '{"type":"user","cwd":"C:\\Work\\demo","message":{"role":"user","content":"hi"}}' -Encoding ASCII

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-gpu --remote-debugging-port=9222"
$env:VYRE_TEST_CORE_PKG = "C:\vtest\vyre.tgz"; $env:VYRE_TEST_NODE_ZIP = "C:\vtest\node.zip"; $env:VYRE_TEST_OPEN_HISTORY = "1"
Remove-Item "C:\Users\vyre\words.txt" -ErrorAction SilentlyContinue
$app = Start-Process $exe -PassThru
$first = WaitPage "*first-run.html*" 90
Result "first-run-page" ($null -ne $first) "title '$($first.title)'"
if (-not $first) { exit 1 }
Start-Sleep 3
Cdp $first "document.getElementById('pair').click(); 1" | Out-Null
$words = $null
for ($i = 0; $i -lt 30 -and -not $words; $i++) { Start-Sleep 2; $w = Cdp $first "Array.from(document.querySelectorAll('#seedbox li')).map(x => x.textContent).join(' ')"; if ($w -and ($w -split " ").Count -eq 13) { $words = $w } }
Result "pair-code-words" ([bool]$words) "13 words shown"
if (-not $words) { exit 1 }
Set-Content "C:\Users\vyre\words.txt" $words -Encoding ASCII   # the orchestrator on the test box carries it to the box
$confirm = WaitPage "*confirm.html*" 150
Result "confirm-window" ($null -ne $confirm) "appears once the box minted the ticket"
if (-not $confirm) { exit 1 }
Shot "01-confirm"
for ($i = 0; $i -lt 6; $i++) { $r = Cdp $confirm "document.getElementById('yes').click(); 'clicked'"; if (-not $r) { UiaPress "Pair" | Out-Null }; Start-Sleep 5; if (-not (PageLike "*confirm.html*")) { break } }
$rec = "$env:APPDATA\run.vyre.app\pairing.json"
$end = (Get-Date).AddSeconds(150); $paired = $false
while ((Get-Date) -lt $end -and -not $paired) { Start-Sleep 3; if (Test-Path $rec) { $j = Get-Content $rec -Raw | ConvertFrom-Json; if ($j.link) { $paired = $true } } }
Result "paired" $paired "device $($j.link.device), presence $(($j.link.presence | ConvertTo-Json -Compress))"
Result "presence-key-enrolled" ($j.link.presence.enrolled -eq $true) "the box took the app's presence key at pairing"
if (-not $paired) { exit 1 }

$hist = WaitPage "*history.html*" 60
Result "import-screen" ($null -ne $hist) "opened after pairing"
Start-Sleep 25   # the hidden link window dials the box through the relay
Shot "02-import-screen"
$js = @'
window.__r = "running"; (async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const log = [];
  try { await inv("core_ensure"); log.push("helper up"); } catch (e) { return "ensure failed: " + e; }
  let sc; try { sc = await inv("core_call", { tool: "import.scan", input: {} }); } catch (e) { return "scan failed: " + e; }
  const folders = sc.sources.flatMap(s => s.folders.map(f => f.cwd)).filter(Boolean);
  log.push("scan found " + sc.sources.reduce((a, s) => a + s.sessions, 0) + " session(s)");
  let pl; try { pl = await inv("core_call", { tool: "import.plan", input: { include: folders } }); } catch (e) { return log.join("; ") + "; plan failed: " + e; }
  try { await inv("core_call", { tool: "import.start", input: { plan: pl.plan, mode: "once", pace: "gentle" } }); log.push("start accepted"); } catch (e) { log.push("start said: " + e); }
  return log.join("; ");
})().then(v => { window.__r = v; }); "started"
'@
$r = $null
if ($hist) { Cdp $hist ($js -replace "`r`n", " ") | Out-Null }
# The calls take a while (a download-free install, the helper's start, the join over the relay): ask for the answer until it is there.
for ($i = 0; $i -lt 40; $i++) { Start-Sleep 3; $r = Cdp $hist "window.__r"; if ($r -and $r -ne "running") { break } }
Say "import calls: $r"
$cj = "$env:USERPROFILE\.vyre\companion.json"
$joined = Test-Path $cj
if ($joined) { $c = Get-Content $cj -Raw | ConvertFrom-Json; Result "helper-joined" $true "companion $($c.companion), box id $($c.box.id.Substring(0,8))..., key sealed $($c.key.sealed.Length) chars, no PEM: $(-not (($c | ConvertTo-Json) -match 'BEGIN'))" } else { Result "helper-joined" $false "no companion.json; the import call said: $r" }
Shot "03-after-join"
KillApp
Say "done"

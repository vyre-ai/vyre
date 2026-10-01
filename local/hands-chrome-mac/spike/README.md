# Chrome spike and bench

Proof harness for deep Chrome control (ADR 0049). Runs only on a throwaway GitHub runner: it
launches Chrome for Testing and registers a native-messaging host. Never run it on a person's machine.

## Run it

```
git push origin work/capsule-sight     # the path filter starts it
gh workflow run chrome-spike.yml --ref work/capsule-sight
gh run watch                            # then: gh run download <id>
```

`workflow_dispatch` only works once the workflow file is on the default branch; until then the push
trigger (paths: spike/**, bench/**, the workflow) is the way in. Matrix: macos-latest, windows-latest,
ubuntu-latest (control). Results land in each job's step summary and in the `chrome-spike-<os>` artifact
(`spike-<os>.json`, `bench-<os>.json`, plus `spike-diag-<os>.json` if the first run failed).

## What the spike proves

`harness/run.mjs` launches Chrome for Testing (`npx @puppeteer/browsers install chrome@stable`) with
`--headless=new --load-extension --disable-extensions-except`, a temp `--user-data-dir`, against a fixture
page on 127.0.0.1, with the spike extension (`extension/`) and host (`host/host.js`, a byte pipe).
Stages, each recorded ok or failed with timings:

| stage | proves |
|---|---|
| `ipc_server` | unix socket (mac/linux) or named pipe (Windows) listens |
| `host_loopback` | host relay alone, no Chrome: p50/p95 of stdio to socket and back |
| `sw_hello` | the extension worker started in headless AND `connectNative` reached the registered host AND the host reached the socket |
| `tab_present` | the fixture tab exists in the profile |
| `attach` | one `chrome.debugger` attach: first, then 10 detach/attach cycles (host round trip, and time inside the worker, with and without `Runtime.enable`) |
| `eval` | `Runtime.evaluate` through the debugger returns the right answer (12 form controls) |
| `ping_latency` | 200 sequential socket to host to extension and back (no debugger) |
| `eval_latency` | 200 sequential round trips that also do a `Runtime.evaluate` |

Registration: macOS and Linux write `<user-data-dir>/NativeMessagingHosts/run.vyre.chrome.json`; Windows
uses `reg add` under HKCU for Google\Chrome, Google\Chrome for Testing and Chromium (a throwaway runner, so
all three; the JSON does not say which one Chrome for Testing read).

## What to look for

- `sw_hello.ok` true on all three OS: headless new mode runs the MV3 service worker and native messaging.
  `sw_hello.headlessUa` shows the worker really ran under HeadlessChrome. If false, the run has a
  `diag` block (chrome log tail; with `--diag` the worker's own log and the target list).
- `attach.hostRoundTrip.p50` and `ping_latency` / `eval_latency` p50/p95: the per-call floor of the design.
  `host_loopback` minus those isolates Chrome's native-messaging cost from the socket hop.
- `eval.ok`: chrome.debugger works on a normal http tab in this Chrome.
- Windows: `sw_hello` passing means the named pipe and the `.bat` wrapper work end to end.

## Not testable here

Chrome's "started debugging this browser" bar and the developer-extensions bar are UI of a headed
window. Headless new mode has none, so the spike cannot show them; the ADR treats both as unhideable and
the install screen says so. Headed mode under Xvfb is possible later (`--headless false` on Linux) but
proves nothing about the bar's behaviour on macOS or Windows.

If `--load-extension` were refused by a future Chrome for Testing build, `sw_hello` fails with no hello
and `--diag` shows no service-worker target. That is the finding to report, not a harness bug.

## Pointing it at the real thing

```
node harness/run.mjs --extension ../extension --host ../native-host --profile real
```

The harness copies the extension to a temp dir and injects a key only if its manifest has none, so the
id (and the host manifest's `allowed_origins`) match. `--host <dir>` needs a `host.js`; the harness writes
a wrapper that sets `VYRE_CHROME_SOCK` (the socket the harness listens on) and `VYRE_HOME`, so the real
host must read the socket path from `VYRE_CHROME_SOCK` when set. `--profile real` measures `tabs.list`
and `page.eval` in place of the spike's ping and eval.

## The bench

`bench/chrome-bench.mjs --direct-cdp [--iters 30] [--out file]` measures p50/p95 of: `page.snapshot`,
`page.fill` of 12 fields, `page.act` click (trusted mouse events), `tabs.use` reuse against `tabs.open`,
`tabs.attach`, a 20-step workflow as 20 separate calls against one `batch.run`, `net.list`, and the
API-learning path (`api.learn`, `api.call`) on a GoHighLevel-shaped fixture with a bearer header plus a
session cookie. Fixtures are `bench/fixtures/` (`server.mjs` serves them on 127.0.0.1). Each scenario also
checks the page really changed (12 fields set, clicks counted, workflow saved with 3 actions, catalog
holds `GET /api/contacts [bearer+cookie]`, `api.call` returns 200); a failed check shows under `errors`.

Direct-CDP notes for reading the numbers: `net.list` reads an in-process buffer (no round trip), so in
extension mode it gains one host hop. The batch is one `Runtime.evaluate` with in-page clicks, standing
in for the worker-side batch; the 20-call version uses trusted mouse events per click, as `page.act` would.
`--extension --bridge <module>` (module exports `connect(opts)` returning `{call(op, args), close()}`)
runs the same scenarios through the module bridge once it lands; `bench/extension-driver.mjs` documents
the assumed `batch.run` step shape.

Local checks (no Chrome): `node --test local/hands-chrome-mac/spike-*.test.js`.

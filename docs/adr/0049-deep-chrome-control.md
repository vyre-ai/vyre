---
title: "ADR 0049: Deep Chrome control"
summary: One first-party Vyre extension using chrome.debugger, a native-messaging host and a module in vyred give agents fast, redacted, floor-checked control of the person's own Chrome, with the plan shown first and Esc to stop.
audience: builders
owner: capsule-sight
status: stable
---

# 0049: Deep Chrome control

Status: accepted for 0.2 (capsule-sight). Supersedes the "out of 0.2" note in ADR 0015.

## Decision

The person's own Chrome is driven through ONE first-party Vyre extension using `chrome.debugger`,
a native-messaging host, and a module in vyred. No debugging port, no browser relaunch. The
extension loads unpacked in 0.2 (the Store listing is 0.3) and Vyre updates it by replacing files
and asking it to reload.

```
agent/CLI --tool--> module chrome (local/hands-chrome-mac/index.js, in vyred)
                      floor (URL tier) . oversight (plan, interject, Esc) . redact
                      |  unix socket / named pipe, framed JSON (shared/proto.js)
                    native host (native-host/host.js, spawned by Chrome, relays, reads nothing)
                      |  Chrome native messaging (stdio, 4-byte length frames)
                    extension service worker (extension/background.js = the shell)
                      caps/tabs  caps/page  caps/devtools  caps/net  caps/api  caps/ghl  caps/batch
                      (vault's fill, save and API-key capture register here as caps/vault.js)
                      |  chrome.debugger (CDP), one attach per tab, kept
                    the person's tabs
```

## One extension, capabilities as modules

`extension/background.js` is the shell: it connects to the host, authenticates the tab floor,
dispatches `{id, op, args}` to the capability that registered `op`, redacts the result
(`shared/redact.js`), and answers. A capability is a file in `extension/caps/` that default-exports
`{ name, ops: { "<cap>.<name>": async (args, ctx) => result }, onEvent?(evt, ctx) }` and is listed in
`extension/caps/index.js`. `ctx` gives `ctx.cdp` (attach/send/on), `ctx.tabs`, `ctx.emit(event)`,
`ctx.stopped()` (true while the person's stop is in force) and `ctx.floorAllows(tabId, op)`. The vault
team adds `caps/vault.js` the same way. Nothing else in the extension is theirs or mine to
special-case.

## Speed (a measured number, not a claim)

Per-call cost is one host round trip. So:

- One `chrome.debugger` attach per tab, kept until the tab closes or the person detaches.
- `page.snapshot` is one `Runtime.evaluate`. `page.fill` sets every field in one evaluate.
- `batch.run` takes a list of steps and runs them inside the service worker with no host hop
  between steps. It halts at the first failure, on stop, or on a floor refusal, and says which step.
- `net.*` reads a ring buffer the extension keeps; no round trip per event.
- Tabs are reused (see tabs): opening a tab costs 200 ms to 2 s and steals attention.

`scripts/chrome-bench.mjs` measures per-op latency against a fixture page and a GoHighLevel-shaped
fixture, and prints p50/p95. The number in the work doc comes from a GitHub runner, not a guess.

## Tabs: reuse, never open needless ones

`tabs.use {match?: {url?, origin?, title?}, url?, openIfMissing?}` finds an existing tab in the
person's windows first (exact URL, then same origin and path prefix, then same origin), activates
nothing unless `focus: true`, and only opens a tab when none matches and `url` is given. A tab Vyre
opened is remembered and is the only kind `tabs.close` may close.

## DevTools

- inspect: DOM (outerHTML, attributes, box model), computed styles, matched CSS rules, event listeners.
- source: `Debugger.scriptParsed` list, script source by id, search across scripts, source maps' names.
- console: ring buffer of `Runtime.consoleAPICalled`, exceptions, `Log.entryAdded`, and eval.
- network: `Network.*` ring buffer (bounded by count and bytes), live watch, response bodies on
  demand, and acting on events: `net.on {filter, then}` (block, mock, modify headers, wait then run
  a step) through the `Fetch` domain. `net.replay` re-issues a captured request from inside the page,
  so the page's own cookies authenticate it and no credential leaves the browser.
- learn an app's API: `api.learn` reduces captured XHR/fetch traffic to a catalog (method, path
  template, query/body shape, auth kind, sample status) with values redacted; `api.call` invokes a
  catalog entry from inside the page.

## Redaction

Cookies, tokens, session ids, CSRF tokens, API keys and passwords are removed before the model sees
them (`shared/redact.js`): names and lengths stay, values never. It runs in the extension on every
result and again in the module on arrival. There is no argument that asks for a raw value.

## Floor and Gate

The URL tier (`floor-url.js`): `blind` origins (bank, password-manager web vaults, Vyre's own
surfaces, `chrome://`, the Web Store) return nothing and refuse every op; `hands`-only origins are
readable but not actable. The module classifies before sending and the extension re-checks in the
worker. An outward act (a real `type=submit`, a form post, a Send/Pay/Post control decided from the
DOM, not a label) the person's own turn asked for runs free; otherwise it is a Gate card of kind `act`
with the field values shown, released only if the page signature is unchanged.

## Oversight

`oversight.js` is the logic behind the panel (capsule-pro draws it): the agent posts its plan first
(`chrome.plan`), the person can interject by prompt or voice (`chrome.interject`), and Esc stops and
waits (`chrome.stop`); nothing continues until `chrome.resume` after the person answers. The
extension's `ctx.stopped()` reads the same flag, pushed as a `stop` event, so an in-flight batch
halts within one step.

## Native host and install

`native-host/host.js` is spawned by Chrome as `run.vyre.chrome`, relays frames between stdio and the
module's socket (`<VYRE_HOME>/run/chrome.sock`, mode 0600; a named pipe on Windows), and exits when
either side closes. `native-host/install.js` writes the host manifest (macOS
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, other Chromium browsers beside
it; Windows `HKCU\Software\Google\Chrome\NativeMessagingHosts\run.vyre.chrome`), pinning
`allowed_origins` to the extension id derived from the manifest `key`.

## Known limits

- Chrome shows its own "started debugging this browser" bar while attached and, in load-unpacked
  mode, a developer-extensions bar on every start. Neither can be hidden; the guided install screen
  says so.
- GoHighLevel selectors and internal API shapes are only verifiable against a live account. The
  fixture proves the machinery and the speed; a live run by the person is the acceptance check.

## Hardening after review (reviewer-2, 30 Sep)

- A page chooses the names in the URLs, bodies and console lines Vyre reads, so redaction never
  throws (`safeDecode`, `guarded`), the bridge drops a bad frame and keeps serving, and a redaction
  failure masks the whole field.
- `chrome.release` replays only the record the module itself stored under the Gate's id, after
  re-checking the causing agent's grant. The card carries only what the person reads.
- After the one-time grant, scripts, API reads and writes, replays and GoHighLevel runs are
  hands-free. The Gate holds only what the no-nag list holds: a request whose effect is to SEND
  something as the person (a message, an email, a post, a payment) that nobody asked for and no
  standing permission covers. It is judged by method and endpoint (`extension/shared/outbound.js`,
  which knows GoHighLevel's conversation, campaign, invoice, payment and social-posting endpoints, and
  reads a GraphQL mutation's name). Tagging a contact, saving a workflow or reading is never held.
  `api.call` and `net.replay` are judged before they run. A script's own `fetch`, XHR and
  `sendBeacon` sends are held back and reported while the rest of the script runs (a shim installed
  around the evaluation, not a wrapper around the script, so a page's CSP cannot break it); the held
  card is released by re-running with `asked`. The person's own turn (`asked`) runs everything free.
  A page with a visible password field is still not one `page.eval` runs on, because that rule is
  invisible.
- One floor list (`extension/shared/floor.js`) is imported by the module and the extension.
- The network buffer is judged per record and emptied when a tab navigates to a blind page.
  Not yet done: the console and script rings are not emptied on such a navigation (scripts are
  filtered by URL when listed).
- Only the extension the host says launched it (Chrome passes its origin, pinned to the manifest
  key's id) can be "the extension". A replacement connection is announced with a `replaced` event.
- Accepted: the manifest key is public, so anyone can build an unpacked extension with the same id.
  Reaching the host that way needs the person's own Chrome profile.
- Not done: naming `chrome.sock` in the floor's rule that denies a shell from talking to vyred's sockets.

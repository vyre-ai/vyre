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

## Frames

A tab is not one document. GoHighLevel's whole Workflows UI is a cross-origin iframe in its own process, so a page tool that only sees the top frame sees only the shell's nav (a real first session failed exactly this way). Frames are first-class in every page tool.

- What is reachable. `lib/cdp.js` keeps the child sessions Chrome hands over (cross-origin iframes, nested ones too) and `lib/frames.js` lists every frame in tree order. A frame is readable when a script can run in it: its own session, or its own execution context when it shares the top page's process. `page.snapshot`, `page.act`, `page.fill`, `page.wait` and `page.eval` (and `batch.run` and the `ghl` ops on top of them) look in all readable frames, top first.
- Snapshot. The snapshot script runs in every readable frame and the results merge into one. With more than one frame every control carries `frame` (its index in the frame list) and `frameOrigin`, and its `path` is the path inside that frame, so a control is identified by (frame, path). `frames` lists each frame (index, parent, depth, origin, url without its query, readable, control count). The `limit` is split across frames with a floor per frame, and inside a frame the main content, dialogs and drawers come before navigation and header chrome. The page's own bounding box of a control is `box` (it was called `frame` before frames existed).
- Selectors. A selector may carry `frame`: an index, a frame id, `top`, or a piece of an origin or URL. Without it the search covers every frame and the usual rule holds: two matches are tied, unless exactly one sits inside an open dialog or drawer, which wins. A tie between frames says which frames in `candidates` and `tiedFrames`. A snapshot control's selector includes its frame, so it can be copied as it is.
- Acting. Scripts that find, fill or focus a control run in the control's own frame. A click is located inside the frame, moved by the frame's offset in the top viewport (`ctx.frames.offset`) and dispatched on the top page's session, which is where Chrome routes input into an iframe. The hit test stays inside the frame. Keys focus the element in its frame and go out on the top session. `page.fill` runs one script per frame. A frame is looked up again by its index and origin on every act, since a frame gets a new id when it navigates; a frame that is gone is a stale control and is retried inside the existing retry budget.
- Waiting. Every poll lists the frames again, so a frame that appears late or navigates mid-wait is picked up. Settled means no spinner, a quiet DOM and a quiet network in every readable frame. Dialogs are per frame: a dialog in the shell is in front of every frame, a dialog in a frame is in front of that frame and the frames inside it.
- `page.eval` takes an optional `frame` and runs there. The password-field guard runs in every readable frame of the tab before any script, so a login form in an iframe refuses the script wherever it would have run. The send-hold shim goes into, and is read back from, the frame the script runs in.
- Honest reporting. A frame Vyre cannot read is never left out: the snapshot lists it in `notReadable` (index, origin, why), says "N frames not readable: <origins>" at the top of `text`, and says when one covers a large part of the viewport ("Frame 2 (...) covers about 80% of the viewport and is not readable"). Every failure `detail` says which frame it looked in (`frame`, `frameOrigin`, and `searched`, `frames` on a page with more than one), and its page snippet comes from the frame the target was expected in. Traces carry `frame` and `frameOrigin`.
- GoHighLevel. A child frame on a `leadconnectorhq.com` host whose host or path is the automation or workflows app is the workflow builder, even under a white-label shell. The page module works this out from the frame's own origin (`state.ghlFrame`, `ghlFrames`), which a page cannot forge beyond its own frames, and the builder-tile rule accepts tiles in that frame. A real Send or Delete is still held.
- Not covered: a frame that is scrolled out of the top viewport (its point can fall outside it), and the egress guard of `page.eval` still judges a script's network calls against the top page's origin.

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
  A page with a visible password field is still not one `page.eval` or `dev.console.eval` runs on,
  because that rule is invisible: it counts type=password, fields that declare a password
  autocomplete, and fields a show-password toggle switched to type=text (by name, id, label or
  placeholder), and looks inside open shadow roots and same-origin iframes. Closed shadow roots and
  cross-origin frames cannot be read from the page and are the one blind spot.
- One floor list (`extension/shared/floor.js`) is imported by the module and the extension.
- The network buffer is judged per record and emptied when a tab navigates to a blind page.
  The console ring and the script cache are emptied whenever a page's execution contexts are cleared
  (a navigation or reload), and the person's own blind list is applied to the buffer, not only the
  built-in one.
- The host tells the module which origin Chrome launched it for, and the bridge only takes a hello
  from a host that named the manifest key's id. This is not authentication (any process of this user
  can write the same bytes to the socket); it keeps a host started by another extension or profile
  from being taken for ours. The socket's 0600 mode in a 0700 folder keeps other users out, and the
  floor, the grant and the Gate keep a same-user process honest. A replacement connection raises a
  quiet `chrome.replaced` event, never a prompt.
- Accepted: the manifest key is public, so anyone can build an unpacked extension with the same id.
  Reaching the host that way needs the person's own Chrome profile.
- Not done: naming `chrome.sock` in the floor's rule that denies a shell from talking to vyred's sockets.

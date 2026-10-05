# Proposal: the Capsule replaces Spotlight

Status: research, not started. Written against `local/capsule/` on main and `team/archive/work-journals/capsule.md`
as of this Mac's current build (M7, Wave 1, done through the offline state and Beacon list).

## Recommendation

Take Command-Space over, in place of double-Control, and make the Capsule do everything
Spotlight does before it does anything Vyre does. Concretely:

1. Keep the current architecture: one resident Electron process, one pre-created `NSPanel`-type
   `BrowserWindow`, `local/capsule/swift/` helpers for anything the sandboxless main process
   cannot reach. This is already close to Raycast's own shape (native shell + persistent backend
   + web view for UI), so no rewrite is needed to hit launcher speed: the pieces already run
   resident, not cold-started per keypress.
2. Add a fifth mode to the box, ranked ahead of "ask the assistant": local results. Apps, files,
   calculator, unit conversion, contacts, system settings, recent items, and Vyre's own results
   (projects, threads, agents, memory, held approvals) share one ranked list. `@agent` and
   `@thread` keep working exactly as today; a bare query now also matches local things before it
   is ever sent anywhere.
3. Take `⌘Space` only after a first-run flow that asks for it explicitly and shows the user how
   to give it back. Never take it silently, never take it before the local-results path is real , 
   a launcher that is slower or thinner than Spotlight on day one loses the user's trust for good.
4. Everything that needs a private framework (Contacts, Dictionary Services, LaunchServices,
   accurate app enumeration) goes through a new one-shot Swift helper, `local/capsule/swift/
   local.swift`, built the same way as `hotkey` and `launcher`: a small compiled binary the main
   process spawns and reads one JSON line from. Everything that is pure computation (calculator,
   unit conversion, ranking, fuzzy matching) stays in JS, because it needs no permission and no
   process boundary.

## 1. Taking Command-Space

**Freeing it.** The user-facing way is System Settings → Keyboard → Keyboard Shortcuts →
Spotlight → untick "Show Spotlight search". There is a programmatic path: writing
`~/Library/Preferences/com.apple.symbolichotkeys.plist`, key `64` (Show Spotlight search) and
`65` (Show Finder search window), each an entry shaped
`{ enabled = 0; value = { parameters = (32, 49, 1048576); type = standard; }; }`: but it is
undocumented, not an Apple API, and macOS does not always pick the change up without the Dock (or
a logout) restarting; some macOS versions need `killall Dock` or `killall cfprefsd` after the
write, some need a full logout, and Apple has silently changed the plist shape across OS
versions before. Treat it as a convenience the first-run flow can offer to run for the user with
their explicit yes ("open Keyboard Shortcuts for you" is the safe fallback if the write doesn't
take), never as something the Capsule does unasked. It does not need Accessibility or Input
Monitoring by itself. It does not survive an OS reinstall or, sometimes, a major OS upgrade , 
detect the state (`defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`, or simpler:
try to register the hotkey and see if it fires) and re-offer the handoff rather than assuming
it stuck.

**What Raycast does.** Its onboarding has an explicit "Replace Spotlight" step: press "Replace
Spotlight" and Raycast writes the same plist keys, unbinding Spotlight, then walks the user to
set `⌘Space` as Raycast's own hotkey in its settings. It is opt-in, one click, reversible, and
shown once: not forced. Raycast is explicit that Spotlight itself must stay running in the
background, because Raycast's file search is built on Spotlight's own index, not a replacement
for it.

**Registering the hotkey.** Two real mechanisms, already both represented in `local/capsule/
swift/hotkey.swift`'s reasoning:

- **Carbon `RegisterEventHotKey`.** Exclusive-fire, no Accessibility or Input Monitoring needed,
  works sandboxed with zero entitlements, deprecated-but-stable (Electron itself, VS Code and
  Slack all still use it for global shortcuts). Its limit: it only fires for a fixed key + modifier
  combination the frontmost app doesn't consume first, and it cannot register a modifier-only
  chord (Control-Control has no key, so `hotkey.swift`'s reasoning for choosing `CGEventTap`
  already applies and still applies to `⌘Space`, since `⌘Space` down to a keycode+modifier
  *can* go through `RegisterEventHotKey`. Command-Space is a real key ("Space") plus a real
  modifier ("Command"), unlike double-Control, so it is the one case in this whole app where the
  lighter mechanism is available.
- **`CGEventTap`.** What double-Control already uses, because a modifier-only chord has no key
  for Carbon to hook. Needs Input Monitoring (a listen-only tap) or Accessibility (a tap that can
  also alter events, which the Capsule never does). Carries the same rearm-on-timeout and
  chord-collision handling `hotkey.swift` already implements.

Recommendation: register `⌘Space` with Carbon `RegisterEventHotKey` in the same `hotkey`
binary, as a second registration alongside the existing double-Control tap, guarded by whether
the user has completed the handoff. This needs no new permission beyond what double-Control
already has, and it means the hotkey survives even if Input Monitoring is later revoked: the
worst case is losing double-Control, not losing `⌘Space` too.

## 2. Replicating Spotlight's features

| Feature | Reachable from Electron/Node directly | Needs the Swift helper |
|---|---|---|
| App launching | `open -a <name>` via `child_process`, or read `/Applications`, `/System/Applications`, `~/Applications` for a fast local index | `NSWorkspace.urlsForApplications` / LaunchServices for the *authoritative* list (System apps outside those folders, disabled/hidden apps, localized names): worth adding once the plain-folder index proves too thin |
| File search | No: Node has no Spotlight binding | Yes. `mdfind` as a subprocess is the fastest way to ship this (`mdfind -onlyin ~ '<query>'`, or an `NSPredicate`-shaped query), and it is what most third-party launchers actually run under the hood, not `NSMetadataQuery`, which trades a live-update API for cruder, less flexible query syntax. `NSMetadataQuery` in the Swift helper is the upgrade path if `mdfind`'s per-call process-spawn cost (fork + Spotlight IPC) turns out to dominate the keystroke-to-results budget |
| Calculator, unit conversion | Yes, entirely: no Apple API exists for this even in Spotlight itself. Write a small expression evaluator and a unit table in JS. Fully offline, matches floor rule 9 with no extra work |
| Contacts | No | Yes. `Contacts.framework` (`CNContactStore`), gated on its own permission prompt (`CNAuthorizationStatus`), same one-shot-binary pattern as `hotkey --check` |
| System settings panes | Yes: `open "x-apple.systempreferences:com.apple.<pane>"` from Node, no helper needed. Not every pane accepts the scheme (a pane's `Info.plist` must set `NSPrefPaneAllowsXAppleSystemPreferencesURLScheme`); maintain a short list of the panes people actually search for (Wi-Fi, Displays, Bluetooth, Sound, Privacy panes) rather than trying to cover all of them | No |
| Recent files | Partially: `mdfind -onlyin ~ 'kMDItemLastUsedDate > $time.now(-604800)'` sorted by that attribute gives a usable approximation without touching any per-app shared-file-list | Full parity (each app's own "Recent Items") would need reading `~/Library/Application Support/com.apple.sharedfilelist`, which is undocumented and brittle: skip for v1 |
| Dictionary | No | Yes, `DictionaryServices.framework` (`DCSCopyTextDefinition`), a small public C API: cheap enough to include in the same helper as Contacts |
| Web suggestions | Deliberately not replicated as Spotlight does it | Spotlight's web/Siri suggestions are a private Apple service that phones a query home with no visible destination: the opposite of floor rules 5 and 9. Route the same intent through the assistant instead: typing a plain question and pressing Enter with no local match already goes to Vyre, whose "Sends to" row shows exactly where it's going, unlike Spotlight's silent lookup |

## 3. Speed

**The budget.** Two numbers matter and they are different: keypress-to-window-visible (the
`⌘Space` → box on screen), and keystroke-to-results (a character typed → the list updates).
Raycast's own deep dive on their v2 rewrite names the same split, and it is the same tension
`local/capsule/app/main.js` already resolved for double-Control: the window is created once at
startup and only ever shown/hidden, never destroyed and recreated, specifically because a
`BrowserWindow` cold-start (process content, page load, layout) is where the real latency sits , 
not in Electron's per-frame cost once a page is already loaded and idle. Raycast's v1 kept every
window warm in memory for exactly this reason, and its v2 had to add grace periods back in after
tearing windows down more aggressively regressed cold-open latency.

**What the Capsule already does.** `create()` builds the window and loads `capsule.html` once;
`show()` on a later request just repositions, calls `.show()`, and steals focus: no reload, no
new process. The double-Control path (`hotkey.swift` → stdout JSON line → `toggle()` in
`main.js`) is a listen-only kernel tap piping into an already-warm window, which is the same
shape recommended above for `⌘Space` via `RegisterEventHotKey`. Nothing in the code or
`team/archive/work-journals/capsule.md` currently *measures* this path: the "9 ms" in `Capsule.dc.html`'s Recall
board is a mock value for the design, not a captured number, and `capsule.md`'s Done log verifies
correctness (the box gets the caret, `@` completes, a reply streams) but not latency.

**Recommendation.** Do not move the shell to native Swift. The architecture already matches
Raycast's own current one closely enough: persistent native process, persistent backend
(`vyred` playing the role of Raycast's Node backend), web content for UI: that a rewrite buys
little. What is missing is measurement: instrument `show()` to emit a `capsule.shown` event
carrying the hotkey-fire timestamp (already on the JSON line from `hotkey`) through to the first
composited frame (`did-finish-load` already fires once; add a `requestAnimationFrame` ping from
the page back over the preload bridge), and hold the team to a number before promising Spotlight
parity in copy. A native `NSPanel` with no web content at all would likely beat 50ms on the
open alone, but the Capsule needs live, styled, data-driven content (chips, "Sends to", gold
recall) the moment it opens, so the honest target is: warm-panel `show()` at native-launcher
speed, keystroke-to-first-local-result (apps, calculator) sub-frame since both are synchronous
local computation, and keystroke-to-file-result bounded by `mdfind`'s own subprocess latency,
which is the one place worth a fallback to a long-lived `NSMetadataQuery` helper if it proves too
slow under real measurement.

## 4. Ranking

`local/capsule/lib/route.js` already has the shape to extend, not replace. `complete()` scores
Vyre candidates by exact match, prefix, word-prefix, then substring, tie-broken by
`last` (recency): this is frecency with the frequency term missing. Extend it:

- Give every candidate (local or Vyre) the same shape (`{ kind, id, label, sub, last, score }`)
  and merge them into one ranked list, the way `candidates()` already merges agents, projects and
  threads.
- Add a frequency term next to `last`: a small per-item pick-count, incremented in `capsule.show
  → pick`, decayed over time the way Alfred and Firefox's frecency both do (recent picks worth
  more than old ones, so a thing used often but not lately still loses to something used today).
  This is local, per-Mac state: it can live in vyred's own store, keyed by what was typed and
  what got picked, and never needs to leave the Mac.
- Kind ordering stays a tie-breaker, not a hard bucket: an app the user opens ten times a day
  should be allowed to outrank a project the user visited once last week, which `KIND_ORDER`
  today does not allow (it always sorts agent above project above thread regardless of score).
  Loosen that once local results are mixed in, or a frequently-picked file will always lose to
  a barely-relevant project match.
- **When to send to the assistant rather than search.** Three signals, in order: (1) the box has
  a `@agent` or `@thread` chip: always the assistant/thread path, unmoved from today; (2) the
  query has no strong local match (`score` at or near the "substring" floor `complete()` already
  treats as barely-there) and reads as a question (contains stop-words like "what", "does", a
  question mark, or is simply longer than a launcher query typically is); (3) explicit escape
  hatch: Enter on an empty or all-local-junk list always falls through to "ask", never silently
  does nothing, matching the existing `destinations()` fallback to `{ kind: "recall" }` when
  there's no assistant yet.

## 5. Safety

A launcher reads every keystroke the user types, including the ones they abandon and delete , 
this is a stronger claim on trust than a chat box, because Spotlight-class tools are muscle
memory and people type into them without thinking about who's watching. The floor rules already
in `docs/SPEC.md` section 11 cover this if applied here specifically:

- **Nothing leaves the Mac unasked.** Local results (apps, files, calculator, contacts, settings,
  recent files) are computed on-device and never touch the network. Only a query that resolves to
  the assistant, an agent, or a thread goes out, and only after the existing "Sends to" row shows
  where (floor rule 2): this row already exists for `@agent`/`@thread`; extend it to also fire
  for the implicit "this became a question" path in section 4, so a plain-typed sentence that
  quietly turns into an assistant call is never silent.
- **Works offline for local results.** Floor rule 9 already scopes this to "the user's own Mac" , 
  app launching, file search, calculator, settings and contacts all still work with `vyred` down,
  because none of them touch it. Only Vyre's own results (projects, threads, agents, memory,
  Beacon) degrade, and the Capsule already has an offline state and recovery path per
  `team/archive/work-journals/capsule.md`'s Done log.
- **Nothing is logged off-device.** `mdfind` queries, contact lookups and app launches are exactly
  the kind of thing that must never appear in a Vyre event, log, or memory write: they are
  transient UI state, not part of any thread.
- **The permission asks stay honest.** Contacts and (if added) full LaunchServices access each
  carry their own macOS consent dialog, on top of the Input Monitoring the hotkey already needs.
  The first-run flow (section 6) should ask for these individually, as they're needed, not all at
  once at install: the existing `capsule.status` tool's shape (report what's built/grantable) is
  the right place to surface "why we're asking."

## 6. Distribution

- **Signing and notarization.** A Developer ID Application certificate, Hardened Runtime turned
  on (required for notarization, not optional), and a submission to Apple's notarization service
  before the first `.app` build reaches a user outside the Mac App Store: this is unrelated to
  and does not require the App Store at all. `local/capsule/build.sh` already produces the
  `hotkey` and `vyre-launcher` binaries ad-hoc signed for local dev; production distribution needs
  the same binaries (and the `.app` wrapper Electron Packager produces) signed with the real
  Developer ID identity and stapled after notarization.
- **Launch at login.** `SMAppService` (macOS 13+, `ServiceManagement` framework) replaces the
  old `SMLoginItemSetEnabled`/`LSSharedFileList` login-item mechanisms, works for both sandboxed
  and non-sandboxed apps, is App-Store-safe without being App-Store-required, and: critically for
  `vyre-launcher`'s reasoning about one stable process identity for Accessibility grants: a
  `SMAppService.agent` (launchd agent) plist pointing at `vyre-launcher` keeps that identity
  stable across restarts, which is exactly the gap `team/archive/work-journals/capsule.md`'s Next list already
  names as item 4. Default off, opt-in during first-run, matching `capsule.autostart`'s existing
  default in `local/capsule/index.js`.
- **First-run flow.** Sequence, each step skippable and re-offerable from the tray menu later:
  1. Explain what the Capsule needs and why (Input Monitoring for the hotkey; the `⌘Space`
     handoff is a keyboard shortcut change, not a permission).
  2. Offer to open Keyboard Shortcuts → Spotlight directly (the `x-apple.systempreferences` URL
     for that pane), with plain instructions, rather than writing the plist automatically , 
     Raycast's own flow is one click *inside its own settings*, which the Capsule cannot fully
     match without either the undocumented plist write or asking the user to leave the app; start
     with the safe version and consider the plist write, gated on an explicit "do it for me," once
     it's been proven reliable across OS versions in the field.
  3. Confirm the swap worked (try firing `RegisterEventHotKey` for `⌘Space` and require it to
     actually receive an event before declaring success: never assume the plist write landed).
  4. Ask, separately, for Contacts access only when the user first types something that would
     benefit from it, not at install: matches "ask before you need it," which keeps the
     permission list short and each ask legible.
  5. Offer launch-at-login last, off by default, exactly as `capsule.autostart` already defaults.

## Feature parity table

| Spotlight feature | Capsule after this work | Gap |
|---|---|---|
| App launch | Yes (folder index, upgrade to LaunchServices) | none planned |
| File search | Yes (`mdfind`, upgrade path to `NSMetadataQuery`) | slightly different query syntax than Spotlight's own, invisible to the user |
| Calculator / conversion | Yes (own evaluator) | none |
| Contacts | Yes (Swift helper, own permission) | none |
| System settings | Yes for the common panes | not every pane accepts the URL scheme |
| Recent files | Approximate (`mdfind` by last-used date) | not per-app "Recent Items" parity |
| Dictionary | Yes (Swift helper) | none |
| Web / Siri suggestions | Deliberately different: routed to the assistant, shown, not silent | intentional: the private Apple path violates floor rule 5 |
| @agent, @thread, memory recall, held approvals | Already shipped | none: this is what the Capsule already does |

## Milestones

1. **Local index, no hotkey change.** App + file (`mdfind`) + calculator results, ranked and
   merged into `route.js`'s candidate list, reachable only via the existing double-Control open.
   Proves the ranking and the offline story before touching anyone's muscle memory.
2. **Contacts, settings, dictionary, recent files.** The Swift `local.swift` helper, its own
   permission flow, `capsule.status` extended to report what's grantable.
3. **`⌘Space` opt-in.** First-run flow, `RegisterEventHotKey` registration, the plist-assisted
   handoff behind an explicit confirm, `SMAppService` for the stable launchd identity.
4. **Measure and hold the speed bar.** `capsule.shown` timing event, a captured number (not a
   mock), before "as fast as Spotlight" appears in any user-facing copy.
5. **Signed, notarized, launch-at-login build.** `build.sh` extended to produce a Developer-ID
   signed, notarized `.app`; `vyre-launcher` moved to a `SMAppService` agent plist.

## Risks

- **The plist write is undocumented and version-fragile.** Mitigate by defaulting to "open
  Keyboard Shortcuts for the user" and only offering the automatic write once it's been verified
  across the OS versions Vyre actually supports, with a working detection-and-re-offer path for
  when an OS update silently reverts it.
- **`RegisterEventHotKey` can be pre-empted by the frontmost app.** Some apps (terminals,
  games, GPUI-based apps) consume `⌘Space` before Carbon sees it. Detect a Vyre-side miss (no
  fire for a plausible interval given other telemetry) and tell the user plainly rather than
  failing silently: matches floor rule 7 (anything Vyre tells the user, it can show the source
  of), applied here as "if the hotkey doesn't fire, say so, don't guess."
- **`mdfind` latency under real load.** A subprocess per keystroke is the wrong shape if typing
  feels laggy; debounce it the way any incremental search must, and keep the `NSMetadataQuery`
  helper as the documented fallback rather than a maybe.
- **Contacts and Dictionary Services both add App Review-style consent friction** even outside
  the App Store, because they're OS-level privacy prompts, not App Store gates: budget for users
  who say no to Contacts and never see contact results, without the rest of the launcher
  degrading.
- **Losing user trust on day one.** If `⌘Space` is taken before file search, app search and the
  calculator are as good as Spotlight's, every keystroke that returns a worse result than
  Spotlight would have is a broken promise. Milestone ordering above exists specifically to avoid
  shipping the swap before the parity is real.

Sources: Apple's Carbon Event Manager and `CGEventTapCreate` documentation via prior art already
cited in `local/capsule/swift/hotkey.swift`; Apple's `NSMetadataQuery`, `NSWorkspace`,
`ServiceManagement` (`SMAppService`), `Contacts`, and `DictionaryServices` framework references;
Apple's notarization and hardened-runtime documentation for Developer ID distribution outside the
Mac App Store; Raycast's own "Replace Spotlight" onboarding step and its public technical deep
dive on the v2 rewrite (native shell + persistent Node backend + web view, and the warm-window
tradeoff between v1 and v2); Alfred's and Firefox's public descriptions of frecency ranking.

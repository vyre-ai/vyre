# capsule-pro

Branch: work/capsule-pro · Worktree: ../vyre-capsule-pro · Owner session: capsule-pro · ADR 0017

## Scope

Owns `local/capsule/` (now native Swift, `local/capsule/native/`) and `local/hands-mac/`.

1. The Capsule as a native macOS app: Swift, AppKit `NSPanel` hosting SwiftUI, real materials,
   SF fonts and SF Symbols, real app and file icons from `NSWorkspace`, 120 Hz animation,
   keyboard first. Built with `swiftc` on the user's Mac from the npm package (no Xcode project,
   no Developer ID), signed with one stable local identity so Accessibility and Input Monitoring
   grants survive updates. Talks to vyred over the unix socket and SSE only. Full parity with
   the Electron Capsule (`docs/work/capsule.md`, Done), then Electron is retired.
   Targets: hidden footprint under 60 MB, under 0.1% CPU, no GPU while hidden, wake under 50 ms.
2. Spotlight Pro Max: recent files, Quick Look, file actions, search inside documents, mail,
   a web row, act on selected text, ask about my screen, OCR, search by meaning, Reminders and
   Calendar, browser tabs/history/bookmarks, windows, system commands, Shortcuts, snippets and
   user commands, paste into the front app, vault inline, currency, time zones, emoji, colour
   picker, media keys. Each permission asked for on first use.
3. The Capsule gaps from the gallery (brief item 6) and the Capsule items moved here from
   polish-surfaces (items 2, the Capsule half of 3, and 5).

## The extension seam (for capsule-sight and anyone else)

The Capsule is one Swift process. Other teams build into it through `local/capsule/native/Sources/Kit/`
without editing Capsule files:

- **Where:** a folder `local/capsule/native/Sources/Extensions/<name>/`. It is compiled into the one
  binary. `build.sh` finds the class by a marker comment and writes `Registry.generated.swift`:

  ```swift
  // capsule-extension: SightExtension
  @MainActor final class SightExtension: CapsuleExtension {
      static let id = "sight"
      private let host: CapsuleHost
      init(host: CapsuleHost) { self.host = host }
      var commands: [CapsuleCommand] { [ /* "Ask about my screen" */ ] }
      func sidePanel(for item: ResultItem?) -> AnyView? { AnyView(SightPanel(host: host)) }
  }
  ```

- **Info.plist keys** (usage strings for a new permission, such as `NSMicrophoneUsageDescription`)
  go in `Sources/Extensions/<name>/Info.plist.part` as `<key>` / `<string>` lines; `build.sh`
  splices them in. System frameworks link by `import` alone.
- **The protocol** (`Kit/Extension.swift`), all optional but `id` and `init(host:)`:
  - `providers` (rows; adopt `ImmediateResults` if you can answer from memory in the keystroke's
    frame, otherwise your rows arrive later and the previous ones stay up to 300 ms),
  - `commands` (named commands, matched on title and keywords, listed under Commands),
  - `mentions(matching:)` and `send(_:to:query:)`: what `@` can name in your extension
    ("@Notes", "@Slack #general"). Called on every key while `@` is typed, with the words after
    it (spaces included): answer from memory. Your targets come after Vyre's own agents,
    projects and sessions. Picked, a target is the chip; the bar shows its `sendsTo`; Enter
    calls `send` with the rest of the text, and your `ActionOutcome` is what the user sees,
  - `keyChords` (only chords with Option or Control reach extensions; the Capsule's own keys use
    Command and Shift, so there is no clash; sight has Option-Return),
  - `sidePanel(for:)` (260 wide beside the list, for rows whose `panel` is your id, or after
    `host.showPanel(id)`), `capsuleWillShow(front:)`, `capsuleDidHide()`, and `runsHidden`.
- **The host** (`CapsuleHost`): `vyred.call(tool, input, presence:)`, `vyred.on(pattern)` and
  `vyred.stream(path, onMessage:, onClose:)` (a WebSocket to /v1/streams/..., as the capsule
  caller); `front`; `permission` and `request(_:reason:)` (says your reason first; no OS dialog
  unless `dialogsAllowed()`); `showPanel`, `hidePanel`; `setQuery`, `say`, `notify`;
  `stepAside()`; `commandsChanged()` (your commands or providers changed while open);
  `sessionWindow(owner:)`, the one Capsule-owned window (borderless, non-activating, key on a
  click in a field, animated with `setFrame(_:duration:curve:)`), opened only from a command the
  user ran.
- **Tests** for an extension go in `Tests/<Name>/`; a fake host needs only the members it uses,
  since `sessionWindow` and `commandsChanged` have defaults.
- **vyred modules** keep the runtime seam they already have: `shows.capsule` in a manifest
  (`results:<tool>`, `action:<tool>`), read by the Capsule on open. That is for module rows and
  verbs; the Swift seam is for native UI and Mac APIs.

## Done
- The native Capsule is THE Capsule: Electron, its helpers and the zip are retired (9f9157f,
  b76552d). `vyre capsule install` builds on the Mac. Verified 2026-09-27 in a temp home
  (VYRE_NO_DIALOGS=1, not opened): built and signed ad hoc as sh.vyre.capsule, and the second run
  said "up to date".
- Session 4 (2026-09-27, after logout 3): merged main ef51363, fixed the build (the stale askItem
  call), and merged capsule-now fc7fa70, capsule-agent 792420c, capsule-sight 876975b and
  capsule-apps-native 8cba106. apps-native's own CI had been cancelled; the Swift suite on the Mac
  passed 260/260 with it merged, so it went in. ADR 0015 got front matter and a nav entry. Node
  targeted tests on testbox passed 122/122.
- The presence session (008ee64): gate.approve refused `presence_required` asks once in the panel
  with readable words, sends `x-vyre-presence-keep: 1`, and keeps the returned session in memory.
  Later sessionable calls ride it. It is dropped on refusal, a minute before it ends, and on
  lock or sleep (presence.session.close too). `CapsuleHost.prove(tool:input:summary:)` is for
  capsule-apps. Swift 267/267.
- Planner banners (d608b8a), Touch ID in the panel, menu-bar popover, Taildrop send, the typing
  fix, the extension seam, `@` targets: see CHANGELOG.

## Doing (saved at logout 4, 2026-09-27)
Branch tip 996a7ee8 (pushed). Swift 297/297. Built today: shortcuts (⌘A etc.), session events and
the paced reveal, auto-answer and the follow-up box, voice and computer use (see CHANGELOG).

The TRIAL is left RUNNING for the user (VYRE_HOME=/private/tmp/claude-501/vyre-try, never paired):
- trial vyred pid 58916 (`node core/daemon/main.js` from this worktree)
- trial Capsule pid 13018 (this worktree's .build/Vyre.app, launched with
  `open -n --env VYRE_HOME=/private/tmp/claude-501/vyre-try --env VYRE_ALLOW_DIALOGS=1 <app>`)
- Stop: quit from the menu-bar mark ("Quit Vyre Capsule"), then
  `VYRE_HOME=/private/tmp/claude-501/vyre-try vyre down` (from this worktree: `node bin/vyre down`).
- Its config points at the real box; `vyre up` there makes a pairing request (deny it).
- The real Vyre (global npm 0.0.1, vyred 60055, ~/.vyre) is untouched.

## Next
1. USER BUG, TOP PRIORITY. (a) The answer area clips mid-line in a fixed box with no scroll. Make
   the answer card grow to the panel's max height, then scroll: trackpad, and ⌘↑/⌘↓ and
   PageUp/PageDown while the box keeps focus. Never clip mid-line. Auto-follow the stream unless
   the user scrolled up. Add a snapshot test with a long answer. Today the answer at the top is
   capped at 200 pt and `.clipped()` (CapsuleView `answer.frame(maxHeight: 200)`), and answerAlone
   scrolls without keys. (b) The "SEND TO" and "COMMANDS" headings render with no rows: hide
   empty sections.
2. ⌘⏎ Think deeper: switch the SAME thread with sessions' threads.model and thinking on (db44749b,
   batch 3b) once it is on main, instead of the new-thread fallback in AutoAsk.deeper().
3. Design A: app-design's docs/design/system/capsule-mac.md (work/app-design c4f9bb23) and
   capsule.md when it lands. In their order: every token from Tokens.generated.swift (sizes,
   fonts, motion; no 10.5/11.5/14/22 and no gold literal); violet and gold misuse; one button system
   (lime primary, 28/32, busy and disabled); duplicates (one turn renderer, one selected
   marker); 44 pt rows; sentence case; the presence line; Always in <project> on the ask card.
4. The settings hub (native-core): read /v1/theme and settings at launch, repaint on
   settings.changed, and keep Theme.swift as the offline fallback only.
5. The real-Vyre install after tonight's deploy, through the normal update path (the lead
   arranges it with the user); then the 11-step real-Mac check below.
6. "idle" on @ session rows from threads.list `status`. Persist PlannerBanners.unsent.
7. Voice and computer use first-class are built; the live checks need the user (speech key in the
   trial via `vyre voice key deepgram`, and the Microphone, Accessibility and Screen Recording grants).

## Footprint: met (2026-09-27)
- CI run 36314455924 (macos-latest): never shown 18.3 MB footprint, RSS 82.3 MB; hidden after use
  24.3 MB footprint (target 60), RSS 93.8 MB, 0.065% CPU (target 0.1); open under 50 ms. The
  "93 MB" was RSS, which counts shared AppKit and SwiftUI pages; the target is phys_footprint.

## Also done 2026-09-27 (session 4, later)
- ci's signing-hang fix, cherry-picked (63399a1), and the duplicate app build step removed.
  createIdentity refuses with no TTY unless a runner is given (feb1a11).
- capsule-apps-native 7423c8c merged (6ff7185): AppsExtension and the row for words without @.
- Tokens: gen-tokens writes Tokens.generated.swift (work/capsule-pro-tokens 450cd16, handed to
  mobile), and Theme.swift reads colours, the status model and the card radius from it (544d27f).
- Planner by key (61dd9dc): the notification id is the key. planner.ringing {cursor} is read,
  planner.upcoming 48 h is scheduled locally, and answers given while the box was away are sent
  by key. Degrades with no planner.upcoming. Built against planner 3c75e47's contract, which is
  not on main yet.
- Sessions (61dd9dc): Esc uses threads.interrupt, thread.stopped idle is not a failure, busy is
  said in words, and the terminal-only "not one vyred runs" wording. Swift 284/284.

## Shortcuts in the Capsule (2026-09-27)

The user found ⌘A did nothing. The app is an accessory with a non-activating panel and had no main
menu, so AppKit had nowhere to find the standard key equivalents. `Sources/Host/MainMenu.swift` now
installs the standard app, Edit and Window menus (never shown), and `CapsulePanel.performKeyEquivalent`
routes to them, since the app is never the active one. The Capsule's own handler no longer takes
⌘↑/⌘↓, ⇧↑/⇧↓, ⌥↑/⌥↓ or ⌘→ (except at the end of the box), and no ⌘ key the menus own goes to a
row. Checked by `Tests/ShortcutTests.swift`: the menu table, ⌘A and ⌘Z through the panel into the
box, and every key below passed through or kept.

| Keys | What they do | Where |
|---|---|---|
| ⌘A | Select all | Edit menu |
| ⌘C | Copy the selection; with none, the row (or the answer in an empty box) | Edit menu, Capsule |
| ⌘X, ⌘V | Cut, paste | Edit menu |
| ⌥⇧⌘V | Paste and match style | Edit menu |
| ⌘Z, ⇧⌘Z | Undo, redo | Edit menu (the window's undo) |
| ⌘F | Find: focus the box and select its words | Edit menu |
| ⌃⌘Space | Emoji and symbols | Edit menu |
| Dictation (the system key) | Dictate into the box | AppKit |
| Services | From the field's context menu and the app menu | AppKit |
| ←/→, ⌥←/→, ⌘←/→ | Move by character, word, line; with ⇧ they select | the field |
| ⌘↑/↓ | Top or end of a long answer; with no answer to scroll, start or end of the box; with ⇧ they select | Capsule, the field |
| PageUp/PageDown, Home/End | Page through a long answer, or go to its top or end; the focus stays in the box | Capsule |
| ⌥⌫, ⌘⌫ | Delete a word, delete to the start (⌘⌫ removes an attachment chip first) | the field, Capsule |
| ⌃A, ⌃E, ⌃K (and the other emacs keys) | Start, end, kill to end | the field |
| ⌘W | Hide the Capsule | Window menu |
| ⌘, | Settings: hides the Capsule and opens the menu-bar popover | app menu |
| ⌘Q | Hides the Capsule. Quitting is "Quit Vyre Capsule" in the menu-bar item's menu, so a stray ⌘Q never loses the hot keys | app menu |
| Esc | Cancel Touch ID, a confirm, or a streaming answer; else clear an answer back to plain search; else clear the box; else hide | Capsule |
| ↑/↓ | Move in the results; ↑ in an empty box opens what waits on you | Capsule |
| ⏎ | On a question: keep the answer and open the follow-up box; in it, continue the thread. Otherwise run the row (a held ⏎ counts once) | Capsule |
| ⌘⏎ | On a question or a follow-up: think deeper (the same thread switched to the deeper model, thinking on). On a row: its other action; on a held card: send | Capsule |
| ⇧⏎ | The row's other action | Capsule |
| ⌘O | Open the answer's thread in Vyre chat on the box | Capsule |
| Tab | Pick the @ row, or send the words to the first destination | Capsule |
| ⌘K | The row's actions, to pick one | Capsule |
| ⌘D | The same as ⌘⏎ on a finished quick answer (kept for old habits) | Capsule |
| ⌘S | Send a file row to the box | Capsule |
| ⌘→ at the end of the box | Show or fold memory's sources | Capsule |
| ⌫ in an empty box | Drop the @ chip | Capsule |
| A in the waiting list | Allow or accept the highlighted row | Capsule |
| ⌥⏎ | Talk into the box: hold to talk while down, or tap to start and tap to stop (sight) | extension |
| "do …" then ⏎, or ⌘⏎ on an action | Computer use: an agent session with hands and screen, tool rows live, Esc stops the hands | Capsule |
| ⌥Space, Control twice | Open or hide the Capsule from anywhere | hot keys |

## Real-Mac check for the native Capsule (the user, at the Mac, in their own terminal)

Only what cannot be tested for them: the keychain, Touch ID, lock and sleep, the hot keys, a
banner. About 20 minutes. Everything goes to the user's own address and nobody else. Before
starting: this Vyre install is the user's own (not a temp home), a Gmail sender is connected
(`vyre call gate.senders '{}'` lists `gmail`), and the Mac has Touch ID.
Held test mail: `H='{"kind":"send","via":"gmail","to":"<your own address>","content":{"subject":"Vyre check N","body":"Capsule check."}}'`,
then `vyre call gate.request "$H"` with N changed each time.

1. **Install.** `vyre capsule install`. It says it builds on this Mac and downloads nothing,
   then asks once whether to make a local signing identity. Say yes and type the Mac password
   when macOS asks. Pass: "Signing identity: made ..." and "Capsule built".
   `codesign -dv ~/.vyre/capsule/Vyre.app 2>&1 | grep Authority` shows `Vyre Local`.
2. **Open.** `vyre capsule`. Press Option-Space in a full-screen app. Pass: the Capsule opens over
   it, Esc closes it, and the menu bar mark's dot is green (grey means vyred is not up).
3. **Control twice.** From the menu bar mark, turn on "Control twice" and allow Input Monitoring
   in System Settings once. Pass: tapping Control twice toggles the Capsule, and `vyre doctor`
   says so for the Capsule.
4. **Enrolment.** Queue "Vyre check 1". In the Capsule press Up, open the held mail and press
   Command-Return. The first time, vyred's own Touch ID dialog enrols the Capsule's key. Pass: one
   system Touch ID prompt that names Vyre, then the step below.
5. **Touch ID in the panel, cancelled.** The panel says "Confirm it's you" with "Send to <your
   address>: Vyre check 1" and Touch ID drawn inside the panel. Press Esc. Pass: "Not approved.
   Nothing was done. It is still held.", and no mail arrives.
6. **Touch ID in the panel, approved.** Command-Return again and touch the sensor. Pass: the row
   leaves the list and "Vyre check 1" arrives within a minute.
7. **The session covers the next one.** Queue "Vyre check 2" and send it the same way within 30
   minutes. Pass: no Touch ID at all, and the mail arrives.
8. **Locking ends the session.** Lock the Mac (Control-Command-Q), unlock it, queue "Vyre check 3"
   and send it. Pass: Touch ID is asked again. Do the same after closing the lid for a minute
   (sleep).
9. **A banner from the box.** `vyre timer 1m vyre check`. Hide the Capsule. The first time,
   macOS asks to allow notifications: allow them. Pass: a banner at the top right after a minute,
   with Done and Snooze. Press Done: it goes, and the Deck and phone show it answered.
10. **An update keeps permissions.** Update Vyre (the next npm version, or `npm i -g` of the
   branch), then `vyre capsule`. Pass: it rebuilds once ("Building the Capsule"), still
   `Vyre Local` (step 1's command), and Control twice (step 3) works with no new permission
   prompt.
11. **Light while hidden.** Leave the Capsule hidden for a minute. Then run
   `footprint $(pgrep -x Vyre) | grep phys_footprint:` and `ps -o %cpu= -p $(pgrep -x Vyre)`.
   Pass: under 60 MB and under 0.1% (CI measured 24 MB and 0.07%).

Afterwards: `vyre call gate.held '{}'` shows nothing left over. Discard anything that is, with the
card's Discard button in the Capsule or `vyre call gate.reject '{"id":"<id>"}'`.
If a step fails, note its number and what the screen said. Screenshots of the Capsule only.

## Needs from others
- capsule-now: its rules doc (docs/work/capsule-now.md) is not written yet; the lead asked the
  Capsule to follow it (memory in quick answers, notices as a faint line, question vs answer
  layout, queueing for a busy session). Folded in when it lands.
- lead/user: whether the native Capsule takes ⌘Space from Spotlight (user decision), and a
  local signing certificate name for VYRE_SIGN_IDENTITY so grants survive rebuilds.
- capsule-sight: builds into the seam above (screen context, computer use, side panel, voice).
- connectors: calendar and email through the assistant; the Capsule's own Calendar/Reminders
  (EventKit) and mail (Spotlight index) rows are local and do not need them.
- mobile: reuses the Capsule's design language (`Sources/UI/Theme.swift`).

## Changed contracts
- Kit (Sources/Kit/Extension.swift), for extensions: `VyredLink.stream(_:onMessage:onClose:)`
  with `VyredStream` and `VyredStreamFailure` (default fails, so fakes conform);
  `CapsuleHost.sessionWindow(owner:) -> SessionWindow` (default is a do-nothing window). Chords:
  Option or Control chords go to extensions first; the Capsule's own keys use Command and Shift.
- `vyre capsule` opens the native app on a Mac; `--electron` / VYRE_CAPSULE=electron for Electron.

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

## Doing (session 6, 2026-09-27/28, Design A for the RC)
Handed earlier: work/capsule-pro-said a127335d (capsule-mac green).
On work/capsule-pro since, for the RC cut (Design A; deadline 03:00 UTC, go/no-go 01:30 UTC):
Design A T1 (b330aa82, 560 fixed, keys-only footer), ⌘⏎ think deeper, screen context with the
"sees" chip, the inline key row (fcd80523), `vyre ...` in the panel with --view frames
(1b516a68, e43708bc), 560 in one 150 ms step and the 2 s status line (e762c5f8), the compact
empty panel with the waiting rows and footer (e784fcae), mail rows (9b56b201). Swift 325/325.
Then: push work/capsule-pro, capsule-mac CI green, hand the sha to the integrator. After that,
memory.answer -> memory.ask when memory-iq's lands on main (not there at 19:30 UTC).

The TRIAL is RUNNING for the user (VYRE_HOME=/private/tmp/claude-501/vyre-try, never paired):
- 2026-09-27 19:5x UTC: updated to 0a7d7f53 (trial HEAD 75c8a86), relaunched with VYRE_NO_DIALOGS=1
  (the lead: no OS dialogs), vyred with the fake tailscale.
- runs from a separate local checkout ../vyre-capsule-pro-trial (detached; my branch plus
  sessions 51eaa964's Vyre IQ prompt; never pushed). Update it with
  `git -C ../vyre-capsule-pro-trial merge --no-edit <sha>`, rebuild there, relaunch.
- trial vyred: `VYRE_HOME=... VYRE_ALLOW_DIALOGS=1 nohup node core/daemon/main.js` from the trial
  checkout (log vyre-try/vyred-trial.log); find it with `ps` on core/daemon/main.js and VYRE_HOME.
- trial Capsule: `open -n -g --env VYRE_HOME=/private/tmp/claude-501/vyre-try --env VYRE_ALLOW_DIALOGS=1 ../vyre-capsule-pro-trial/local/capsule/native/.build/Vyre.app`;
  find it with `pgrep -f vyre-capsule-pro-trial/local/capsule/native/.build/Vyre.app` (never a
  bare "Vyre.app" pattern: that would match the user's real Capsule).
- Stop: quit from the menu-bar mark, then `VYRE_HOME=/private/tmp/claude-501/vyre-try node bin/vyre down`.
- The real Vyre (~/.vyre) is untouched.

## Next
1. app-design 305fc07b left: tip.md (tips.next, ⌘. dismisses), credential-sheet.md check
   against the row built, glass-mini.md step pill; "three recent items" on open (capsule.md).
2. A held mail from "Write it" could open its card at once (today: words, then ↑).
3a. (0.1.1) IQ corrections, memory-iq 95b2b891: answer_id on every memory.ask reply; a quiet
   "Wrong?" line opens "That's wrong" (memory.correct {answer, action:"wrong"}), "Forget this"
   (action:"forget"), and a field prefilled with the answer (Enter: action:"replace", object).
   Not sure card: the field only, "Know it? Tell me". Reply {fix:{id}}: show the fix at once with
   Undo (memory.uncorrect {fix}). via "corrected": the answer with "you corrected this", no chips.
3. DONE for rc.2 without streaming (IQAsk.swift). Left for 0.1.1: stream:true with memory.thinking
   stages, ⌘1..⌘3 on source chips. memory-iq 6adfc4b6 spec (docs/design/iq-everywhere.md on work/memory-iq): memory.ask
   {question, stream:true, id:"cap_<n>", context:{project}}; memory.thinking {id, stage} then
   memory.answered; reply {answer, confidence, abstained, known[], sources[], via, limited?, message?}.
   Draw answer, "confidence X · from N sessions", 3 sources (tap opens the turn); abstained: "Not
   sure yet." + known + "Ask Claude instead"; limited: message verbatim. Old path only on
   no_such_tool. Earlier note: Vyre IQ over iq.ask {stream:true} when memory-iq lands it (stages, source chips ⌘1..⌘3, Not
   sure, nothing found). [n] in replies linked to source rows (sessions 51eaa964).
4. Cohesion glue as each lands on main: context.report on front-app switch, sight.now,
   suggest.query, waiting.list/count, sessions.models.resolve, connections (vault) and mail rows
   (connectors 04a5495e), needs_credential {detail} parsed by the client, commands.list.
5. The settings hub: /v1/theme?device= (ADR 0035) or /v1/appearance/theme, repaint on
   settings.changed; Tokens.generated.swift as the offline fallback only.
6. `!cmd` shell lines (person-only, under the floor): not built; needs a tool (threads.shell needs
   a thread). A presence proof for CLI verbs that exit 3: ask polish-cli for an env or flag.
7. The real-Vyre install only with the lead's go; then the 11-step check.

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
| ⌥↑/↓ | Three lines of a long answer; with none, the box's | Capsule, the field |
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
| D in the waiting list | Deny the highlighted ask (a held send or a lesson says no on its card) | Capsule |
| ⌥⏎ | Talk into the box: hold to talk while down, or tap to start and tap to stop (sight) | extension |
| "do …" then ⏎ | Computer use (only this way in): an agent session with hands and screen, tool rows live, Esc stops the hands | Capsule |
| ⌥Space, Control twice | Open or hide the Capsule from anywhere | hot keys |

### The footer (Design A, capsule.md)

The footer holds keys only, four at most, chosen by `CapsuleLayout.footerHints(model)` (checked by
`Tests/DesignATests.swift`). Status ("Copied", a confirm's question) is one line above the footer.
Nothing typed: ↑↓ Move, ⏎ Open, Esc Hide. Results: ↑↓ Move, ⏎ (the row's first action), its ⌘⏎ or
⌘S action, Esc Clear. Question typed, an answer on top, or the follow-up box: ⏎ Ask, ⌘⏎ Think
deeper, ⌘O Open in Vyre, Esc Clear. Streaming: Esc Stop, ⌘⏎ Think deeper. Speaking: Esc Stop in
place of Clear. Using your Mac: Esc Stop, ⌘O; stopped or done: ⌘O, Esc Clear. Listening: ⌥⏎ Stop.
Ask focused: A Allow once, D Deny, ⏎ Review, Esc Close. A card: ⌘⏎ Send (or ⏎ Allow/Accept), Esc
Back. ⌘K: ↑↓ Move, ⏎ Run, Esc Back. Touch ID: Esc Cancel. ⌘O shows only with a thread to open.
Two words differ from the spec's table because the keys do something else today: the list's Esc
closes the list ("Close", not "Clear"), and listening says "⌥⏎ Stop" since the Capsule cannot tell
a held talk from a tapped one and Esc does not cancel dictation yet (T2).

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
- core/daemon GET /v1/health: `cli` [node, <repo>/bin/vyre], additive, so the Capsule runs the same
  vyred's CLI for `vyre ...` typed in the box (by argv, with --view).
- Kit: `SendAttaching.mayBeAbout(_:)` (default false): at once, could the chip be about these
  words; false lets a question go to memory.ask without waiting for the chip.
- Kit: `SendAttachment.aboutIt` (default false): the words are about the attachment, so a
  question skips memory.ask for the fast model (sight sets it for screen words and selections).
- Kit: `CapsuleHost.askCredential(_:saved:)` and `CredentialNeed` (default does nothing, so fakes conform).
- Kit (Sources/Kit/Extension.swift), for extensions: `VyredLink.stream(_:onMessage:onClose:)`
  with `VyredStream` and `VyredStreamFailure` (default fails, so fakes conform);
  `CapsuleHost.sessionWindow(owner:) -> SessionWindow` (default is a do-nothing window). Chords:
  Option or Control chords go to extensions first; the Capsule's own keys use Command and Shift.
- `vyre capsule` opens the native app on a Mac; `--electron` / VYRE_CAPSULE=electron for Electron.

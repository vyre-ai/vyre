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

## Doing
- Waiting on capsule-mac CI for the integrator's green sha.

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

## Next
2. When sessions lands thread.state, thread.tool {call, status}, thread.turn and thread.usage:
   tool rows by call id, "idle" on @ session rows (VyreThread has no state yet), and "send now".
3. Switch the "live in terminal" badge to capsule-now's `live` flag (threads.list and
   projects.catalog rows carry it via fc7fa70).
4. Local ring answers kept only in memory (PlannerBanners.unsent). Persist them to
   <home>/capsule/ if a quit before the box returns matters.
5. Prove enrolment and the in-panel Touch ID with the user at the Mac.

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

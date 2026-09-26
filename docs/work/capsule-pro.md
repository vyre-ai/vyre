# capsule-pro

Branch: work/capsule-pro · Worktree: ../vyre-capsule-pro · Owner session: capsule-pro · ADR 0015

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
- **The protocol** (`Kit/Extension.swift`): `providers` (rows), `commands` (named commands),
  `keyChords` (chords while the Capsule is open and key, never global), `sidePanel(for:)` (a
  SwiftUI view beside the list), `capsuleWillShow(front:)` and `capsuleDidHide()`, and
  `runsHidden` (nil unless something must run while hidden, with the reason; perf-check lists it).
- **The host** (`CapsuleHost`): `vyred.call(tool, input, presence:)` and `vyred.on(pattern)` as the
  `capsule` caller; `front` (the app in front at wake); `permission` and
  `request(_:reason:)` (first use only, no OS dialog unless `dialogsAllowed()`); `showPanel`,
  `hidePanel`; `setQuery`, `say`, `notify`; `stepAside()` (hide and wait for the front app,
  for acting on it).
- **Rows** (`Kit/Kit.swift`): `ResultItem` with a stable `id` that is never shown, `title` for
  copy, an `IconSpec` (file path, bundle id, SF Symbol with a token tint, contact, swatch,
  glyph), a `Section`, `actions` (first is Enter, all on ⌘K; `confirm` for anything destructive,
  `needsFrontApp` for acting on the app behind), `fileURL` for Quick Look and drag,
  `sendsTo` when picking it sends words off the Mac process, and `panel` to route its side
  panel to an extension. Outcomes are words: `.close`, `.said`, `.failed` (never reported as
  success), `.replaceQuery`, `.openPanel`.
- **Tokens:** tint only with `Tint` (bone, stone, ash, signal, recall, beacon). Views use
  `Theme` from `Sources/UI/Theme.swift` (colours, type, radii, spacing from TOKENS.md).
- **vyred modules** keep the runtime seam they already have: `shows.capsule` in a manifest
  (`results:<tool>`, `action:<tool>`), read by the Capsule on open. That is for module rows and
  verbs; the Swift seam is for native UI and Mac APIs.

## Done
- (nothing merged yet)

## Doing
- First runnable native build (2026-09-27): `Sources/Host/` (App, Panel, Hotkeys, CapsuleModel,
  main) and `Sources/UI/` (Theme, CapsuleView). Panel is Spotlight's size and place (680 wide,
  56 px bar, results grow down, top edge 22% from the screen top), a non-activating NSPanel at
  popUpMenu level with [.canJoinAllSpaces, .fullScreenAuxiliary], so it opens over a full-screen
  app on its Space. Core: apps, settings panes, files (Spotlight), dictionary, calculator,
  system commands, and Ask (threads.start, lean haiku, reply streamed under the bar).
  Hot keys: Control twice when Input Monitoring is already granted (asked only from the menu),
  and ⌥Space (VYRE_CAPSULE_HOTKEY) with no permission. `open Vyre.app` again toggles it.
- Build: `<team-dir>/buildlock.sh capsule-pro local/capsule/native/build.sh app`
  writes `local/capsule/native/.build/Vyre.app` (plist, ad hoc signature, id sh.vyre.capsule).
- Known test failure: provider people icons test (contact photo pixel read, colourspace -1).

## Next
1. Native shell: NSPanel, hotkey in process, menu-bar item, vyred link, the launcher's local
   results, the Vyre half (bridge, state, watches, DMs, held cards), build and sign.
2. Parity check against every "Done" line in capsule.md, then retire Electron.
3. Pro Max features, each native.
4. Gallery gaps and the moved polish items.

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
- (none yet)

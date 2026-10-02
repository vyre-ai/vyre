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
   STATUS (2026-09-30, checked in code): wired and in use today are apps, files, contacts, the
   dictionary, settings, clipboard history, the calculator with units, system commands, and (since
   Providers/LocalAnswers.swift) emoji, colours, time zones, money with rates from open.er-api.com,
   snippets, quicklinks and user commands from <home>/capsule/snippets.json. Aliases and per-command hotkeys (Core/Bindings.swift, Host/CommandBindings.swift,
   <home>/capsule/bindings.json; native-core's settings hub keys can replace the file later). Window
   layouts (Core/WindowLayout.swift, Providers/WindowsProvider.swift) and Return-pastes
   (Host/Paste.swift; Accessibility asked once) are in. `view:` commands (Core/ViewFrames.swift,
   Host/ViewSession.swift, Host/ViewMode.swift, Providers/ViewCommandsProvider.swift, UI/ViewLevelView.swift)
   draw platform's capsule.commands/view/act frames; needs a vyred with those tools (platform-follow 39a3886e).
   Not built: needs-a-credential (host.askCredential) from a `needs` frame, groups within a list, the
   settings hub overrides (native-core). The list above is scope,
   not what works.
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

## 0.2 build: IQ streaming and corrections (C13), work/capsule-02-iq2
Worktree ../vyre-capsule-02-iq, based on main 9381ab15. Landed:
- work/capsule-pro-iq's two code commits (streaming, source chips ⌘1..⌘3, corrections with Undo,
  and the two test-race fixes), merged onto main's newer IQAsk: `context` still goes with every
  ask, the reply's model is `models.quick`, and the IQ line under the answer keeps the assistant's
  mark. The notes-only commit was left out; this section replaces it.
- iq's C13 additions: `memory.draft {id, text}` drawn dimmed with a "Checking" label (the reply
  replaces it; an abstained or limited `memory.answered`, or a failed call, removes it). Stages
  `understand|search|read|answer|check` map to Understanding, Searching your sessions, Reading,
  Writing, Checking; an unknown stage shows nothing new. `context.thread` is the session window's
  thread when it is non-empty, alongside `project`.
- The old non-streaming path (threads.start) is still only for a vyred with no memory.ask.
  A vyred that answers `bad_input` to stream/id gets one plain retry, context kept.
- Tests (FakeVyred): draft frames then the answer, draft removed on abstain, stages mapped and
  another id's or an unknown stage ignored, context carries project and thread, corrections round
  trip. capsule-mac run 36658983627 on 7b366c9b green, Native Capsule tests 393 passed, 0 failed
  (https://github.com/vyre-ai/vyre/actions/runs/36658983627).
- No restyling: the draft reuses Theme.reply/stone/ash; app-design's glass theme will restyle it.

## Speed proof (0.2 item 1)
On CI (macos-latest, every run): scripts/capsule-native-check.mjs types real words a letter at a time
(apps, files, the calculator answer in one frame) and reports the median and 95th percentile from
key to rows against one frame (16 ms), and 10 hide-and-show cycles against 50 ms wake, plus the
hidden footprint (60 MB) and CPU (0.1%). Numbers land in the job summary ("Capsule speed"). A miss
prints OVER and does not fail the run; it is a number to fix.
By hand on the real Mac, only in the separate test account, never the person's own, when the lead says the Mac is
free: log in to the test account, build with `sh local/capsule/native/build.sh app` under the build lock,
then `node scripts/capsule-native-check.mjs local/capsule/native/.build/Vyre.app` for the same numbers
on real hardware and a real display. What a runner cannot show and a person must: (1) the hot key opens
it with no visible lag, (2) typing a word draws rows as fast as you type, (3) holding a key does not
stutter, (4) nothing flickers between keystrokes, (5) hiding and reopening is instant.

## Notes parked (0.2.x)
- Speed, key to first rows: median 21 ms, 95th 52.5 ms on the CI runner (release build, 246 keys, no profiler; the main thread is idle in a profile). Idea not chased: icon-ready callbacks from an earlier key landing in the next key's turn and re-drawing rows. Measure on a real Mac first.
- threads.start and agents.ask carry `mentions` and `pasted` (sessions' work/sessions-start-mentions a257dd5a must land for them to count).
- Text expansion, script commands, AI presets, browser tabs and bookmarks, Focus and Shortcuts, `@` targets from manifests: 0.2.x per the lead.

## Where things stand (session 10, 2 Oct, after the restart)
- rc-0.2.2 (7fe7c97e4 then 9a67fe92b) holds the paired-ask fix. Merged and pushed with the Swift suite passing locally: work/022-at-icons a057d19d8 (536), work/022-deep-glass 1aff8f387 (535), work/022-mac-app 19fb0a0b8 (541). Not yet in the rc: those three branches.
- The rc's capsule-mac run on 04:53 failed in `ScreenAttachTests` (rapid words collapse). That fix is the paired-ask commit 27a086051, which is in the rc now. The run on 7fe7c97e4 was cancelled by a newer push; the run on 9a67fe92b is the one to read.
- #30 ("@" not typing) stays open until the user does step 17 below on the new build. Steps 16 (Deep glass) and 17 (the @ key) are the only new ones since 0.2.1. The signed Mac DMG plan is in team/0.2.2-release/NATIVE-APPS.md, Mac section; it waits for a Developer ID.

## Doing (session 9, 2026-09-30, work/capsule-02-oversight off work/capsule-02-glass 62645bee)
Computer-use oversight panel (capsule-02.html section 11). 2026-10-01: rewired from my proposed hands.plan/step/voice to the real contract on stage (chrome.plan, chrome.step, chrome.voice, chrome.plan.edit, chrome.interject, chrome.pause); before this it could never have opened. Originally built against my proposed hands.* contract
(CHAT.md, capsule-pro -> capsule-sight; capsule-sight has not answered yet). Sources/Extensions/oversight/:
OversightModel (folds chrome.plan/step/voice/paused/resumed/stopped by run, taps -> chrome.pause/resume/stop/
plan.edit/steer, presence:false), OversightView (Bone tokens, Backdrop glass, grip, 6-step window, edit in
place for todo steps, voice line, steer field, Esc stops, small mode), OversightExtension (opens on chrome.plan,
closes on stop or after a 4 s linger when all done, remembers the dragged top-left). Seam additions:
CapsuleHost.floatingWindow(owner:) and SessionWindow.onMoved (defaults keep every fake host compiling);
CapsuleSessionWindow(floating: true) is level .floating, movable by background, non-activating.
Controls whose tool the vyred lacks (pause, edit, steer) are not drawn. Typechecked with swiftc (build lock);
tests in Tests/Oversight run on CI only.
Enrolment handoff (anywhere, ADR 0040 s4-5): Host/CoreEnroll.swift reads the code from fd 3 first thing in main.swift (6 chars A-Za-z0-9 then EOF, else failed; a closed or non-pipe fd 3 is an ordinary launch), core.json under the readCoreConfig rule, socketProblem before any proof, then CapsulePresence.enroll(client:header:) with `code code=<code>`; fingerprint = sha256(SPKI) 16 hex. Tests/CoreEnrollTests.swift with a fake core. Needs the real-Mac run from anywhere's installer.
`#` tags (Core/TagPicker.swift, Host/TagMode.swift): mentions.search {q, limit} as the contract says; the chips ride in threads.send as `mentions:[{kind,id,name}]` only (threads.start and agents.ask carry the #Name token in the text).
Lumen icon and motion: Lumen.icns from docs/design/brand/export (build.sh copies it, CFBundleIconFile), LumenMark in the bar and menu bar, summon arrival in Panel.show, first-launch open in Host/LumenOpen.swift.
Next: CI result, then reviewer-2; adjust to capsule-sight's answer on the contract; Chrome "being debugged"
coexistence needs a real-Mac look (panel opens top right, below the menu bar).

## Earlier (session 8, 2026-09-30, 0.2, work/capsule-02-glass off work/capsule-02-iq2 7b366c9b)
Handed: IQ streaming (work/capsule-02-iq2 7b366c9b, CI green 393/393) to reviewer-2 (unreachable at handoff, notified integrator).
1. Deep glass skin (Sources/UI/Glass.swift, glassSuite): 0.62 tint, border, reduce-transparency fallback. CI run pending.
   Light variant done: Theme colours are dynamic (dark/paper tokens by system appearance), IconCache keys carry the scheme, backdrop material .popover + paper tint 0.66. 395/395 on CI.
   memory.ask drafts now come from the ndjson response (VyredClient.call(onDraft:)); the IQ stage test waits on the stage, not a sleep.
   CI note: TypingPerfTests flicker and StreamPerfTests size-change each failed once on a loaded runner and passed on rerun; layout timing tests are flaky under CI load (not from these changes as far as I can tell).
Next: 2. computer-use oversight panel UI with capsule-sight. 3. the other approved 0.2 screens (capsule-02.html, chat-components.html).

## Doing (session 7, 2026-09-28, 0.1.1 on work/capsule-011)
work/capsule-011 is rebased on stage/0.1.1 e793afdf (the integrator's final P-256 + voice parity).
The user's decisions for 0.1.1, all done; Swift 386/386 (build.sh test, build lock):
1. Offline "Start Vyre" (Host/StartVyre.swift, VyreCLI; `vyre capsule` records cli.json).
   StartVyreTests with FakeVyred and a fake CLI; under tests locate() reads only the scratch record.
2. Avatars: Sources/Core/Avatars + UI/Avatars (byte-identical SVG, JS vectors, ADR 0043's six
   projectBytes vectors), wired into the answer card, memory sources, direct replies, the side view
   and the popover's account row (Host/Identities.swift, system.info once per show).
   Deliberate differences from the JS: V8's cos/sin for 3 angles are stored as a table (libm differs
   in the last bit), and the JS `constructor`/`__proto__` role-lookup quirk is not reproduced.
3. Current project (Host/ProjectContext.swift): session window, then AXDocument's folder, else
   none; the bar chip; memory.ask {question, context:{project}} on stage's non-streaming IQAsk.
4. Models from sessions.models (ModelFallback the one fallback).
5. Option-Space stays.
Plus the reviewer's LOW on 268404c0: pin without nagging (preflight on its own signature, refusal
remembered per process; PinNagTests).
Next: review by team-lead; IQ streaming + corrections are in BACKLOG-0.1.2.

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
   Undo (memory.uncorrect {fix}). via "corrected": the answer with "you corrected this", no chips (known is []; its one source
   {session:"fix:<n>", name:"your correction"} is provenance, never a chip). Card look:
   iq-everywhere.md "The card" (work/memory-iq).
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
banner. About 30 minutes. Everything goes to the user's own address and nobody else. Before
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
10. **An update and permissions.** Update Vyre (the next npm version, or `npm i -g` of the
   branch), then `vyre capsule`. Pass: it rebuilds once ("Building the Capsule") and is still
   `Vyre Local` (step 1's command). Note whether Control twice (step 3) still works or macOS
   asks again. 0.2.0 ships self-signed and says it may ask again; a silent keep is a bonus, and
   a note either way.
11. **Light while hidden.** Leave the Capsule hidden for a minute. Then run
   `footprint $(pgrep -x Vyre) | grep phys_footprint:` and `ps -o %cpu= -p $(pgrep -x Vyre)`.
   Pass: under 60 MB and under 0.1% (CI measured 24 MB and 0.07%).

12. **Speed.** Press Option-Space and type "a", then a word. Pass: rows appear as you type with
   no pause you can see (the runner measures 52 ms to first rows at the 95th percentile). Note
   any visible lag and which letters.
13. **Icon and motion.** The Dock and menu bar show the Lumen lens (Bone, not lime). Opening
   draws the lens in about a fifth of a second. The very first open runs about 1.6 s. With
   Reduce Motion on in System Settings, it appears without the draw-in.
14. **Unlock.** Lock the Vault (`vyre call vault.lock '{}'`), open Lumen, choose a login. Pass:
   Touch ID or the Mac password card opens, and a correct entry fills the login. A wrong
   password says so and keeps the card.
15. **Oversight and voice** (needs stage with the platform, vault and assistant branches).
   Start a computer-use task from an agent. Pass: the oversight panel opens top right with the
   plan first, can be dragged, takes a typed note, and Esc waits for the current act. A spoken
   reply plays from a mic turn.
16. **Deep glass.** Reduce Transparency must be off (System Settings, Accessibility, Display). Put a window that is white on one half and black
   on the other behind Lumen (any two apps side by side will do), then open Lumen over the line. Pass: the panel's left half is visibly
   lighter than its right half, text stays readable on both, and the edge reads as glass. Turn Reduce Transparency on: the panel becomes
   one flat dark (or light) colour and the halves match. GitHub's runner has Reduce Transparency on, so only the flat colour is checked there.
17. **The @ key (#30).** On the new build, with your own keyboard layout: open Lumen, type `@`, then `@ki`, then clear the box and type `#`,
   pick a tag with Return and type `@` after it. Pass: the `@` character appears every time. Write down the layout and the Lumen version.
   #30 stays open until the user has done this once.

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

## Session 5 (28 Sep, after the usage-limit relaunch)

Queue items from the lead: (1) the presence key to Secure Enclave P-256; (2) a live Mac check of
8cf64fe9; (3) voice parity with native-core's tap-to-talk.

1. DONE, work/capsule-pro ee415954: Presence.swift's key is now a Secure Enclave P-256 key with
   kSecAccessControlBiometryCurrentSet (never Ed25519 in the login keychain again), matching
   e2e2's reviewer-cleared verifier (work/e2e-capsule-p256, 9bfc452e) -- ES256/DER, SPKI via
   CryptoKit's own derRepresentation, alg -7, the unchanged vyre-presence-v1 message. Also folds
   in e2e2's two review asks from their agreed-format note (docs/work/e2e.md, 28 Sep): header()
   now returns nil rather than a header with an empty sig when the key fails to sign, and enroll()
   refuses outright on a Mac with no Touch ID enrolled rather than making a key that could never
   sign. header()/proof() are typed over a small internal CapsuleSigningKey protocol so tests
   still use a plain in-memory P256.Signing.PrivateKey (no hardware needed). Swift 407/407.
   MUST land in the same batch as 9bfc452e (server-side P-256-only enroll) -- landing either
   alone breaks the Capsule's presence.
2. DONE, work/capsule-pro-livemac bdece731 (worktree ../vyre-capsule-pro-livemac, off
   work/e2e-setsid since that is where 8cf64fe9 lives, not yet on main): a live test
   (test/peer-live-mac.test.js) drives presence.capsule.pin over a REAL vyred unix socket from a
   REAL throwaway ad-hoc-signed process, so vyred's own codesign -dvvv +pid read is what refuses
   it, not an injected fixture (peer.test.js's own version). Off by default; needs
   VYRE_ALLOW_MAC_TESTS=1 and VYRE_NO_DIALOGS=1 on a real Mac. NOT built: "a real signed build
   passes" and "a mismatched fingerprint on a signed build is refused" -- both need a
   non-ad-hoc-signed throwaway binary, and three different ways to get codesign to accept a fresh
   self-signed cert without the person's real login keychain all failed with "no identity found"
   until the cert has Trust Settings; getting Trust Settings always writes the person's real
   per-user trust store (confirmed: the `-k <keychain>` flag only says where the CERT lives, not
   where the trust decision is recorded) AND raises a real interactive authorization dialog
   (confirmed: a non-interactive run hit the OS's own ~3.5s auto-cancel). This is a genuine gap,
   not a workaround-and-move-on: it needs either a real Apple Developer ID identity set aside for
   CI, or vyre-core's own code-signing key (ADR 0040 section 4) once that lands. Flagged for the
   lead rather than decided here.
3. NOT STARTED: voice parity with native-core's tap-to-talk (e21c019d). Next up.

## Follow-ups from the reviewer on ee415954 (28 Sep)

- DONE, work/capsule-pro (this session): proof()'s re-enroll path now removes the old key's
  presence_keys row (presence.remove, signed with the just-made key, best-effort, never a second
  Touch ID) once the new one is enrolled -- the LOW, dead rows no longer pile up.
- RESIDUAL, named not fixed (fixed by ADR 0040 section 4, not here): the keychain item holding the
  Secure Enclave handle has an ACL that is not bound to the app while the Capsule is ad hoc signed.
  A same-uid process can still read the handle and ask the enclave to sign with it, which raises a
  REAL Touch ID sheet with its own reason text -- a phishable prompt, though it needs a human tap
  to succeed (far better than the old Ed25519 key, which needed no human at all). Closes only once
  vyre-core signs the Capsule and the ACL binds to that designated requirement.

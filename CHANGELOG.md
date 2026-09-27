# Changelog

Newest first. Every change to code lands here in the same commit. A new dependency says why.

## Unreleased

#### Esc takes back a queued message in the native Capsule

- Esc on a reply queued for a terminal-busy session calls `threads.unqueue` with the send's
  `queued_id` ("Taken back. <name> never got it."); handed over, Esc only stops following and
  never calls threads.stop; a hand-over racing the key says "Too late" once (capsule-now rule 8).
  `local/capsule/native/Sources/Host/CapsuleModel.swift` `stopReply`, `takeBack`;
  `Vyred/State.swift` QueuedSend `id`, `withdrawn`; `UI/CapsuleView.swift`. Test in
  Tests/CapsuleModelTests.swift.

#### No orange in the Capsule

- Beacon orange is gone from both Capsules. Things that need you (the held glyph in results, Kit's
  tint, formerly `Tint.beacon`, now `Tint.attention`) are violet #B8A4FF. Errors and status lines
  (Stopped., failed turns and tools, the sight panels' status) are neutral: Stone text, a crossed
  circle and a word. A destructive action's confirm line is Bone. `local/capsule/native/Sources/`
  UI, Kit, Providers/IconCache.swift, Extensions/sight; `local/capsule/app/capsule.css`, `capsule.js`.

#### The Capsule tells `vyre doctor` why Control twice is off, and waiting is violet

- The native Capsule calls capsule.report once after its hot keys start and again only when
  Control twice turns on or off (asked for from the menu, or a tap macOS turned off for good). The
  message names the cause and the chord that still works, for example "Input Monitoring is off,
  so Control twice is off. ⌥Space still opens the Capsule." A report vyred missed goes again when
  it is back. `local/capsule/native/Sources/Host/HotkeyReport.swift`, `Host/Hotkeys.swift`.
- "Waiting on you" is violet (`Theme.attention`, #B8A4FF), as on the Deck and the phone: the list
  label, dots, selected bar, source label, the hint under an empty box, and the menu-bar mark's
  dot. The Electron Capsule's waiting label, dot, badge and tray dot match (`--attention`).

#### The box's alarms and reminders ring on the Mac

- The native Capsule keeps /v1/link/events open (hidden too: a timer on the box has to ring
  here) and shows one banner per `planner.fired` firing, top right, with Done and Snooze; a later
  ring replaces its banner, `planner.acked` from any device removes it, and one that fell due
  offline says "Missed". Done and Snooze call planner.done and planner.snooze through vyred, or
  link.call when this vyred does not carry the planner. On connect, planner.ringing shows what is
  already ringing. `local/capsule/native/Sources/Host/Planner.swift` (ADR 0025).

#### `vyre capsule install` builds; nothing is downloaded

- The Vyre-mac.zip download is retired. `vyre capsule install` now builds the native Capsule on
  this Mac (the same local build `vyre capsule` runs, with the signing-identity offer) without
  opening it. `core/cli/commands/capsule-install.js` and its tests are removed, as is the
  `box/Vyre-mac.sha256` pin.

#### Memory as one line, and answers that read calmly

- Memory shows one answer line or nothing: the answer, a three-bar cue for how sure memory is,
  and "from N conversations"; the sources fold away behind a click or ⌘→. Loosely matching
  quotes with no answer are not shown. Ready for memory.answer (`MemoryAnswer.conversations`);
  said.js ranking stays the fallback.
- Replies are labelled with the assistant's name from onboarding (agents.list), "Vyre" when
  none is named, or the agent's or session's name; never a model's brand. The quick rows read
  "Quick answer" and "Deeper answer", sending to the assistant's name.
- Once an answer is in, it takes the whole area and scrolls; memory's sources fold into "from 2
  of your sessions" under it; the footer says "Follow up ⏎ · Copy ⌘C · Deeper ⌘D" (⌘D is new).
- Queries under three letters match only by prefix, word start or initials, as in Spotlight.
- The typing timings are a warning, not a failure, on CI.

#### Attachments on a send, for "with your screen"

- Kit: `SendAttaching`, `SendAttachment` and `SendTargetKind`. An extension may offer something
  to go with words headed to an agent, a session, a project or a quick Ask; the Capsule shows it
  as a chip in the bar, ⌘⌫ or its x leaves it off for this send, and what is still on screen is
  appended to the words (to a quick Ask's instructions, so the prompt stays the user's words).
  For capsule-sight's screen context.

#### Send a file to the box from the native Capsule

- A file row has "Send to box" (⌘S, shown in the footer) when vyred has `files.send`: Taildrop
  to the paired box's inbox. vyred's guard decides what may leave, and its refusal is shown in
  its own words. ⌘S rather than Option-Return, which is sight's talk chord now.

#### Touch ID in the panel, banners, and the menu-bar popover

- Human-only calls from the native Capsule (ADR 0004, method `capsule`): the panel shows
  "Confirm it's you" with the exact words and Touch ID drawn inside it (LAAuthenticationView;
  the Mac's password where there is no Touch ID), then signs the call with the Capsule's
  Ed25519 key. The key is made once, kept in the login keychain for the Capsule alone, and
  enrolled with vyred's own Touch ID dialog. Esc cancels; nothing is done. Checked against
  core/presence in Node: same canonical input, same hash, signature verifies.
  `Sources/Host/Presence.swift`, `Sources/UI/PresenceView.swift`.
- An answer that lands while the Capsule is hidden is a banner, top right
  (UNUserNotificationCenter; macOS asks once, the first time there is one, never in tests).
- The menu-bar mark carries a health dot (signal: vyred up and the box direct; recall: the box
  through a relay; ash: vyred not running), and a click opens a popover with the same words
  and the Capsule's actions; right-click keeps the plain menu. Nothing is polled: vyred's state
  comes from the follower, the box's from link.health on open, at most once a minute.
- `VYRE_CAPSULE_HEADLESS=1` runs the app with no hot keys and no menu-bar item, for footprint
  checks: 16.1 MB physical footprint hidden (RSS 80 MB, most of it shared system libraries).
- The contact-photo icon test drew its red in a colour space with no components; fixed.

#### Extensions can be named with @

- `CapsuleExtension.mentions(matching:)` and `send(_:to:query:)`: an extension lists targets
  ("Notes", "Slack #general") for the words after `@`; they follow Vyre's own agents, projects
  and sessions, become the chip when picked, and Enter sends through the extension, which says
  what happened. For capsule-apps. `Sources/Kit/Extension.swift`, `Sources/Host/ExtensionHost.swift`.

#### The native Capsule's design pass

- Rows are inset and rounded; the selected one is a raised plate with the signal pill at its left
  edge, easing in over 90 ms. Symbols sit on small tiles so they line up with app icons (26 pt,
  32 for the top hit). App rows show only the name; every row says what it is at the right
  ("Application", "PDF document", "Command"). The top hit is larger, and a calculator answer is
  a card with the number in large rounded figures; Enter copies it.
- A footer under the results says what Enter does ("Open ⏎"), the count, and the Capsule's
  one-line notes and confirm questions. The destination in the bar is a small chip.
- `@` rows are headed "Send to", and a session live in a terminal carries a signal badge. The
  chip for a picked destination is a capsule with its icon.
- The answer reads You and the question, then who answers (a breathing signal dot while it
  works), the memory box with a recall rule down its side and quotes as quotes with who said
  them, then the answer with room to breathe; an answer alone scrolls in the whole area.
- The panel fades in over 110 ms. `Tests/SnapshotTests.swift` draws each state to PNGs off
  screen (VYRE_CAPSULE_SNAP=<dir>).

#### The session window for sight's side view

- The Capsule-owned session window becomes key when its field is clicked, draws nothing under
  the extension's view (its vibrancy shows), and moves on a curve the extension picks
  (`setFrame(_:duration:curve:)`, ease-out for a slide in). `host.commandsChanged()` lets an
  extension say its commands changed while the Capsule is open.
- capsule-sight is merged in: the side view, the session panel and push-to-talk run in the
  native Capsule. The native Capsule's ADR is 0017 (0015 is capsule-sight's).
- The typing check asserts its timings only on the optimised build.

#### @ finds sessions by their whole name

- After a leading `@` the whole text is the name ("@computer use settings"), matched without
  case, by prefix or by the start of each word; when the whole text names nothing, fewer words
  are tried and the rest stays as the message ("@juno rebuild the menu"). Claude Code sessions
  from `projects.catalog` are candidates, the recent ones read on show and older ones searched
  by name as you type; one active in the last 15 minutes that vyred does not run is marked
  "live in terminal" and listed first. The memory box stays quiet while the text starts with
  `@`. Picking a live session makes it the chip, and Enter queues the message for it.

#### A stable signing identity for the Capsule, with consent

- On the person's own install only (the real ~/.vyre, dialogs allowed, a terminal), `vyre
  capsule` asks once: "macOS keeps the Capsule's permissions only if every build is signed the
  same way. Create a local signing identity in your login keychain? macOS may ask for your
  password once." Yes makes a self-signed "Vyre Local" code-signing identity (openssl, then
  `security import` for codesign and `add-trusted-cert` for code signing), removes the temp key
  files, and rebuilds the app signed with it. No keeps ad hoc signing and says permissions may
  need granting again after an update. The answer is kept in `<home>/capsule/signing.json`.
  Never asked in tests or temp homes. `core/cli/commands/capsule-native.js`.

#### Typing into the native Capsule no longer jumps or flickers

- The area under the bar has one fixed height while anything is shown there, as Spotlight's
  does, so results, memory and answers arriving in waves never resize the panel mid-word (14
  size changes over 20 keys before, 0 after).
- Apps and settings answer in the keystroke's own frame (`ImmediateResults`), and slower
  providers keep their rows until their new ones land (or 300 ms pass), so rows no longer blink
  out and back (7 flickers before, 0 after). Rows redraw only when what they show changes.
- `Tests/TypingPerfTests.swift` types 20 keys into an off-screen panel with results in waves and
  checks keystroke-to-paint p95 under 16 ms (7.9 ms, optimised build), no size change while
  typing, no flicker, and no main-thread pass over 16 ms (longest 10.3 ms).

#### The native Capsule loads extensions

- The host makes each extension build.sh registers and routes to it: its rows and commands in
  the list, chords with Option or Control while the panel is key (Option-Return is sight's
  talk), its side panel beside the list, and show and hide. `Sources/Host/ExtensionHost.swift`.
- `VyredLink.stream(path:onMessage:onClose:)` opens a WebSocket to a vyred stream as the
  capsule caller, so an extension needs no socket code of its own. `Sources/Vyred/Stream.swift`.
- `CapsuleHost.sessionWindow(owner:)`: the one Capsule-owned window an extension may use, for
  the side view's session panel, animated by the Capsule. `Sources/Kit/Extension.swift`.

#### The native Capsule reads memory and queues for a busy session

- Typing three letters or more asks memory (memory.relevant and recall.search) a moment after
  the last key. What answers sits above the results as the memory box: the fact first, then
  quotes as quotes ("You said, 2 weeks ago: ..."), ranked like `lib/said.js`, with the question
  echoed back and the Capsule's own threads left out. A quick question carries those lines,
  and only those, in its system-prompt append. Rules 1, 2 and 7 in docs/work/capsule-now.md.
  `local/capsule/native/Sources/Vyred/Said.swift`.
- The reply reads You, then who answers and its state, then the memory box, then the answer. A
  notice from vyred is one faint line under it, never part of the answer (rules 3 and 4).
- `@` names an agent, project or thread (the catalog is read once per show), and it becomes a
  chip. A thread busy in a terminal gets the message queued: the Capsule shows vyred's note and
  "Queued for <name>", then "Handed over" when the Harness passes it on. Esc only stops
  following it (rule 5). `Sources/Vyred/Catalog.swift`, `Sources/Host/CapsuleModel.swift`.

#### The native Capsule, built on first run

- `vyre capsule` on a Mac now opens the native Swift Capsule (ADR 0017). The first run builds it
  with swiftc into `<home>/capsule/Vyre.app` (about 35 s), signs it (with a "Vyre Local" identity
  when the keychain has one, ad hoc otherwise) and launches it; it rebuilds only when its source
  changes. Without the Command Line Tools it says, in one line, to run `xcode-select --install`.
  `--electron` (or `VYRE_CAPSULE=electron`) runs the Electron Capsule until it is retired.
  `core/cli/commands/capsule-native.js`, `capsule.js`.
- The app: a non-activating panel at Spotlight's size and place (680 wide, 56 px bar, results
  grow down, top edge 22% down the screen) that opens over a full-screen app on its Space. Apps,
  files, settings panes, dictionary, calculator, Mac commands, and Ask with the reply streamed
  under the bar. Hot keys: ⌥Space with no permission, Control twice once Input Monitoring is
  allowed (asked only from the menu-bar item). `local/capsule/native/Sources/Host`, `Sources/UI`.
- Fixed a race in the apps scan: a waiting refresh now waits out a scan already running.
#### The screen chip in the Capsule's box

- capsule-sight: SightExtension adopts capsule-pro's `SendAttaching`. An Ask, a message to an
  agent or session, or a new project thread whose words point at the screen (or with text
  selected in the app in front) shows "with your screen: <app> · <window>" in the bar, with the
  app's icon; Command-Backspace or the x removes it, and the context goes only if it stayed.
  Questions wait 150 ms for the words to rest and a newer one answers the older ones; hiding
  cancels them. Blind places, secure fields and a failed read give no chip.

#### Side view and voice from the terminal (ADR 0015)

- Side view on macOS (`local/sideview`, `vyre sideview`): the front terminal session on the left at
  29% of the display and Chrome filling the rest, edge to edge, in one call; `--glass` opens the
  box's Glass page; `vyre sideview close` puts the windows back. The helper runs once per call and
  never moves a password manager or a system dialog.
- voice: `vyre voice` gives push-to-talk from the terminal (Enter to talk, words shown live,
  `--send <thread>`), `vyre voice key` saves the speech key through the vault as a person without
  echoing it, and `vyre voice status` prints the provider, key and online state.
- hands: `hands.find {app|pid, window, role, name, near, limit}` and a `match` filter on
  `hands.observe` pick controls by role, label and nearness from up to 500 read, without walking
  the whole list. `settleMs` is clamped to 5000. A key to an app in the background is refused
  with `needs_front` (held or committed) instead of vanishing; hands never raise an app.
- capsule-sight: screen context on an Ask. Words that point at the screen ("summarize this",
  "what's this error", "reply to this", "translate to French") or a selection in the app in front
  get the app, window, URL, selection and a trimmed excerpt of the visible text attached, shown
  first as a chip "with your screen: <app> · <window>" that its x or Command-Backspace at the start
  of the box removes. Blind places get no chip, password fields leave their value out, and
  token-looking URL queries are dropped. Live in the session panel's prompt; the Capsule's box
  gets it through `SightExtension.screenAttachment(for:)` once capsule-pro's send path asks.
- capsule-sight: the session panel slides in ease-out and out ease-in; its tabs and the "Side
  view: <name>" rows follow session starts and stops (host.commandsChanged, no polling); live
  terminal sessions get a tab with their history from the recall index, marked as possibly a few
  seconds behind, and a prompt that queues through threads.send.
- capsule-sight: the session panel. "Side view" slides the Capsule's own window in at the left
  29% of the display with the assistant (or "Side view: <name>" for any session): tabs, the
  conversation live from its events, a prompt that sends, the mic (Option-Return) and a status
  line. Chrome or the box's Glass is fitted beside it through the new `sideview.open` `panel`
  input, which moves only Chrome. "Close side view" slides it out and puts Chrome back.
- capsule-sight: the sight extension for the native Capsule (`Sources/Extensions/sight`): Side
  view, Side view with Glass and Close side view; Ask about my screen, with a side panel and the
  window put in the box, blind places shown as off limits; Option-Return push-to-talk through
  vyre-mic and the voice listen stream, words live in the box, stopped when the Capsule hides.
  `voice.status` returns the built mic helper's path. Push-to-talk opens its stream through
  `VyredLink.stream`, the Capsule's own WebSocket client.
- screen: the fake-helper tests pass `platform: "darwin"` so they run off the Mac.

#### Docs: the planner page

- docs/using/planner.md (draft): alarms, timers, reminders, todos and notes from the terminal and
  the Deck, answering a ring, the lock-screen label, what agents may do, connected calendars,
  settings. ADR 0025 gains front matter and joins the nav; the reference pages are regenerated.

#### Push: a planner notification closes everywhere once answered, and an opt-in lock-screen label

- core/push sends `{ kind: "planner-ack", tag: "planner-<firing>" }` to every device when a
  firing it pushed is acknowledged anywhere (done, snooze, dismiss, a deletion), once per firing,
  at normal urgency, with nothing to show; the service worker closes that tag.
- push.settings `planner_label` (off by default) adds the item's own words as the planner
  notification's `body`, for the lock screen. Off, nothing the user typed is in the payload.
  Tests in core/push/push.test.js.
- deck/sw.js (pwa owns it; the smallest change): a `planner-ack` push closes the notification
  with that tag and shows nothing, and a push's `body` is shown when present. Test in
  deck/test/pwa.test.js.

#### The planner: anyone adds alarms, reminders, todos and notes; one parser, answered on the Mac

- Agents now add alarms and timers as well as reminders, todos and notes, with no prompt. The
  person edits, completes, snoozes and deletes anything with no prompt; an agent changes only
  what it added (planner.snooze, planner.dismiss and planner.delete are open to agents for their
  own items). Agents still never add events. Items carry `added_by`, the agent's name, when an
  agent other than the person's assistant added them; planner.added, planner.fired and
  planner.ringing carry it too, and the Deck panel shows "from kit". Migration 3 adds
  planner_items.source_name. A silent guard refuses one agent's 201st add in an hour (`busy`).
- A paired Mac forwards an agent's call with `as { source, name }` so the box applies the agent's
  rules; `as` is honoured only on a person's call. The Mac no longer checks before forwarding.
- planner.parse returns `{ kind, title, at (ms), tz, duration?, repeat? }`, `{ ambiguous, reason }`
  or null, takes a `kind` hint, and answers on the Mac without the box. parse.js holds the apps
  router's time rules and its test cases as fixtures (current minute, tonight at 12 and 1 to 4,
  today after 09:00, trailing please). planner.add with text refuses ambiguous words with the
  reason (code `ambiguous`); a reminder for the current minute is no longer "already passed".

#### The planner's calendar: Google copies, event reminders, busy time, and events through the Gate

- planner.calendar.sync reads connected Google calendars through google.calendar.list (never a
  token), a day back to 14 days ahead, into planner_calendar: new and moved events are added,
  cancelled ones dropped, a failing account keeps its copy, a removed account's events go. It runs
  every 15 minutes as a scheduler wake hook while any account is connected, and on google.added /
  google.removed; with no account it never runs.
- Each timed calendar event rings event_lead minutes (10) before it starts, as planner.fired kind
  event with account and start; once per event and start, whatever the resyncs. All-day events do
  not ring. done, snooze and dismiss work on these rings.
- planner.agenda entries carry source (planner or the account name), start, end, all_day, where,
  url; `busy: true` returns merged busy intervals; `next: n` the next n entries.
- planner.calendar.create: without account the planner's own event; with account it calls
  google.calendar.create, where attendees are held at the Gate. Agents may only ask for an invite.
- Migration 2 adds next_fire, rung_start and snooze_until to planner_calendar and where_ to
  planner_items. Tests in core/planner/calendar.test.js.

#### The planner in the Deck: a minimal panel at /planner

- deck/views/planner.js: Agenda (planner.agenda, today), Alarms (the next five alarms and timers,
  and an add box that sends planner.add { text }), Todos (open, a checkbox calls planner.done
  { item }) and Notes (pinned first). planner.fired shows one banner per firing with Done and
  Snooze (planner.done / planner.snooze { firing }); planner.acked removes it. /planner/<firing>,
  where a push notification opens, shows that firing's item on top. No polling: planner.* events
  redraw only while the page is visible. Routes added to deck/js/app.js. Tests in
  deck/test/planner.test.js.

#### The planner from the terminal: vyre alarm, timer, remind, todo, notes, agenda and snooze

- `vyre alarm 7am`, `vyre alarm 6:30 weekdays`, `vyre alarm` (upcoming), `vyre alarm off <id>`;
  `vyre timer 10m [label]`; `vyre remind "call juno" at 6`, `vyre remind me in 20 minutes to
  check the oven` (words the parser cannot place say so, and nothing is added); `vyre todo`
  (open todos by list), `vyre todo add buy flour !high`, `vyre todo done <id>`; `vyre notes`
  (pinned first), `vyre notes add <text>`, `vyre notes show <id>`; `vyre agenda [tomorrow|
  YYYY-MM-DD]`; `vyre snooze <id> [minutes]`. Times print in the planner's zone. --json on all.
  A "Time and lists" group in `vyre help`. Tests in core/cli/commands/planner.test.js.

#### The planner: alarms, timers, reminders, todos and notes kept on the box (ADR 0025, slice 1)

- New core module `planner` (core/planner, both roles). Tools: planner.add, list, get, update,
  done, snooze, dismiss, delete (soft, restorable for 30 days), agenda, parse and settings.
  Events: planner.added, changed, removed, fired and acked. No new dependency: zone math is Intl.
- Time is UTC plus a zone. Repeats (day, weekday, week with days, month, year, interval, until)
  keep their wall time in their zone, so a daily 07:00 stays 07:00 across DST; a skipped 02:30
  moves forward and a repeated 01:30 takes the first. Alarms and timers are floating and follow
  planner.settings timezone; reminders and events stay in the zone they were made in.
- One unref'd timer to the earliest fire, escalation or wake hook, capped at 6 hours, none when
  nothing is due; a clock jump over 60 s is logged and everything recomputed. At start, what fell
  due while vyred was down rings once, marked missed (a repeat once, for its latest time); a day
  stale is kept as missed without ringing. An unacknowledged firing rings again every
  escalate_after minutes (5), escalate_max more times (3). The first done, snooze or dismiss wins.
- Agents (mcp, module, harness) may read and may add, change and finish todos, reminders and
  notes; alarms, timers, events, snooze, dismiss, delete and settings are for people's surfaces.
- A Mac paired with a box forwards every planner tool to the box and keeps its scheduler idle; an
  agent's limits are checked on the Mac first. An unpaired Mac runs the planner itself.
- push: planner.fired becomes kind `planner` with a fixed title per item kind (Alarm, Timer
  finished, Reminder, Starting soon, Todo due), path /planner/<firing>, tag planner-<firing> and
  actions done and snooze, at high urgency. The label never crosses the push service. Alarms and
  timers ring through quiet hours; reminders and todos wait.
#### `vyre capsule install` builds the Capsule on the Mac

- vyre.run no longer serves `Vyre-mac.zip`, so the download would have failed. `vyre capsule
  install` now runs `vyre capsule build --app` (Electron into local/capsule, the helpers, an
  ad-hoc signed Vyre.app) and downloads nothing; `vyre capsule` opens that build.
  `capsule-install.js`, its test and `VYRE_DOWNLOAD_BASE`/`VYRE_APPS_DIR` are gone (capsule-pro's
  native build replaces this path when it merges). docs/using/capsule.md and
  docs/get-started/install.md say so; the reference is regenerated.
#### The box reads a Mac session as blocks

- `recall.transcript` on the box, for the person, reads a session the box does not have from the
  paired Mac (or any session with `source: "mac"`), labelled `source: "mac"` and `machine`, so a
  Mac reply keeps its rich view after the re-read. Nothing is stored on the box. An id no machine
  has is still `not_found`; an away Mac says so. `recall.transcript` joins the link's read
  allowlist (core/link/allow.js), and agents and MCP still never get it. Test:
  test/federation-reads.test.js.

- The Mac installs from npm and `vyre capsule` builds the Capsule there, so `build-site.sh` and
  `release.sh` no longer build, upload or redirect to `Vyre-mac.zip`. `/download/mac` still
  redirects to `/start#mac`. `site/_redirects` is generated and no longer tracked, and the dirty
  stamp in build.json ignores the files build-site writes, so running it twice on a clean checkout
  says `dirty: false`. `release-check.sh` asserts both redirects, that nothing names the zip, that
  `/start` is served as committed, and that the install has no node_modules. The docs
  screenshots stay out of the npm package (`!docs/**/*.png`; the docs site serves them), which
  brings the install from 11.4 MB to 8.9 MB, under the 10 MB cap again. `vyre capsule install`
  still fetches the zip until capsule-pro retires it.

#### Chat starts sessions, browses the box's folders, opens a terminal, and asks real questions (ADR 0024)

- Chat has New session (header, rail, empty state, key `n`): pick a project, a folder on the box or
  no folder, pick Vyre or an agent, type the first message. A folder browser lists recent folders
  first, then the box's folders, with search, "New session here" and "Open in terminal"
  (files.dirs, files.recent, through the files guard).
- A terminal in the browser: core/term runs a login shell under `script` (no native dependency),
  over a ticketed WebSocket, with xterm 6.0.0 vendored in deck/vendor/xterm (MIT). Opening one
  needs no passkey, and only the screen that opened it can reattach. A terminal ends 10 s after
  its last viewer leaves, and nothing it prints is logged.
- The session view reads the transcript (recall.transcript, new): tool calls as cards with
  command, output, duration and status, edits as diffs, reads as previews, todo lists as
  checklists, thinking folded, time and tokens per turn, and a Raw toggle that prints it the way
  the terminal does. Replies read "Vyre" (or the agent's name), and your messages read "you".
- Claude Code's questions (AskUserQuestion) are asks of kind `question`, answered from a card:
  options, multi-select, Other, previews side by side, arrow keys and number keys.
  threads.answer takes `answers`. Permission asks carry what exactly will run (`detail`) and
  offer Always for this (decision `always`, when Claude Code suggests it). Answering needs no
  passkey or Touch ID: `threads.answer` left the floor's human-only list for a new `PERSON_ONLY`
  list (with `term.open` and `term.attach`), which asks no proof but which the harness still
  refuses to a model's shell (core/presence/index.js, core/harness/rules.js).
- Permission asks for Edit, MultiEdit, Write and a plain `git push` carry a diff summary in
  `detail.changes` (file, added, removed per file) and `detail.totals` (files, added, removed).
  Edits count lines from their full input, a Write is compared with the file on disk, and a push
  runs `git diff --numstat` over what is ahead of `@{push}` (else the upstream, else origin's
  default branch) with no shell, no network and a 3 s budget. Binary files are counted as files
  with `binary: true`, and a push keeps 200 rows (`truncated: true`). ask.raised stays small.
  offer Always for this (decision `always`, when Claude Code suggests it).

#### Find shows which sessions are the Mac's

- The phone's Find page puts the machine chip beside a Mac session's title, in search results,
  Recent and the "Type into" list, outside the title's ellipsis so a long title never hides it
  (deck/views/find.js, deck/css/views/find.css). The files note no longer says Mac files show
  when the Mac is online: the box does not search the Mac's files, so it says that.

#### The box's words wait for whoever holds a Mac session

- The person at the box never takes a Mac session's keyboard. While another surface on the Mac
  holds it (the Capsule, say), `threads.send` queues the words as it does for a terminal, and
  answers with `busy` (`"terminal"` or the holder). The box's note names the Mac: "<name> is busy
  in your terminal on alex-mac." The link's caller `link:box` is a caller kind of its own
  (`fromLink` in core/switchboard/index.js): it queues, is no agent, and its surface is always
  `box:<surface>`. A queued message from the box reaches Claude as "via the Deck on the box"
  (core/harness/index.js). Decided with capsule-now. Tests: test/federation-send.test.js,
  core/switchboard/switchboard.test.js.

#### The person on the box types into a Mac's session

- `threads.send` on the box, for a thread only a paired Mac has, goes to that Mac for the
  person's own callers (the Deck, the terminal, the Capsule, the owner over the tailnet); `machine`
  picks one Mac. The answer is the Mac's, plus `source: "mac"` and `machine`; a Mac that is away
  answers `mac_offline`, "<name> is offline; your message was not sent". Agents, MCP, guests and
  modules never reach a Mac (core/switchboard/index.js).
- The link carries one write: `WRITE = ["threads.send"]` (core/link/allow.js), only with
  `as: "person"`, checked by the box before queueing and by the Mac before running. The Mac runs
  it as `link:box` with the surface `box:<surface>`, so a session busy in a terminal queues the
  words and hands them over at its next Stop (core/link/mac.js, core/link/box.js).
- The Mac follows that thread's events and sends them to the new box tool `link.events` at most
  every 250 ms while they flow, until the answer finishes (a finish while queued words wait does
  not count), 30 minutes pass, or the link ends; the box re-emits them with `source: "mac"` and
  `machine` for threads it sent to, from the Mac it sent to.
- `ctx.call(tool, input, { as })` calls as another caller label only for a core module and only
  a label the registry's fixed map gives it (today the link, as `link:box`). A manifest cannot
  grant it, so a module installed into a home can never act as the person (core/modules/index.js).
- Tests: test/federation-send.test.js. Decision: ADR 0021, "Sending to a Mac session".

#### The Deck on a box with a paired Mac, in a browser

- `deck/test/mac-world.js`: one process runs a box vyred (harlow-box) and a Mac vyred (alex-mac)
  in temp homes, paired through the link seams and a simulated tailnet (test/link-harness.js),
  with the fictional corpus split between them, and serves the box's Deck on 127.0.0.1.
  `POST /__mac/off` and `/__mac/on` stop and start the simulated tailnet, for the offline chip.
- `deck/test/mac-shots.js`: shots of Chat, a Mac session, Now, search, a project board with a
  picked Mac session, onboarding history and the offline chip, at 1440x900 and 390x844, through
  a running Chrome (CDP); each asserts its chip or note, no sideways scroll and no page errors.
- `pair()` in test/link-harness.js takes `boxName`, `macHost`, `heartbeat`, `boxConfig`, and
  `macTranscripts` as a list of sessions, and needs only `name` and `after` from its context.
#### Streams over the tailnet are the owner's alone

- The tailnet listener hands a WebSocket (`/v1/streams/...`: the terminal, Glass's screen) to
  vyred's stream router only for the owner. A guest and an agent's node are refused with 403,
  whatever tools they hold (`core/names/service.js`). The onboarding loopback now takes upgrades
  itself: a Host that is not a loopback name gets 421, no session gets 403, and past both it
  still opens no stream (`core/onboard/loopback.js`). Tests: owner allowed, guest and agent node
  refused (`core/names/service.test.js`), wrong Host and no session on loopback
  (`test/onboard.test.js`).

#### Taking over an agent's computer asks for no passkey

- The owner's take-over, hand-back and Sign in privately in Glass no longer ask for Touch ID or
  a passkey (Touch ID stays for pairing, vault secrets, and sending, posting or paying outside).
  `computers.takeover` and `computers.giveback` leave the floor's list; they, `glass.take` and
  `glass.release` are on a new `PERSON_ONLY` list in `core/presence/index.js`. An agent is still
  refused by the tools, a tailnet guest by the registry (`core/modules/index.js`), and Claude's
  sessions by the harness (`core/harness/rules.js`). The Deck's "Confirm it's you" step is gone
  (`deck/glass/takeover.js`). Tests: core/computers/computers.test.js, core/glass/glass.test.js,
  core/harness/floor.test.js. ADR 0004 and 0005 amended.
#### Every Claude Code session knows the user

- `core/about`: keeps `<home>/about.md`, a few lines on the user (name, assistant, busiest projects
  and their people, and memory's `memory.profile` lines of kind work, place or preference; never
  people, vehicles or clients), under 600 characters,
  with anything shaped like a credential, email or phone number dropped. Tool `about.text`.
- The SessionStart hook reads that file and adds it ahead of the project brief, also with vyred
  down. An agent scoped to some projects does not get it.
- `/vyre todo`, `/vyre remind <when> <text>`, `/vyre agenda` (the planner's `planner.add`,
  `planner.list` and `planner.agenda`; the planner reads the reminder's time) and
  `/vyre remember <fact>` (memory's `memory.remember`; a lesson where it refuses). Making a lesson
  moves from `/vyre remember` to `/vyre lesson <rule>`.
- The MCP server's instructions: back a promised reminder with `planner_add`, ask `memory_answer`
  before saying you do not know.

#### The site has no Capsule zip, and a clean checkout stamps clean

- The Mac installs from npm and `vyre capsule` builds the Capsule there, so `build-site.sh` and
  `release.sh` no longer build, upload or redirect to `Vyre-mac.zip`. `/download/mac` still
  redirects to `/start#mac`. `site/_redirects` is generated and no longer tracked, and the dirty
  stamp in build.json ignores the files build-site writes, so running it twice on a clean checkout
  says `dirty: false`. `release-check.sh` asserts both redirects, that nothing names the zip, that
  `/start` is served as committed, and that the install has no node_modules. The docs
  screenshots stay out of the npm package (`!docs/**/*.png`; the docs site serves them), which
  brings the install from 11.4 MB to 8.9 MB, under the 10 MB cap again. `vyre capsule install`
  still fetches the zip until capsule-pro retires it.

#### A box built from vyre.tgz ships the files in it, not stale ones

- npm pack pins every mtime to 1985, and BuildKit's context sync skips a changed file whose size
  and mtime match what it synced before, so an image built from a new vyre.tgz could keep old
  files. The installer's unpack and `vyre update`'s refresh now touch the unpacked tree before
  the build (`scripts/install-box.sh`, `box/vyre`). The test tarball is packed with 1985 mtimes,
  as npm makes it, and the tests check the unpacked files are fresh (`core/names/system.test.js`).
  Found by box-deploy.

#### A model's shell cannot answer or approve as the person, even as "cli"

- On vyred's socket a caller label is only a claim. For a person-only tool (core/presence
  PERSON_ONLY: threads.answer, term.open, term.attach, and now agents.create, agents.update,
  gate.revise, gate.reject), vyred asks the kernel which process connected (LOCAL_PEERPID on
  macOS, SO_PEERCRED on Linux, read by a one-line perl) and walks its ancestry. Under a running
  `claude`, or under a process vyred runs a thread in, the call is refused with `denied`, never
  asked. Processes above vyred itself do not count. A pid vyred cannot read is refused.
- threads.answer refuses an answer from the session that raised the ask.
- `core/daemon/peer.js` (new), `core/daemon/index.js`, `core/presence/index.js`, internal
  `threads.pids` in `core/switchboard`; test/peer.test.js (a fake `claude` parent).

#### Every ask and held item says what answering it takes

- `threads.asks`, `threads.get`'s asks, `gate.held` and `gate.get` carry
  `presence: {required, covered}`, computed on the box: `required` is true only where a proof is
  needed (approving a send, a spend or a deletion at the Gate; asks never), `covered` when the caller's
  device has a live presence session. Surfaces render from it and never guess from tool names.
- The no-nag rule at the Gate and for asks: `gate.revise`, `gate.reject` and `threads.answer` are
  off the floor's list and ask for no proof (a person caller still; models are refused).
  `gate.approve` asks only for kinds `send`, `spend` and `delete`, through the floor's
  new `NARROWABLE` list, and is sessionable: a request with `x-vyre-presence-keep: 1` and a
  strong proof gets back `x-vyre-presence-session: session id=.. secret=.. expires=..`, which
  proves the next sends on that device as `x-vyre-presence`. A presence session now lasts 30
  minutes from the proof with no idle cutoff (it was 5 minutes idle).
  `core/presence/index.js`, `core/presence/module.js` (internal `presence.covered`),
  `core/modules/index.js`, `core/daemon/index.js`, `core/gate/index.js`,
  `core/switchboard/index.js`; test/presence-bypass.test.js.

#### Making or changing an agent is the person's, with no passkey

- The no-nag rule: `agents.create` and `agents.update` ask for no presence proof. `agents.create`
  is off the floor's human-only list and takes only a person's surfaces (cli, local, deck,
  capsule, the owner's Deck over the tailnet) and vyred's modules (onboarding makes the
  assistant). `agents.update` takes the same, plus the assistant for an agent's name, job, model,
  effort and description; any other agent, a bare MCP session and a guest are refused with
  "denied", never asked. The Deck's New agent, "Give a computer" and assistant card no longer ask
  for the passkey. `presence.when` stays for tools that ask for some inputs only.
  `core/agents/index.js`, `core/presence/index.js`, `deck/views/agents.js`,
  `deck/js/assistant-setup.js`; test/presence-bypass.test.js.

#### The event stream sends a byte as it opens

- `/v1/events/stream` writes `: open` right after its headers, so iOS URLSession sees the stream
  open at once instead of sitting on "connecting" until the 15 s heartbeat.
  `core/daemon/index.js`.

#### `vyre box add` waits for the switch, and the pairing code for the passkey

- It moved on as soon as the address served: it closed the tunnel, opened a second passkey tab and
  printed the pairing code before the person pressed "Switch to", whose passkey link then came
  over a closed tunnel, and the 10-minute code could run out before anyone could approve it.
  onboard.status now says `arrived` once the owner reaches the address; box add keeps the tunnel
  until then, opens no second passkey tab after a switch, makes the pairing code only once a
  passkey exists, waits for the approval, and replaces a code that expires unapproved.
  `core/cli/commands/box.js`, `core/onboard/index.js`.

#### An assistant made with an API key uses it as one

- With an API key at the Claude step, `onboard.finish` made the assistant with
  `auth: { vault: "anthropic-api-key" }`, which agents reads as a subscription token. It is now
  `auth: { fallback: "anthropic-api-key" }`; a subscription keeps the token first and the key as
  its fallback (`core/onboard/index.js`, `test/onboard.test.js`). Found by pwa.

#### Live Claude Code sessions are seen on node 24

- node 24 names its main thread "MainThread", so `ps -o comm=` said that for every claude running
  on node, and adopt, "live in terminal" and the queue for a busy session saw no session at all
  on a Mac with node 24. `isClaude` (`core/switchboard/sessions.js`) reads the command line
  instead: a native claude, node started as claude, or `node <path>/claude`. Found by ci on
  GitHub's node 24 runner.
- A switchboard test compared a thread's status across two reads while it could still be
  starting; it now waits until the thread has started.
#### `vyre vault` and `vyre memory` ask for the person, as `vyre learn` does

- `vyre vault put/grant/get --copy/...` and `vyre memory correct/merge/split/uncorrect/pin/mute`
  called vyred without a presence proof, so against a real vyred every human-only one failed with
  presence_required (exit 3). The tests missed it because test/fixtures/vyred-present.js finds a
  person at every call. They now go through callAsPerson: a tool that needs the person asks for
  the code vyred writes to their terminal (or Touch ID), and one that does not answers the first
  call as before. Without a terminal (an agent's Bash) they are refused asking for a person at a
  terminal, exit 3. `test/presence-cli.test.js` runs both against the real verifier.
  `callAsPerson` takes a `timeout`.

#### A first index that the Mac does not feel

- On a user's Mac the first `vyre up` held about 500% CPU for 7+ minutes while Recall embedded
  their whole Claude Code history, and the machine glitched. Now:
  - The search model runs in a process of its own at nice 19 (`core/recall/embed-worker.js`,
    `spawnEmbedder`), with ONNX Runtime on one thread (`intraOpNumThreads` and
    `interOpNumThreads` 1), and exits with vyred.
  - Background work is paced: after each transcript file and each embedded turn it sleeps as long
    again (`recall.duty`, default 0.5), and pauses while on battery under 30% (`recall.lowBattery`)
    or while the load average is above the number of cores, looked at once a minute
    (`core/recall/pace.js`).
  - Keyword search works from the first indexed session. `vyre status` and `vyre doctor` say
    where it stands: "indexing 1,234 of 5,678 sessions, low priority", then "search by meaning:
    1,000 of 40,000 turns, low priority; keyword search works now", or why it is paused.
    `recall.status` gains `progress { sessions, paused, priority }`.
- Measured on the test box, 20,016 turns: vyred and the model together average 0.46 cores
  (fake model, 60 s) and 0.41 cores (the real model, 120 s, download included), the model's
  process at nice 19, keyword search answering throughout. `scripts/perf-check --first-run
  [--real-model]` is that check; `core/recall/pace.test.js` measures the model process on the
  fixture corpus (0.43 cores, budget 0.65).
- `/v1/health` carries `memory` (rss, heapUsed, external, in MB); stress-drive samples it, reports
  the JS heap's slope beside RSS, and leaves out the samples taken while it reads the log back.

#### A temp home never reaches a real box

- A first-run check on the test box, in a temp home with the real Tailscale, found the user's
  live box through `link.find` and sent it a real pairing request (denied on the box). Now
  `link.find` and `link.pair` refuse with `not_real_home` unless the home is `~/.vyre`, or
  `VYRE_ALLOW_DIALOGS=1` or `VYRE_ALLOW_REAL_BOX=1` is set; never under tests. A fake tailscale
  (`VYRE_TAILSCALE_BIN`), a box on loopback and the link tests' seams are not real boxes and pass.
  `vyre up` says why when it is refused. `core/config/dialogs.js` (`realBoxAllowed`),
  `core/link/mac.js`, `test/link-guard.test.js`.

#### A first `vyre up` that says what it is and what to do next

- Root cause of a user's broken first run: `vyre` on their PATH was an old prototype
  (`~/.local/bin/vyre`, a link into the prototype's bin/), not the package npm had just installed.
  Its `up` printed "vyred running", started the prototype's daemon, which opens Chrome on
  about:blank for its own automation, and never made `~/.vyre`. The published vyre.tgz, run in a
  temp home on the test box, prints the full line and makes `~/.vyre`.
- `npm i -g vyre` now ends with the mark and "Vyre installed. Run: vyre up", written to the
  terminal (npm hides a script's output), and warns when another `vyre` comes first on PATH, with
  the `rm` and `hash -r` to fix it. `scripts/postinstall.mjs`, `core/cli/shadow.js`.
- `vyre doctor` flags any other `vyre` on PATH, first or later.
- The first `vyre up` on a machine (no home yet) opens with the mark, "Vyre is installed ·
  0.0.1 · <commit>", and two sentences on what Vyre is, instead of a status line. The "Where
  should Vyre run?" choices each say what they mean. Choice 3 asks for the box's address, says it
  is asking the box to pair, and prints "Approve this Mac on your phone at <address>" with the
  code. While that approval is pending, `vyre up` ends with "Once you approve it, run vyre up
  again to finish." instead of "Vyre is ready."; `--json` says `ready: false, pairing`.
- `vyre up --box` on a Mac says "Opening it in your browser now." before it opens the setup page,
  and opens nothing when dialogs are off. `core/cli/brand.js`, `core/cli/commands/up.js`,
  `core/cli/commands/box.js`.

#### `vyre doctor`

- One read-only command that checks what a first night trips on and says what to do: vyred
  (version and commit), Tailscale here (signed in), MagicDNS and HTTPS on the tailnet, Tailscale
  on the box (online, the same account), the phone online on the tailnet, the box's address
  (resolves, answers, its version), a passkey enrolled for that address (the rpId), this Mac
  paired (or the code waiting for approval), Claude signed in on the box, the Capsule (installed,
  and whether Control twice works), and the install size. Each line is ✓, ✗ with the one-line
  fix, or ? with why it could not be checked. Every check runs at once with its own 1.5 s
  timeout and the run is cut off at 2 s (0.2 s on the test box). `--json` gives
  `{ ok, role, ms, checks: [{ id, label, ok, detail, fix }] }`; exit 1 when anything failed.
  `core/cli/commands/doctor.js`.
- For it: `presence.keys` includes each key's `rp_id`; `core/cli/tailnet.js` status takes a
  timeout and reports `magicDNS` and `certDomains`; new tool `capsule.report {ok, message}`
  emits `capsule.hotkey`, for the Capsule app to say whether Control twice works (TCC holds
  Vyre.app responsible, so only the app can know).
#### Handing the keyboard back needs no passkey

- `glass.release` asked for a passkey, so a person in control had to prove presence again just
  to give the agent its keyboard back. Taking over still asks; handing back never does, and an
  agent still cannot hand back a person's surface. `core/glass/index.js`.

#### A Mac-only owner can pair the Mac

- `link.pair.approve` refused the node that asked, so the Deck on the Mac being paired could never
  approve it, and an owner without a second device could not pair at all. The asking Mac may now
  approve its own request when that call carries a fresh passkey assertion (not a presence
  session) and the typed code matches; a model on the Mac can do neither. `core/link/box.js`.
- The Deck's pairing card and the CLI say to approve "on this Mac or your phone".

#### A public name only when the person chose it; slow steps say so

- Step 1's live availability check (`onboard.name` check) saved every valid name it was asked
  about, so a name typed and then skipped became `config.name`, and step 4 claimed
  `<name>.vyre.run` on the public zone. A check now saves nothing. Step 4 claims a vyre.run name
  only when step 1 was continued with it, or with `confirm: true`; otherwise the page asks
  ("Use kit.vyre.run? Change it · Use my tailnet name"). Continue in step 1 with a new name
  replaces an earlier candidate while no address serves.
- The address step says up front that it can take about a minute, and the line in progress shows
  its elapsed seconds. Starting Claude's and Tailscale's sign-in say they take a few seconds.
#### The phone app switches tabs in one frame

- Pages stay mounted: leaving a screen hides it (laid out, inert) instead of tearing it down, so
  going back shows it as it was, scrolled where it was, still following its events. Up to eight
  are kept; Glass and the Vault never are. A view can ask to refresh on a revisit (ctx.onShow).
- On a phone the five tabs are made while it is idle after launch, so the first tap on each is a
  revisit. Tapping the tab you are on scrolls it to the top.
- A Chat session opens from what the list already knew, reads only its last 60 turns (Show
  earlier reads more), and Back returns to the list as it was. The Chat list draws the last one
  this phone saw at once, then the box's.
- The fonts are served from the box (deck/fonts, OFL), not Google, and the service worker answers
  the Deck's own files from its cache and refreshes them behind (stale-while-revalidate).
- The first screen no longer waits on onboard.status.
- Measured on the test box, iPhone size, CPU 4x slower, 60 ms to the box: a tab switch 40 to 90 ms
  (was 150 to 400), a revisit about 30 ms (was up to 190), Back in Chat about 20 ms, opening a
  session 100 to 250 ms. `deck/test/pwa-perf.js` and `pwa-perf.test.js` (runs where CDP is set)
  fail over 100 ms.
- The owner's phone over the tailnet queues for a session busy in the terminal, and an agent's
  tailnet node does not (queuesFor in core/switchboard).
#### The phone's design

- docs/design/phone.md sets the phone app's design for the PWA and the native apps: no tab bar,
  three pages (Now, Chats, Agents) swiped sideways and the floating Capsule for ask, find and run,
  with native-feeling screens (grouped cards, sentence-case buttons, standard sheets). Needs you is
  a list whose rows swipe to approve or deny and open a detail sheet with Open session. Colour
  roles use the Deck's names (deck/css/deck.css). Native approvals are a device-key signature
  after Face ID (ADR 0018), the PWA's a passkey; both are the same box-checked presence proof.
  Docs only; no code changes.

#### docs.vyre.run, round 2: screenshots, a terms index, interactive pages (ADR 0019)

- Page syntax that works with JavaScript off and gets better with it: copy buttons on every
  command (prompts left out), `output` blocks labelled "You should see", `::: tabs` for a choice
  of path (one choice follows the reader across pages), `[!SNAG]` "If this happens" boxes,
  `[!WHY]` expandable background, figures with a dark twin, `::: demo capsule` (a Capsule you can
  type into, sample data only) and `::: demo onboarding` (the six screens as slides), and search
  that jumps to headings (`/` focuses it). `scripts/lib/docs/assets/demos.{js,css}` load only on
  pages with a demo.
- Screenshots: `npm run docs:shots` (on the test box) starts the sample world and captures the
  Deck, onboarding, the Capsule, Glass and the phone views in light and dark. `docs/shots.json`
  holds a hash of the files each shot shows; docs-check fails a shot once they change.
- The terms index: `npm run docs:ref` writes `docs/reference/index.md` and `docs/index.json`
  (published at /index.json): every command, tool, event, config key, variable, screen and
  concept, with where it is defined, the page that explains it and every mention. docs-check
  fails a mention of a command, tool, key or variable the code no longer has.
- `core/config/theme.js` holds the palette; the design tokens page draws its colour tables from
  it as live swatches.
- Every page reviewed against main; install is one numbered path with expected output and snag
  boxes; the old install reference moved to box care and the box-and-Mac concepts page.
- `scripts/lib/hygiene.js`: the `sk-` secret pattern no longer matches inside words (an anchor
  like `#ask-...`).

#### vyre.run/start matches the code again

- /start's Mac section is `npm i -g https://vyre.run/box/vyre.tgz`, `vyre up` (pick 3, I already
  set up a box), then `vyre capsule`, which builds the Capsule from the npm install. There is no
  Mac download any more. The Cloudflare token steps are gone (your address is the tailnet name),
  and pairing says what the code does: approve in the Deck with your passkey, whose screen is a
  known gap.
- `scripts/build-site.sh` writes `/download/mac /start#mac 302` into `site/_redirects`: onboarding's
  "Download for Mac" link was a 404. Deployed to vyre.run with the live box files unchanged.

#### Known gaps are marked on the page (ADR 0019)

- `docs/known-gaps.md` lists each place the code does not yet do what the spec, an ADR or a
  screen says, with what is true now and the owning team. Pages carry a `> [!GAP]` callout,
  rendered as "Known gap", that links to it. `CONTRIBUTING-DOCS.md` says how to add and close one.
- The security page names security@vyre.run as the contact.

#### Every page of docs.vyre.run is written (ADR 0019)

- The 57 pages in `docs/nav.json` exist, each with front matter and an owner: get-started,
  using, concepts, build, architecture, security, contributing, and ADR 0019 for the site itself.
  Pages other teams own are seeded from the code on main for them to refine.
- `docs/SPEC.md`, `INSTALL.md`, `GETTING-STARTED.md`, `JOURNEY.md`, `MODULES.md` and `PERF.md`
  moved to `architecture/spec.md`, `get-started/install.md` and `without-docker.md`,
  `get-started/onboarding.md` (GETTING-STARTED and JOURNEY merged), `build/writing-a-module.md`
  and `architecture/performance.md`. Each old path is a redirect stub, so `docs/SPEC.md section N`
  in code comments still resolves. The ADRs and `design/TOKENS.md` have front matter.
- The npm package ships all of `docs/` except `work/`, `proposals/` and `design/boards/`, instead
  of five named files that are now stubs.
- An include line inside fenced code is an example: the build and docs-check leave it alone.
  docs-check's list of built files names `/search-index.json`, which is what the build writes.

#### docs-check and the generated reference pages (ADR 0019)

- `scripts/docs-check` (`npm run docs:check`, and `test/docs-check.test.js` under `npm test`)
  holds `docs/` to its contract: front matter on every published page, every page in
  `docs/nav.json` or a redirect stub, relative links, `#anchors` and docs.vyre.run paths that
  resolve, no links into unpublished folders, no em dash or section sign (in included files
  too), no real names, secrets, non-example email or IP addresses, and reference pages that match
  the code. It prints `path:line: problem` and exits 1 on any.
- `scripts/gen-docs-reference` (`npm run docs:ref`) writes `docs/reference/{cli,tools,events,config,modules}.md`
  from the CLI's command list, every `module.json`, every `ctx.tool` definition, the `emit` calls
  and `core/config`. Tools are read by starting each module in a child process with a throwaway
  home and a context that only records: no child processes, no listeners, no fetch, no keychain.
- The hygiene rules (forbidden names, the secret pattern) moved to `scripts/lib/hygiene.js`,
  shared by `test/hygiene.test.js` (unchanged behaviour) and docs-check.
#### Colours from config, Find's commands, and the owner's phone reads memory by meaning

- `theme.colors` in config.json ({ dark, light }, TOKENS.md names without dashes, plain CSS colours
  only) is served as GET /theme.css, read on every request, and every Deck page links it after
  deck.css. Anything but a colour is dropped, so config cannot add CSS.
- Find understands the Capsule's commands: `@kit ...`, `tell <session> to ...` (types, then
  watches), `watch <session>`, and `tell me when <session> is done|asks`. A line under the box says
  what Enter will do, and a tap picks another matching session.
- memory.relevant answers the owner's tailnet devices without a room, so Find on the phone searches
  memory by meaning. system.info names the owner (owner.name), and the Deck's avatar uses it.
- Now asks for a first passkey while the box has none, and names the commands that print its link.

#### Pairing a Mac is approved in the Deck, and onboarding's last steps read right on a box

- Now shows each Mac asking to pair: its name and node, a field for the code on the Mac's screen,
  Approve with a passkey (link.pair.approve) and Deny. It follows link.pair-requested and
  link.paired, and when the box refuses it says why (the asking Mac cannot approve itself).
- Onboarding step 6 is two equal cards that stack on narrow screens: Pair this Mac (the npm
  command, `vyre up`, then the approve card in place, then "Mac paired") and the phone (Tailscale,
  the address, Add to Home Screen). An iPhone or Android phone offline in Tailscale is named in
  plain words, here and in Settings > Devices. The button says Open Vyre, as JOURNEY.md does.
- `onboard.status` adds `detail.devices.peers` (the owner's own tailnet devices: name, OS, online,
  last seen), from `tailscale status --json`.
- Step 5 on a box with no sessions says the Mac's sessions come once it is paired, and hides the
  ranking line at 0 sessions.
- With no assistant yet, Now and Agents offer Create your assistant (agents.create, as onboarding's
  finish does).
- Phone Chat queues a message for a session busy in the terminal (capsule-now's contract) and says
  so until it is handed over. The watcher switch calls watchers.resume and watchers.pause, and
  Settings no longer names `vyre up --step`, which does not exist.
- `deck/test/world.js` runs with a fake tailscale (`deck/test/fake-tailscale.js`), so a world never
  reads the real Tailscale of the machine it runs on.

#### Every call from an agent passes the floor's rules, not only Claude Code's

- SPEC 5.3 says every tool call passes the Rules, but vyred gave the Registry no `rules` hook, so
  only Claude Code's PreToolUse hook ran them: an agent through the switchboard, the Capsule or
  MCP, a module, or a tailnet peer skipped them. vyred now passes `registryRules`
  (`core/harness/rules.js`) to the Registry. A person at their own surface (cli, local, deck,
  capsule, naming no agent) is not held there, since presence and the Gate speak for them; every
  other caller gets the rules' answer, and an "ask" is a refusal, since nobody is there to say
  yes. `test/daemon.test.js`.
- `vault.caps`' description said reveal is off by default; it is on, and every reveal needs a
  presence proof or a session a proof opened (SPEC 11 rule 8, ADR 0006, now updated). A new test
  runs the real Presence and shows the Deck and the Capsule get no value without a proof, and no
  agent reaches `vault.reveal` at all. `core/vault/surfaces.test.js`.
- `test/onboard.test.js` closes each connection, so a request after a vyred restart on the same
  port never rides a socket the old vyred closed (an intermittent "other side closed").
#### Glass and agents' computers, live (work/glass-live)

- Giving an agent a computer from the Deck works. `agents.update` names its agent by `name` or
  `agent` (every other agents tool uses `agent`); the Deck sent `agent` and got "input.name is
  required". The Deck now sends `name`.
- Glass's screen connects over the tailnet. The tailnet HTTPS listener had no upgrade handler,
  so Node passed every WebSocket to the request router, which answered 404. Modules that open a
  listener get vyred's stream router as `ctx.upgrader(policy)`, and the names listener applies
  its owner, host and Origin rules to upgrades, with the same caller classes as requests (owner,
  guest, agent node).
- A computer that dies on boot fails the checkout with its exit code and the `docker logs` line
  to read, instead of being marked running; a checkout waits (up to `computers.bootMs`, 30 s)
  for the screen port to answer. A computer that died while idle freezes to `stopped` rather
  than staying `running` with "could not freeze ... container is not running".
- New `computers.restart {agent}` (a new container on the same home volume, so files and
  Chrome sign-ins stay; fresh passwords; the checkout survives) and `computers.limits {agent,
  cpus, memory_gb}` (whole cores 1 to 16, whole GB 1 to 64; a person's or the assistant's to set,
  never an agent's own; applied at the next restart). `computers.get` also returns `screens`,
  `cpus` and `memory_gb`. The Deck already called both tools, which did not exist.
- The Deck's computer panel reads what `computers.get` returns (it was drawn from fixture fields
  no tool had: name, host, disk, network, rules). Glass's title state follows the computer as
  watching thaws it.
- Glass says why a computer did not start. The relay closes the stream with 4001 and a short
  reason ("kit's computer stopped as soon as it started (exit code 3)"), and Glass shows "kit's
  computer did not start" with that reason, what to try (Restart computer on kit's page, then
  Retry), a Retry button and a link to kit's page. It no longer retries a broken computer on its
  own. Other checkout failures close with 1011 and Glass tries again as before.
- `test/deck-contract.test.js`: every tool the Deck calls must exist on a box and get its
  required input. Fixtures answer anything, so this is what catches a Deck call no tool accepts.
#### link.health answers the owner and modules only

- On the box, `link.health` refuses a guest from another tailnet, an agent's own node, an agent
  at the box, MCP and any tailnet login that is not the box's owner. The Deck, the terminal and
  modules such as Glass ask as before.

#### Glass egress: fail closed, keys that survive restarts

- The egress sidecar no longer sends a listed site out from the box when the Mac stops offering
  its exit node or its route is unapproved (tailscaled then dials directly, and the site saw the
  datacenter's address). A gate, `core/computers/egressgate.js` in the vyre image, now answers as
  `egress:1055`: it reads each SOCKS5 CONNECT and relays it to the sidecar only while the
  sidecar's tailscaled status shows the exit node in use (BackendState Running, one peer with
  ExitNode, Online and ExitNodeOption, and ExitNodeStatus online when present). Otherwise it
  answers "connection not allowed by ruleset" and never dials the site. The status is read on
  demand, kept 2 s, with no timer while idle; each change of reason is logged once. Node
  built-ins only; `read_only`, `cap_drop: ALL`, uid 1000.
- `box/compose.egress.yml`: the tailscaled sidecar is now `egress-node` (SOCKS5 on :1056, on a new
  internal network `vyre-egress` shared only with the gate, off the computers network); its
  socket is shared read-only with the gate through the `egress-sock` volume. The key is an OAuth
  client secret (`tskey-client-...?ephemeral=true&preauthorized=true`) or a reusable ephemeral
  key, always with `--advertise-tags=tag:vyre-egress`; a single-use key failed the first restart.
- `computers.egress.status` also returns `gate`, the gate's verdict and reason (GET /status on
  egress:1057).

#### Connectors (ADR 0016)

- A held MCP call names its destination from `channel_id` and `chat_id` too, so a Slack post
  held at the Gate shows the channel rather than the server's name.
- CLI: `vyre connect add google <name> --sign-in [--client <vault item>]` signs in with Google
  from a terminal. The client defaults to `google-oauth-client`; without it, the command says so
  and prints the `vyre vault put` line for a Desktop app OAuth client. It grants the client to
  google with presence, runs google.connect and prints the consent address on its own line. It
  opens a browser only when dialogs are allowed and stdout is a terminal. It then waits for
  `google.connected` or `google.connect-failed` on the event stream, for a pasted address (sent
  to google.connect.finish), for Ctrl-C (google.connect.cancel, "cancelled, nothing stored") or
  for 10 minutes. End of input cancels only at a terminal; piped or empty stdin just stops the
  paste reader and the loopback can still finish it, and ends with the account's test. `--email`, `--item`
  and `--dwd` are refused with `--sign-in`.
- Deck, Settings, Connections: "Add a Google account" signs in with Google by default. Name the
  account, pick the OAuth client env set (the form shows the `vyre vault put` line for one), and
  press Sign in with Google: a blank tab opens at once (while the press still counts, so it is
  not blocked, with its opener cut), the client is granted to google with presence,
  google.connect runs, and the tab goes to Google's page while the form waits for `google.connected` (or
  `google.connect-failed`, whose error it shows). A browser on another device pastes the address
  it landed on into google.connect.finish. Cancel, closing the form and leaving the page each call
  google.connect.cancel, and a failed grant or connect closes the tab. Only when the browser
  blocked the tab is Google's address shown as a link. "Service
  account" and "Refresh token item" stay as they were, and a service account's Test now shows an
  admin console block with its client ID and scope line, each with Copy.
- "Sign in with Google" (`core/google/connect.js`). `google.connect {name, client}` names a vault
  env-set holding an OAuth client's `client_id` and `client_secret` (granted to google) and
  returns `{ id, url, redirect }`: the consent page, with PKCE S256, a random state, offline
  access and the module's five scopes plus `openid email`. Google sends the browser back to a
  loopback listener on 127.0.0.1 port 0 that exists only while a sign-in is open (10 minutes
  each, one timer per sign-in). The refresh token goes into a new env-set `google-<name>` the
  module makes and grants to itself, the account is added as google.add would, and
  `google.connected {id, name, email}` is emitted (`google.connect-failed {id, error}` when it
  does not work). `google.connect.finish {id, url}` takes the pasted address for a browser on
  another device; `google.connect.cancel {id}` ends one. People only; a model never can. Every
  error is scrubbed of the secret, the code, the verifier and every token.
- `google.test` on a service account also returns `client_id` (the key's public number) and
  `admin_scopes`, the exact comma-separated line for the Workspace admin console's domain-wide
  delegation page. Nothing else from the key leaves.
- The fake Google has an authorization_code grant that checks PKCE and the redirect, and
  `consent(url)` to play the person on the consent page.
- The MCP hub is never a route around the floor. A hub tool with a send word (`send`, `post`,
  `reply`, `forward`, `publish`, `share`, `invite`, `tweet`, `dm`, `comment`) is always held at
  the Gate, even when a person set its mode to `read` or the server marks it read-only, and
  `mcp.add` and `mcp.update` now refuse `read` for such a tool (it can be `write` or `off`).
  They also refuse Vyre's own MCP server as a hub server (`vyre mcp`, or anything running
  `harness/mcp/server.js`) and any `vars` or `env` name that starts with `VYRE_`. Every stdio hub
  child now gets `VYRE_HUB_CHILD=1`, and Vyre's MCP server started under it answers every request
  with an error, offers no tools and never contacts vyred.
- Settings has a Connections section (`deck/views/connections.js`): the hub's MCP servers and the
  Google accounts, each with its state, tool count or scopes, and Test, Restart and Remove.
  Adding one picks vault items by name and asks for the `mcp` or `google` grant with presence;
  without presence it shows the exact `vyre vault grant` line instead. The page only ever holds
  item names, copies only the fields it draws, runs no timer, and redraws on `mcp.*` and
  `google.*` events. Remove asks first. `google.test` calls Google, so it runs only on Test.
  A tool that sends shows Read disabled, since the hub always holds it; `mcp.test` marks such
  tools with `sends`.
- The harness rules no longer ask, and `gate.route` no longer denies an agent, about
  `google_mail_send` in Vyre's own MCP server (`mcp__vyre__` and `mcp__plugin_vyre_vyre__`): the
  google module always holds a send at the Gate, so asking first only added a second prompt for
  the same email. The list is explicit and short; `threads_send` and every other server's send
  still ask.
- The connectors credential tests make their token and private-key fixtures at run time, so the
  hygiene scan finds no secret-shaped literal in shipped code and stays as strict as it was.
- `vyre mcp` runs the Vyre MCP server on stdio, so a plain `claude` outside a Vyre thread gets
  the same tools with one line. `vyre mcp install` prints that line
  (`claude mcp add -s user vyre -- vyre mcp`) and runs it only with `--yes`: Vyre never edits a
  Claude config itself. The server is imported rather than spawned, so it still finds its session
  by its parent's pid, and nothing but JSON-RPC reaches stdout.
- `vyre connect list|add|remove|test` manages MCP servers and Google accounts in one place. A
  connection names vault items (`--item`, `--env VAR=item`) and never takes a value on the
  command line. After an add it asks the vault to grant each item to the module, as the person at
  the terminal, then tests and prints the server's tool count or the Google scopes Workspace
  refused. `--var` passes a plain setting to a stdio server; the hub still refuses one that looks
  like a credential.
- The Vyre MCP server (`harness/mcp/server.js`) now offers every hub tool beside the module
  tools, as `<server>__<tool>`, so a session sees its connected servers through the one `vyre`
  entry and no server needs its own line in a Claude config. Listing reads the hub's cache and
  never starts a server. Both the listing and each call carry the session key, so the hub scopes
  them by the session's project. A tool the hub will hold says "(held for approval)" first, and a
  held call answers with the Gate item and a plain sentence rather than an error. With no `mcp`
  module running, nothing extra is offered and module tools behave as before.
- The MCP hub (`core/mcp/`, module `mcp`) puts any number of MCP servers behind one tool list,
  so a person can plug in a tracker, a CRM and a docs tool without a token in any config file. A
  server row names vault items, never values: `mcp.add` refuses a header, env value, argument or
  url that looks like a credential, and plain http is allowed only to this machine, the tailnet
  (100.64.0.0/10) or an origin listed under `mcp.httpHosts`. Tokens are fetched under the `mcp`
  grant at call time, and every result and error is scrubbed of them. Nothing starts at boot;
  a server starts on its first call, its tools are cached so `mcp.tools` never spawns anything,
  it stops after `idle` (10 minutes by default) on one timer, and a server that crashes stops
  restarting after three tries in five minutes until `mcp.restart`. Scope follows what vyred
  verified (the agent, its projects, the thread's project) and `mcp.call` checks it again. A
  tool that is not plainly a read is held at the Gate as `mcp:<server>` and reaches the server
  only with the arguments the person approved. Managing servers is for people and modules,
  never a model.
- `gate.request` now takes `agent` from a module caller (never from a model), so a request the
  hub files for an agent still shows which agent asked: the hub's `ctx.call` runs as
  `module:mcp`, which would otherwise lose it.
- `core/google/` is native Google Calendar and Gmail, so the assistant and the Capsule can read
  the person's day and mail without an MCP server holding a token in its env. Accounts
  (`google.add`, people only, never a model) name a vault item, an OAuth env-set or a
  domain-wide-delegation service account, and never hold a value. Every call mints the narrowest
  scope it needs (`calendar.readonly` and `gmail.readonly` for reads, `calendar.events`,
  `gmail.compose`, and `gmail.send` only at the moment of a send), retries once on a 401, and
  returns results scrubbed of every value it touched. A send is always held at the Gate, and so is
  an event with attendees, because Calendar mails them an invite; each account is its own Gate
  sender, `google:<account>`, so the person sees which address it leaves from. A draft and an event
  without attendees are written directly, since neither reaches anyone. `google.test` names each
  scope a Workspace admin console refuses. `google.find` and `google.open` put "what's next",
  "today" and "email from dana" in the Capsule. Nothing polls.
- The fake Google records the scopes of the token behind each API call, so a test can prove a
  read never used a write scope and a send used `gmail.send` alone.
- `core/mcp/client.js` talks to one MCP server over stdio, streamable HTTP or legacy SSE, with no
  dependencies, so the hub can reach any server a person adds. A stdio server gets only PATH,
  HOME, LANG, TMPDIR and the env it was given, so a token vyred holds for one server is never
  visible to another. HTTP headers are asked for on every request because credentials are minted
  at call time, and redirects, an SSE endpoint on another origin and replies over 4 MB are
  refused, so a credential never follows a request somewhere else. Errors carry a stable `code`
  (`unauthorized` on a 401, so the caller can mint again and retry once) and never a header value.
- `core/mcp/testing/fake-mcp.js` is a fake MCP server, as a child process or in-process over HTTP
  and SSE, so no test starts a real one.
- A module can now be a way out through the Gate. `gate.offer { name, tool, kinds?, content? }`
  (internal, modules only) registers a sender named in the module's own namespace whose `tool` is
  one of its own; after the user approves, the Gate calls that tool as `module:gate` with exactly
  the approved content. The MCP hub and native Google need this to hold their sends. Offers live in
  memory, so an item held under a module that has not started yet stays held, and Approve says
  which module to start.
- The floor's rule 1 and `gate.route` no longer ask about or deny a tool named
  `mcp__vyre__<server>__<tool>` (or `mcp__plugin_vyre_vyre__<server>__<tool>` under the plugin),
  where `<server>` is a hub server name. Those are the MCP hub's tools, which hold every outward
  call at the Gate themselves with a stricter rule than the name check, so asking first would make
  the user answer twice. Vyre's own tools (`mcp__vyre__threads_send`) and every other server are
  unchanged.
- `core/connectors/auth.js` turns a vault item into what a request carries, once for both the hub
  and Google: a bearer header, an OAuth access token minted by refresh, or a Google
  service-account JWT exchanged for one. Access tokens stay in memory, cached until a minute
  before expiry. The library remembers every value it touched (raw token, refresh token, private
  key and its lines, assertion, access token), so callers can scrub all of them from what leaves
  the module. Token requests refuse redirects and time out after 30 s. Refusals read as sentences
  and never quote a value; a domain-wide-delegation refusal names the user and the scopes, and
  says where to allow them.
- `core/connectors/testing/fake-google.js` is a Google for tests on 127.0.0.1. It verifies JWT
  signatures against keys it generated, checks subject and scopes, plays the admin console's
  delegation list, and requires its own tokens with the right scope on Calendar and Gmail calls.
  A fake that accepted anything would hide the bugs that matter here, such as a read token used
  to send.
#### Vyre installs as a Claude Code plugin, and shows its line in every session

- `.claude-plugin/marketplace.json`: the marketplace `vyre`, one plugin `vyre` from `./harness`.
  Install with `/plugin marketplace add vyre-ai/vyre`, then `/plugin install vyre@vyre` (ADR 0020).
- `harness/hooks/run.js`, `harness/mcp/run.js`, `harness/lib/vyre.js`: `/plugin install` copies only
  `harness/`, so hooks and the MCP server start from launchers that find a Vyre package
  (`VYRE_PACKAGE`, the package they sit in, or `vyre` on PATH) and run its own `hook.js` or
  `server.js`. With no Vyre, a fresh session gets one line pointing at https://vyre.run/start, every other hook
  exits 0 silently in about 20 ms, and the MCP server connects with no tools.
- `/vyre` gains `ask <agent> <text>`, `send <session> <text>` and `statusline`.
- `core/statusline`: a module that keeps `<home>/statusline` (pid and line, such as
  `vyre · 2 need you · box ok · juno idle`), recomputed on events and once a minute.
  `harness/statusline/statusline.sh` prints it in about 4 ms, never touching vyred or the network.
  It reads and drops Claude Code's stdin JSON unless it chains, so the writer never hits EPIPE.
- `vyre statusline [install [--chain] [--yes] | uninstall]`: sets Claude Code's `statusLine` with
  consent, never replacing one the user has (`--chain` keeps theirs above Vyre's line). `vyre up`
  on a Mac offers it once on a terminal.
- Learning treats running `hooks/run.js` by hand as running a hook by hand.

#### CI on GitHub's free runners

- Four workflows build and test Vyre on GitHub Actions, so no one compiles the Capsule or the
  apps on their own Mac. `node.yml`: the suite and the perf gate on Node 22 and 24 (ubuntu).
  `capsule-mac.yml`: the Swift helpers, the native Capsule's tests and app once they land, and the
  Mac-only Node tests (macos). `ios.yml`: xcodegen, then build and unit tests on a simulator.
  `android.yml`: gradle build and unit tests on JDK 17. The app workflows skip while their folder
  is absent. Each uploads what it built (Capsule zips, the iOS simulator app, the debug APK), and
  every workflow can also be run by hand (workflow_dispatch). Replaces `test.yml`, which ran the
  whole suite on two macOS runners without installing dependencies. `.github/workflows/`, README
  badges.
- `capsule-mac` also proves the "Vyre Local" signing path on a throwaway keychain: createIdentity,
  then codesign and a strict verify of the native app (once `capsule-native.js` is on the branch).
- `scripts/install-box.sh` is shellcheck-clean on the runners' shellcheck 0.9.0: two intended
  patterns (a root-only read into this user's file, a positional argument in single quotes) carry a
  directive with the reason.
- Docs and comments call the test server "the test box", the prototype's folder "the
  prototype's bin/", and the firm in a memory note Harlow, before the repo goes public (docs and
  comments only).
#### The Deck installs on a phone as an app

- Add to Home Screen gives a full-screen app: a manifest with maskable icons, an Apple touch
  icon, launch screens for twelve iPhone sizes, and a status bar in the theme's colour. The shell
  keeps clear of the notch and the home indicator, never rubber-bands, and fills 100dvh.
- Find is the phone's Capsule, a tab in place of Ask and a pull down from the top of any screen:
  one box for asking juno, sessions (titles and what was said), box files, agents, memory and
  projects. Vault items are never offered there.
- Chat on the phone: a session fills the screen above the tab bar, a reply keeps the view at the
  bottom or shows Jump to latest, and a session another keyboard has says so and keeps the draft.
  Asks and held drafts answer inline with a passkey, and say Allowed, Denied or Sent after.
- Now, the Deck's approvals (Send, Discard, Allow, Deny) prove a person with the passkey, as the
  floor already required; before, they were refused with presence_required.
- Set up this phone, on Now: install, notifications (asks and held drafts, iOS 16.4 and later from
  the Home Screen app) and a passkey. Settings uses the same code for push and passkeys.
- Offline: the service worker keeps the shell and the five phone tabs at install, a cold launch
  reopens the last screen, and one line says when the phone is offline or the box is not answering.

#### The `vyre` screen, polished from a captured frame

- The status line reads link.health's real shape ("link direct 23 ms", "link relayed", "link
  down"; nothing on a box or an unpaired Mac, where it said "link ?"), and shows the commit
  ("vyred 0.0.1 · 1a2b3c4").
- A wrapped transcript line keeps its indent, so a quoted prompt reads as one block.
- Something seconds old is "now", not "1m". `core/cli/screen/`.

#### One vyred per home, whatever path reached it

- Two vyreds could run on one store when the home was reached through a symlink: the socket
  path was worked out from the home's spelling (a long spelling moves it to /tmp under a hash),
  and the "already running" check came after every module had started. Now vyred takes
  `vyred.lock` in the home's real folder before it opens the store; the socket path is worked out
  from the real folder too. A lock whose process is gone, is not a vyre process, or is from before
  this boot (a reboot or a container restart reusing its pid) is taken over.
  `core/daemon/lock.js`, `core/daemon/index.js`, `core/config/index.js`.

#### `vyre threads` never answers with a blank screen

- With no sessions it printed nothing. Now it says why: indexing still running, no transcript
  folders configured, or no Claude Code sessions yet; a search with no hits names the words and
  points at `vyre recall`; `--project` with none says how to start one. `core/cli/commands/projects.js`.
- `vyre threads --help` crashed on main (projects.js parse rejected --help); the kit branch
  already handles help in core/cli/index.js, and test/cli.test.js now pins it.

#### A release says which commit it is

- `scripts/build-site.sh` (the step that packs vyre.tgz for npm and for the box image) writes
  `build.json` `{version, commit, dirty}` into the package; gitignored in the checkout.
  `core/daemon/build.js` reads it, or in a checkout asks git once, lazily (never on a plain CLI
  start). `/v1/health` and `system.info` report `commit` and `dirty` next to `version`, and
  `vyre status` prints `0.0.1 · 1a2b3c4` (`+dirty` when it was).

#### `vyre update` no longer voids the set-up link the user was sent

- `vyre update` on a box ended with `vyre up`, which minted a new onboarding link and voided the
  unused one; recreating the container also restarted vyred, which forgot the link and every open
  onboarding page. Now update runs `vyre up --keep-link`, which calls `onboard.link {mint:false}`
  and only reports: "set up is not finished; the link you have still works (42 min left)". A
  plain `vyre up` still mints a fresh link, and says it voids the old one.
- The unused link's hash, its port and the open onboarding sessions' hashes are kept in
  `<VYRE_HOME>/onboard-link.json` (0600, hashes only) when vyred stops, and the next vyred reopens
  the listener for them. The owner arriving on the tailnet deletes the file for good.
  `core/onboard/loopback.js` (`keep`, `resume()`, `pending()`, `close({forget})`),
  `core/onboard/index.js`, `core/cli/commands/up.js`, `box/vyre`.

#### `npm i -g vyre` is 6 MB, not 750

- The search model's library (`@huggingface/transformers` with ONNX Runtime) is no longer an npm
  dependency of any kind. It made a global install 750 MB on Linux (onnxruntime-node 548 MB,
  onnxruntime-web 141 MB), because npm ignores `--omit=optional` for a global package's own
  optional deps. Measured on the test box from `npm pack`: the tarball is 1.50 MB before and after, and
  the install into an empty prefix went from 750 MB to 5.9 MB on disk (4.5 MB of files; all of it
  Vyre's own code, deck and docs). `package-lock.json` lost 1,048 lines.
- Recall installs the library on first use into `<VYRE_HOME>/embedder` (on a box, the home's
  volume) with the npm next to node, pinned to 4.3.0, and searches by keyword until then. It says
  so in one line: `vyre recall` prints "downloading the search model (about 128 MB, once); search
  is by keyword until then · vyre recall --setup", and vyred logs the same. `core/recall/embed.js`.
- The install is pruned to what the CPU path opens: this platform's ONNX Runtime only, no GPU
  providers (CUDA and TensorRT were 260 MB), and only onnxruntime-web's `ort.node` entry (its
  WebAssembly builds were 115 MB). 500 MB becomes 105 MB, and the model loads and embeds the same
  (checked on the test box: "croissant menu" vs "pastry list" 0.566, vs "kubernetes ingress" 0.065).
- `vyre recall --setup` (new tool `recall.setup`) installs and loads it now and waits: 16 s on
  the test box. A failed install leaves no half-written tree, says why, and `--setup` tries again. New
  config keys `recall.embedder` (where it goes) and `recall.npm`.
- `scripts/release-check.sh` now fails on any optional dependency and on an install over 10 MB.
#### The box reads the paired Mac through the link

- The link runs box to Mac as well, with no port open on the Mac. While paired, the Mac holds one
  request to the box's new `link.serve` open (60 s, then it asks again), runs the question it gets
  and answers with `link.reply`. When a call to the box fails the loop stops, and the next call
  that reaches the box (the minute's heartbeat at the latest) starts it again, so nothing polls
  faster than a minute. Both tools check the pairing key and the Mac's pinned node.
- `link.macs.call { tool, input, timeout? }` (box, modules only) asks every paired Mac and answers
  `[{ mac, name, ok, data?, error? }]`: `mac_offline` at once for a Mac that is not polling,
  `timeout` after up to 15 s (5 s by default), or the Mac's own error. `link.macs` lists the paired
  Macs with `online` and `lastServe`, for surfaces. The Mac's `link.status` says `serving`.
- Only `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`, `recall.thread` and
  `threads.list` cross (`core/link/allow.js`), refused at the box before queueing and again at the
  Mac before running. The Mac runs them as `module:link`. Nothing a Mac answers is stored on the box.
- The link's test harness (`pair`, the simulated tailnet) moved to `test/link-harness.js`;
  `test/link-federation.test.js` covers the reverse channel.
- On the box, `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`,
  `recall.thread` and `threads.list` take in the paired Macs' rows for the person (the Deck, the
  terminal, the Capsule, the owner over the tailnet), and for a module only when it passes
  `machines: "all"`. `machines: "local"` asks for the box's rows alone; agents, MCP and guests get
  them always. Every row of a federated answer carries `source` ("box" or "mac") and `machine`.
  The catalogue merges by its own order and applies the limit to the merged list, with
  `sources: [{ source, machine, ok, error?, total? }]` (box first); search merges by score,
  sessions and threads by recency, capped at each tool's limit. `recall.thread` asks the Macs only
  for a session the box does not have, or when given `source: "mac"`. A Mac that is away shows as
  `ok: false, error: "mac_offline"` and the box answers with its own rows at once. On a Mac
  nothing changes, so the Mac never asks the box back. The shared piece is
  `core/modules/federate.js`; `test/federation-reads.test.js` covers it end to end.
- Onboarding's history step on the box counts the paired Mac's sessions, lists them per machine
  (`history.machines`), and says "Your Mac (<name>) is offline, so its sessions do not show here
  yet" when the Mac is paired but away and nothing is here.
- `recall.sessions` takes `ids` (exact session ids). On the box, `projects.threads` resolves a pick
  the box has no session for by asking the paired Macs once for those ids, for the person (or a
  module passing `machines: "all"`): a Mac session picked into a box project comes back with its
  name, folder and times and `source: "mac"`, `machine`, and is never stored. With the Mac away,
  or for an agent, it stays `missing: true`. The project's brief stays the box's own.
- The Deck shows a machine chip (`deck/js/machine.js`) on the paired Mac's rows in Chat's list and
  rail, Now's working threads and recent sessions, search results, and a project's threads, and
  reads those threads only: no composer, keyboard, Take or Watch, and "On alex-mac. Open it there
  to continue." in their place. A Mac project is listed without a board or a pin, and picking goes
  into the box's projects only. A paired Mac that is away shows as one quiet "alex-mac offline"
  chip in Chat's header and Now's Working, from `link.macs`, read with each refresh and never while
  the page is hidden. Fixtures: a Mac thread in `threads.list`, and `deck/fixtures/link.json`.
- A Mac that unpaired while its heartbeat was out could leave a link.json with no box in it, and
  `vyre link status` then failed until the file was removed. The heartbeat's answer is now dropped
  when the pairing it asked about is gone.

#### The suite passes on the test box (Linux, node 22) as it does on the Mac

- Tests now run on the test box, not the Mac, and 14 failed there for reasons of the machine, not the
  code. The vault tests' cheap KDF is Argon2id only where node has it (24.7+), else scrypt at its
  test floor (`core/vault/testing.js` TEST_KDF). `vyre` drops node 22's "SQLite is an
  experimental feature" line, which broke output read as JSON (`core/quiet.js`, loaded first by
  `bin/vyre`; the box image already sets NODE_OPTIONS for it). The installer tests hide a real
  Docker when a test takes it away, box add's rig answers `id -nG` without the docker group, the
  presence challenge test pins `role: local` (Linux defaults to the box), the bypass test reads
  the hook's stdout only, and the real Capsule helper tests skip off macOS.

#### The vault writes nothing after it stops

- 200 ms after start the vault pulls its shared vaults, and with none it still asked for this
  device's identity, which made a key, the agent vault key and an identity item. When that timer
  fired after a test had removed its home, it put `vault/` back: the intermittent leaked
  `vyre-test-*` home holding only `vault/` (three in one full run on the test box, from `link`,
  `computers` and `switchboard` tests, any in-process vyred). With no shared vaults the pull now
  does nothing (`core/vault/shared.js`). Both start-up syncs go through `vault.later()`, and
  `vault.stop()` cancels the waiting ones, awaits the running ones and refuses to open or make a
  key from then on (`core/vault/vault.js`, `index.js`, `devices.js`). `core/vault/stop.test.js`.
- `tempHome` records which test made each home in `<SCRATCH>.homes`, beside SCRATCH so it
  survives the home's removal, and `test/tmp-guard.mjs` names that test next to a leaked folder.

#### Journey 1 no longer races box add for the tunnel

- `vyre box add` takes the onboarding tunnel down as soon as the address step is done, so the
  journey's last loopback calls (onboard.status, onboard.finish) failed now and then with
  ECONNREFUSED. Once the address serves, the journey finishes from the box's own terminal
  (`vyre call` through the host wrapper, `test/journey/rig.js` terminal), since the harness cannot
  reach the address as the owner. The fake box tailscale now names this account as its operator,
  so the journey also runs on Linux. Journeys 1 to 6 pass together, three runs in a row, on the test box.
#### Tailnet: more of Tailscale, and still never a change to the tailnet (ADR 0014)

- Vyre now knows how the box and a device reach each other. `link.health` says whether the
  connection is direct or relayed, its latency and the last handshake. Each node is checked at
  most once a minute and only when something asks, so it costs nothing while nobody looks. The
  Deck's Network settings and the Capsule show "direct 12 ms" or "relayed via fra 80 ms", so a
  slow screen has a visible reason.
- Glass uses that answer. A viewer on a relayed or slow link gets at most five frame updates a
  second at lower quality, and taps and keys still go through at once, so a phone on a relay sees
  a steady picture instead of a stalled one.
- Files go from the Mac to the box with Taildrop: `vyre send <file>` and `files.send`. Only what
  the files guard passes is sent, so a key or an `.env` never leaves the Mac, and when Taildrop
  cannot reach the box (a tagged box is the usual case) it says why. The box keeps one
  `tailscale file get --loop` blocked in tailscaled, so idle costs nothing, and announces each
  arrival in `files.inbox` as `files.received`. Nothing opens or runs a received file.
- The box can share chosen folders with the paired Mac through Taildrive, so Finder and the
  Capsule open box files where they live instead of pulling a copy. Only named shares that pass
  the guard can be shared, and only by the owner. Vyre cannot edit the policy that decides who
  reaches a share, so `files.drive.audit` checks it and reports any node that is not a paired Mac.
  tailscaled now sees `/work`, read-only unless the owner opts in.
- `vyre box add` and `vyre box move` reach a server on the tailnet over Tailscale SSH first, so no
  key or password is needed, and fall back to the address as typed. A check-mode sign-in link is
  shown on the terminal rather than hidden.
- Onboarding and Settings explain Tailnet Lock and show the exact commands to turn it on from the
  Mac, with the box's key filled in. Vyre only reads the lock's state and never turns it on or
  signs anything, because those commands change the whole tailnet.
- An agent's Chrome can send a chosen list of sites through the owner's Mac, off by default, for
  sites that refuse a datacenter address. The box's own tailscaled never uses an exit node (that
  would route everything); an optional sidecar (`box/compose.egress.yml`) does, in userspace, on
  the computers network only. The listed sites have no direct fallback, so when the Mac is away
  they fail instead of showing the box's address. Only the owner can change the list.
- whois now carries a peer's tags and the app capabilities the tailnet policy grants it, through
  one parser. Every feature below reads them; none writes them.
- The box's tailnet listener tells three peers apart: the owner, a guest from another tailnet
  (`tailnet-guest:<login>`) and an agent's own node (`tailnet:agent:<name>`). Tailscale machine
  sharing used to leave a shared-in person at 403. A guest now reaches only the view-only tools
  the owner listed or the policy granted, within a fixed safe set, and every other tool reads as
  absent. A guest never approves, proves presence or pairs a device. Guests are off until the
  owner turns them on with presence (`network.guests.*`, a new `network` module).
- An agent's node still needs its agent key over the tailnet: whois proves which container, the key
  proves which thread, and neither replaces the other.
- The Vault can ask the tailnet policy before it relays. With `vault.relay.grants: "require"` a
  relayed request also needs a `vyre.run/cap/vault` grant for its item. A grant only narrows: a
  revoked or expired pass stays refused, and no grant shows a value. `vault.grants.status` shows
  who the policy covers.
- Each agent's computer can join the tailnet as its own ephemeral `tag:vyre-agent` node, off by
  default. The key stays in the vault and goes only to a root-only tailnet port, never into the
  container's env or computerd's port, which the agent's own user could take over. The image does
  not carry that side yet, so turning it on reports why and sends nothing.
- Signed webhooks from the internet through Funnel (`core/hooks`, `vyre hooks`), off by default,
  one route at a time, on loopback only. Every route checks the sender's signature against a
  vault secret. A verified delivery is stored and announced as `hook.received` without its body,
  and can do nothing else: it never calls a tool. Watchers can now run on an event filtered by
  payload, so a watcher on one route gets that route's deliveries. Vyre never runs
  `tailscale funnel`; `vyre hooks status` prints the commands and flags mismatches.
- Sharing a folder, adding a guest, opening a webhook route and the tailnet switches are on the
  floor's human-only list, so no model can do them.
- The Deck's Network settings show shares (with a check of who the policy lets in), webhooks,
  guests, agent nodes and egress. Chat and Glass carry a connection dot. Onboarding shows the
  HTTPS switch a ts.net address needs as plain steps, then offers Tailnet Lock. The Capsule sends
  a file to the box with option-return.
- `scripts/perf-check` waits for Memory's startup pass to finish before it measures idle, so a
  slow start on a loaded host is no longer counted as idle CPU.
#### The Capsule answers from memory, and messages a session busy in a terminal

- Quick answers read the memory on screen. When the "From memory" box shows facts or session quotes
  for the same words, the quick question's system prompt carries exactly those lines, with their
  ages, under "What the user's own notes say:". Nothing else from memory is sent.
  `local/capsule/lib/bridge.js` (`memoItems`, `memoLines`, `quickAppend`).
- A transcript hit reads as a quote ("You said, 2 weeks ago: ..."), never as a fact; the distilled
  fact from memory.relevant sits above it. A box with only quotes is labelled "From your sessions".
- The quotes are chosen for the question, not its words (`local/capsule/lib/said.js`): the question
  echoed back, the Capsule's own ask threads ("Capsule: ..." or its scratch folder) and turns that
  quote the whole question are dropped; questions and Claude's words rank under the user's own
  first-person statements; at most two show. When the best is a clear statement ("I own a blue
  Volvo XC40"), one line on top says it to the user ("You own a blue Volvo XC40.") with the quote
  under it as its source. Still no model: the box shows before anything is sent.
- Vyre's notices (a usage limit, the switch to the API key) are a faint status line under the
  answer or the DM, never part of the answer's text. `local/capsule/lib/state.js` keeps them as
  `notice`.
- The switchboard says a usage limit in the thread only at 80% used or more, or when refused.
  Claude Code warns from far lower (27% was seen). `thread.limit` still carries every report.
- The reply shows the user's question as their own line ("You"), then who answers, then the answer.
- `@<session>` for a session open in a terminal no longer refuses. A person's words are queued
  (`threads_inbox`, event `thread.queued`), and the Harness hands them over when that session's
  turn ends: the Stop hook returns `decision: block` with "Message from the user via the Capsule:
  <text>", or the next prompt carries them when the session is idle. The Stop that ends the
  answering turn emits its last message as the thread's `thread.text` and `thread.finished`, so the
  Capsule shows the reply like any other. A model's send (caller `mcp*`) is still refused.
  `vyre threads send` prints "queued". `core/switchboard`, `core/harness`, `core/cli/commands/threads.js`.
- Opening over a full-screen app, behind `VYRE_CAPSULE_STAY=1` until checked: the panel joins every
  Space again before each show, stays above full-screen windows, and becomes key without the app
  activating, so macOS does not switch to the desktop Space. Off by default, where the app still
  activates so typing reaches the panel over a normal app. `local/capsule/lib/present.js`;
  `scripts/capsule-spaces/run.js` checks it against a throwaway full-screen window and runs only
  with `VYRE_FULLSCREEN_OK=1`.
#### The Claude sign-in code is submitted

- Onboarding step 2 typed the pasted code and Enter into `claude setup-token` in one write.
  Claude Code's prompt reads a multi-character chunk as pasted text, Enter included, so the code
  sat in the box unsubmitted, and the page waited a silent minute. The code now goes first and
  Enter on its own 300 ms later; a refused code ("OAuth error: ...") is reported at once, with a
  hint to open the sign-in again for a fresh code. The page says it is checking while it waits.
  `core/onboard/setup-token.js`, `deck/onboard/onboard.js`; the test's fake claude now reads its
  prompt the way Ink does.

#### The box's Deck can approve, seal and delete again

- On a box the Deck is only served at the tailnet address, where calls are `tailnet:<owner>`.
  Every tool whose callers list named `deck` refused that with 403: approving or discarding a held
  item, push settings, deleting an agent, sealing a Vault item. `callerAllowed` in core/modules
  lets the owner's tailnet caller use what the Deck may; agent nodes and guests still may not.
- Settings shows the address the box is served at (a ts.net name) instead of `<name>.vyre.run`.
- `agents.list` carries each agent's instructions, so the agent page shows and edits its job.
- scripts/e2e-headscale: a private-tailnet harness that walks onboarding, the passkey, the Deck
  and Mac pairing without a Tailscale account.

#### The Capsule is Spotlight's size

- The panel is 680 px wide with a 56 px bar (was 560 and 52), the size of Spotlight, which it
  replaces. `local/capsule/app/main.js`, `capsule.css`.

#### The login keychain and every dialog belong to ~/.vyre alone

- A dev world (`deck/test/world.js`), a demo and a stress run each started a real vyred on a temp
  `VYRE_HOME` outside `node --test`, so the vault's test guard did not apply: with no
  `vault.keystore` a Mac defaulted to the login keychain, and 32 `vyre-vault` items built up in the
  user's login keychain while prompts kept reaching their screen. All 32 are deleted.
- The vault now uses the login keychain only for `~/.vyre` (the account's home from the user
  database, not `$HOME`) or a home whose config says `vault.keychain: true`. Any other home that
  picks no keystore gets the file keystore; one that asks for `keychain` is refused with a message
  naming both fixes, before any helper is built or `security` runs. `vault.keychain` as a string is
  still a keychain file for tests. `vyre up` on a real Mac install writes `vault.keychain: true`.
- `dialogsAllowed()` (and the Capsule's copy) is false for a `VYRE_HOME` other than `~/.vyre`, and
  vyred started in-process on such a root sets `VYRE_NO_DIALOGS=1` outside tests.
  `VYRE_ALLOW_DIALOGS=1` is the override for a person who keeps Vyre in a custom home on purpose:
  it never applies under `node --test`, and `VYRE_NO_DIALOGS=1` still wins.
- `deck/test/world.js`, `deck/test/vault-shots.js`, `test/fixtures/vyred-present.js` and
  `scripts/release-check.sh` pass `VYRE_NO_DIALOGS=1` and the file keystore.
- `core/vault/login-keychain.test.js`: a temp-home vyred outside tests, with a fake `security` and
  `osascript` that record calls, keeps its key in a file, builds no keychain helper and calls
  neither; a temp home that asks for the keychain is refused; the world scripts set the flags.
#### e2e: a real install walked from main

- The onboarding page kept Continue off on step 1 whenever the box had no vyre.run zone token,
  which is every box: "That name is not free: could not check". A name the check cannot run for
  is fine now, since the address is the ts.net one, chosen in step 4. The name field also gets the
  same `input` style as the assistant's.
- `vyre up` waited 5s for a first vyred to answer and then said it did not start, while it was
  still starting (6s on a loaded Mac). It waits up to 15s now.
#### Chat lists your Claude Code sessions and follows them live

- Chat lists every Claude Code session on this machine (`projects.catalog`, from the transcripts)
  merged with the Switchboard's headless threads (`threads.list`), one row per session. Before,
  it listed only headless threads, so a project with three sessions read "No sessions".
- A session the Switchboard never ran opens from its transcript (`recall.thread`) and follows it
  live: Recall emits `session.indexed` for it after each turn, and the view reads only the new
  turns. After a send adopts it, the view follows `thread.*` events instead, so no turn shows twice.
- Recall indexes one session about 1.5 s after the harness reports `turn.completed` or
  `thread.started` for it (`Indexer.session`), so no timer and no full pass is needed.
- On a phone, /chat lists the projects and recent sessions, a project page has a Back link and its
  name, and the session header's back arrow points left. The composer keeps one error note and
  gives back the words a refused send held.

#### Deck: Chat on the phone tab bar, Glass with no box, Memory loads at once

- The phone tab bar has five tabs: Now, Projects, Chat, Ask and Agents. Ask has its own icon, and
  the labels lose some tracking below 360 px so all five fit at 320 px.
- Long thread and project titles on Now truncate with an ellipsis on the phone instead of running
  off the right edge.
- Memory starts its first read at once. It used to wait up to 800 ms for the fonts first and could
  sit on "Reading memory". A draw made before the fonts land is redone once when they do, and an
  error shows a Try again button.
- Glass on a machine with no box (the glass module is off or vyred does not answer) says where the
  agent's computer runs and how to pair one (`vyre box add you@your-server`), and offers no Take
  over, no Sign in privately and no activity rail.
- `agents.list` returns each agent's instructions, so an agent's page shows its job instead of "No
  instructions yet".
- The box's Chromium starts with `--test-type`, which keeps its `--no-sandbox` warning bar out of
  the Glass stream. Takes effect when the computer image is rebuilt.
- `deck/test/world.js` makes its home under `SCRATCH`, uses a key-file vault (never the login
  keychain), and seeds juno, kit and six fictional vault items. The items go in through a
  short-lived vyred with the test presence verifier, which stops before the real vyred starts.
  `test/fixtures/vyred-present.js` compares real paths, so a realpath'd temp home on macOS passes.

#### Tests keep their temp folders under SCRATCH

- Test runs kept leaving folders bare in `$TMPDIR` (`vyre-local-*`, `vyre-frec-*`, `vyre-clip-*`
  and others). Every test that made a temp folder with `os.tmpdir()` now makes it under `SCRATCH`
  (`test/scratch.mjs`, one folder per checkout) and removes it when the test ends.
- The leaks at the source: `local/capsule/lib/local.test.js` never removed its folders (five a
  run); the frecency tests there and in `launcher.test.js` removed the folder, then the 500 ms save
  timer fired and made it again. Both now save before removing.
- Product code that makes its own temp folders, backup staging (`core/names/backup.js`, used by
  `vyre backup`) and image thumbnails (`core/files/index.js`), puts them under `VYRE_TMPDIR` when
  it is set. `test/scratch.mjs` sets it to `SCRATCH`, so tests and every vyre or vyred they spawn
  stay inside it. Both already removed their folder in a `finally`.
- `vyre box` keeps its ssh control folder in `/tmp` (a socket path must be short), and now also
  removes it when the process exits without calling close().
- `local/capsule/build.sh` makes its plist under `$TMPDIR` and removes it on a signal as well
  as on a normal exit.
- The `npm test` leak guard (`test/tmp-guard.mjs`) also fails on new `vyre-*`, `vy-*`, `vssh-*`
  and `computerd-*` entries left bare in `$TMPDIR`, counting only ones that did not exist before
  the run and were changed after it began, so a sibling worktree's older leftovers do not count.

#### No Touch ID prompt, or anything else on screen, under tests

- A test run raised a real Touch ID dialog ("Relax Vyre lesson 1") on the user's screen: presence's
  Touch ID helper had no test gate. The rule the vault's helpers used now lives in
  `core/config/dialogs.js` (`dialogsAllowed`: never under `node --test` unless `VYRE_TEST_DIALOGS=1`,
  never with `VYRE_NO_DIALOGS=1`). A vyred or CLI a test spawns inherits `NODE_TEST_CONTEXT`.
- Presence never offers or tries the real Touch ID then, and refuses a `touchid` proof with code
  `no_dialog` (403 on the socket; the CLI does not retry it). `authenticate()` in
  `core/presence/touchid` refuses before the helper runs, and `swiftHelper()` runs only `--check`.
  A stand-in injected by a test still runs.
- The same gate on every other thing that reaches the screen: the browser (`vyre up`, `vyre box add`
  and the recovery kit, unless `VYRE_OPEN_BIN` names a fake), `vyre capsule`, the Capsule's
  autostart in vyred, the Capsule's own `/usr/bin/open` (a copy of the rule in
  `local/capsule/lib/dialogs.js`, since the packaged app carries no `core`), the hands-mac
  Accessibility helper, and `security` on the login keychain (a test keychain file still works).
- Nor does presence write its terminal code under tests: it would land in a login terminal the
  user holds. `tty` is not offered then, and a challenge for it answers `no_dialog`.

#### Learning meets presence

- The `confirm.js` stopgap is gone. `vyre learn` asks for the human-only learn tools through
  `callAsPerson`, as `vyre call` does, and vyred checks the proof (ADR 0004). The CLI tests assert
  refusals against the real verifier and approvals with `upPresent`.
- The floor's list named `learn.skill_install`, a tool that does not exist; it is
  `learn.skill-install`, and the Deck's Install button called the same wrong name. A test fails
  when the list names a tool no shipped module declares (`vault.export` is held in reserve).

#### Presence: a person proves they are there (ADR 0004)

- A model could approve its own held email. The caller is only a header on a socket the user
  owns, and Claude Code's Bash runs as that user, so `curl --unix-socket` with
  `x-vyre-caller: cli`, or plain `vyre call gate.approve`, was enough. Human-only tools now need
  a presence proof that vyred checks itself, whatever the caller claims. The floor keeps its own
  list (`core/presence/index.js`: gate approve, revise and reject, threads.answer, vault put,
  approve, unlock and offboard, learn accept and retire, and presence's own tools). Modules add to
  it with `presence: true` or `presence: { summary(input) }`. Module callers are exempt.
- The proofs: `touchid` (vyred shows the macOS dialog with the summary; one at a time, and it
  waits 30 seconds after a cancel), `tty` (vyred writes a code to a login terminal that `who`
  lists, and the person types it back), `capsule` (an Ed25519 signature from a key in the
  keychain), `passkey` (a WebAuthn assertion from the Deck) and `code` (a one-time code for
  enrolling a passkey). Each proof is bound to one tool and one input and is used once.
  `POST /v1/presence/challenge` starts the tty and passkey proofs. `GET /v1/tools` marks presence tools.
- `vyre call` and `vyre presence keys|code|remove` prove presence through `core/cli/presence.js`.
  The CLI asks for a controlling terminal before any method. The Bash tool has none, so a model
  cannot even make a Touch ID dialog appear through the CLI.
- The floor closes the model's routes before they reach vyred, and does so in-process when vyred
  is down too. It denies human-only `vyre` commands however they are quoted, escaped or wrapped
  (`sh -c`, `eval`, `xargs`, `env`, `script`, `osascript`, `npx`, `node bin/vyre`). It denies
  raw clients on vyred's socket, any `x-vyre-caller` or `x-vyre-presence` header, and reads or
  writes of vyre.db, the socket, config, keys and logs, by path, by name or by glob. A vyre
  command or socket target built at run time is asked about. `watchers/` stays open, and a
  write into `modules/` is asked about.
- The Touch ID helper (`core/presence/touchid/touchid.swift`) is built with `swiftc` into a
  private temp folder on first use, and its hash is checked before every run.
- Tests that exercise what happens after approval start vyred with `present` from
  `test/helpers.js`, a verifier that always finds a person, or through
  `test/fixtures/vyred-present.js` for CLI tests. That fixture refuses any home outside the temp folder.
- After review with the other workstreams:
  - The floor's list now covers the vault's value-out tools, `learn.relax` and
    `learn.skill-install`, `computers.takeover` and `computers.giveback`, and `link.pair.approve`.
  - Tools get `presence: { method, keyId }` in run()'s context, never the proof.
  - On the box, a terminal code only enrolls the first passkey, since a model on the Mac can
    usually SSH into a login terminal there.
  - The floor denies the vault's value-out `vyre` commands, root through docker (privileged, host
    namespaces, host binds, the docker socket) and any use of the box's Docker API proxy. It asks
    before reading the clipboard.
  - `swiftHelper()` builds another module's Swift helper under the same hash check.
- A short presence session: after Touch ID, a Capsule signature or a passkey,
  `presence.session.open` returns a secret that proves `vault.reveal`, `vault.copy` and
  `vault.totp` for 5 minutes idle and 30 at most, on the same device. The tool must also agree
  for that input, so an item that asks every time never rides a session. The box never takes a
  terminal code: its first passkey comes from onboarding's one-time code, which enrolls only
  from the owner's own device over the tailnet, and only for the box's own address. The floor asks before `vyre box add`.
- One real run: `claude -p --model haiku` with the Harness, told to approve its own held draft by
  every route it could find. It tried 16 routes, and every one was refused. Nothing reached
  the mail stub.

#### Box: Vyre's own Docker proxy for agents' computers

- `core/dockerproxy` replaces `tecnativa/docker-socket-proxy` as the `docker-api` service. It
  allows only the endpoints `core/computers/driver/docker.js` uses, plus exec and volume inspect
  on computers, and refuses the rest with 403. It reads every body: a create must pass
  `core/computers/driver/policy.js` against the box's `VYRE_COMPUTERS_*` settings, and an
  existing volume it mounts must already belong to the same agent. Every per-container op and
  exec start is checked against labels from the Engine's own inspect. List gets the computer
  label filter forced. Bodies are capped at 256 KiB, duplicate keys are refused, and the proxy
  forwards its own re-serialisation, never the caller's bytes. Attached (upgraded) exec is
  refused. The proxy runs from the vyre image as uid 1000 in the socket's group, with a read-only
  root and no capabilities. `install-box.sh` writes that group to `/srv/vyre/.env` as
  `DOCKER_GID`, and adds it to an existing `.env` that lacks it. It checks creates with
  Computers' own `policy.js`.

#### `vyre link` points to the Deck

- On a box, approving a pairing needs the owner's passkey, which only the Deck can give. So
  `vyre link pair` and `vyre link` now say "approve it in your Deck" with the code. When
  `vyre link approve` gets `presence_required`, it points there instead of printing an error.

#### Pairing needs the owner's presence

- Security's review found that the box's terminal is not proof of presence. Claude's processes
  share the box's socket. Worse, a model on the Mac can read the pairing code the Mac shows and
  run `ssh box vyre link approve <code>`. So `link.pair.approve` is on the floor's presence list
  (ADR 0004): approving takes a passkey from the Deck, whoever calls. The link's own checks stay
  as a second line: never approved from the requesting node, and the key goes only to that node.
  The approval prompt names the Mac that asked ("Pair the Mac \"work laptop\" (node) with this
  box") and never shows the code. Refusals for missing presence do not use up the request.
- `link.find` reads a peer's certificate on a connection that skips verification. A test now
  checks that nothing is ever written on that connection.

#### Files: in step with Glass

- The files guard also refuses a browser's `Cookies`, `Login Data` and `Web Data` files and any
  folder named `secrets`, as Glass's guard does. On a Mac the default root is the home folder,
  which holds every Chrome profile.

#### Install (ADR 0008)

- `vyre box add` opens the owner's first-passkey link (`onboard.link`'s `passkeyUrl`, handed
  only to the box's own terminal) before it starts pairing, since that passkey is what approves the
  Mac in the Deck. Both doors print one approval line; there is no terminal approval on a box.
- Pairing follows the presence floor: `vyre box add` and `vyre up` on a Mac start pairing and ask
  for the approval in the Deck, with the passkey onboarding enrolled. `vyre box add` no longer
  approves over SSH: anything in the box's container could run the same command.
- From the first real run on a Linux server: a box that finished onboarding without an address
  opens the browser again on the next `vyre box add`, so the address can be finished there; the
  plan names the wrapper it will really write; a pairing that SSH cannot approve (a box with a
  passkey) points at the Deck on the phone.
- `vyre box add` forwards `VYRE_WRAPPER` with `VYRE_DIR` and `VYRE_BOX_URL`, so a second stack on
  one server can be installed without replacing the host's own `/usr/local/bin/vyre`.
- `vyre box` hardening: a `user@host` whose user or host starts with `-` is refused, and every ssh
  call puts `--` before the target; calls after the master use `BatchMode` and `ServerAlive`.
  When sudo needs a password and the account is not in the docker group, the plan says so and
  the install adds it in the same terminal session, then reconnects. The wait gives up after 65
  minutes and says how to carry on. `backup` checks the volumes first, arms the restart before
  stopping, writes through `.partial` and needs `--force` to replace a file. `move` refuses a
  server with old Vyre volumes, clears the installer's fresh stack before copying, checks the new
  box answers from the Mac before uninstalling the old one, and starts the old stack again on any
  failure. Ctrl-C in `add`, `move` or `backup` closes the SSH master and its `/tmp` folder.
- The npm package carries `scripts/install-box.sh`, which `vyre box add` copies to the server so
  the box files match the Mac's version, and `docs/JOURNEY.md`. `release-check.sh` checks the
  installer is in the tarball.
- `vyre box add` approves its own pairing: the Mac asks `link.pair`, and the code is approved as
  `vyre link approve` on the box over the SSH connection that just proved the person owns it. A
  box that already finished onboarding skips the link, tunnel and browser. Onboarding finished
  without an address ends with "Almost there" and what is left, instead of "Vyre is ready."
- `test/journey.test.js`: the install journey end to end on one machine. A fresh Mac and a fresh
  Linux server are two temp homes (`test/journey/rig.js`) with fake ssh, docker, tailscale, claude
  and browser; both vyreds, `vyre box add`, `vyre up --json`, the installer, the host wrapper and
  the onboarding page are real. Six scenarios: door A through the browser to the ready block,
  door A resumed, door A refused, door B with the Mac looking for the box, a signed-out Mac, and
  `vyre up --json` on a finished box. Gaps against ADR 0008 stay as todo subtests naming the code.
- The journey harness follows `box add` pairing over SSH and the finished-box resume: door A runs
  the real installer, a resume opens no browser and no tunnel, and the Mac's discovery step is
  skipped where the real Tailscale app is installed, since the link module would run it.
- The journey harness follows pairing approved in the Deck, `--` before ssh targets, the preflight's
  read-only volume check, and a resume that reopens the browser only while the address is unset.
  The Mac's discovery step runs again now that the link module honours VYRE_TAILSCALE_BIN.
- `test/helpers.js` points `VYRE_TAILSCALE_BIN` at a path that does not exist, so no test runs the
  machine's real `tailscale` when `vyre up` looks for a box.
- `vyre box add <user@host>` (ADR 0008 section 2): checks the Mac is on its tailnet, reaches the
  server over SSH (a password is asked once, then one held connection), reads the server in one
  call, shows the plan and asks once (`--yes` skips; no terminal and no `--yes` changes nothing),
  copies this package's `install-box.sh` over and runs it with `-t` so sudo can ask, takes the
  link from `vyre up --json` (or its text), forwards the port through the held connection, opens
  the browser, prints each onboarding step as it is done, then saves `box.ssh` and `network.box`,
  starts this Mac's vyred, pairs when `link.pair` exists, and prints the ready block. A box that
  is already there carries on from where it stands; Ctrl-C leaves it as it is.
- `vyre box` (status), `update`, `backup [file]` (the three volumes in one 0600 `.tar.gz`),
  `move <user@newhost>` (installs with `VYRE_NO_UP=1`, streams the volumes through the Mac, runs
  `--uninstall` on the old host) and `remove [--purge]`, all over the saved `box.ssh`.
- `core/cli/ssh.js`: a small client over the system `ssh`: a ControlMaster in a 0700 folder under
  `/tmp`, `run`, `json`, `put` (cat, no scp), `tunnel` (`-O forward` on the master; a taken port
  is named with what holds it), and a tested shell `quote`.
- `vyre up` on a Mac: with no box known it finds one among the tailnet's peers (one answer is
  saved; several are listed and asked about), otherwise asks "Where should Vyre run?" (a server
  through `vyre box add`, this Mac, or an address). Without a terminal it prints the three
  commands. With a box known it checks the box answers from here, pairs through `link.status` /
  `link.pair` when those tools exist, and prints the "Vyre is ready." block. A box after
  onboarding prints the same block. `vyre up --box` on a Mac also opens the link in the browser.
- `vyre up --json`: one object `{ role, version, url, port, ssh, address, box, ready }` on exit 0,
  or `{ error: { code, message } }` on exit 1.
- `vyre capsule install`: downloads `Vyre-mac.zip`, checks it against `SHA256SUMS`, unpacks it
  with ditto into `~/Applications/Vyre.app` (asks before replacing one; `--yes`). Never
  `/Applications`, never sudo.
- `vyre capsule install` checks the zip against `box/Vyre-mac.sha256` in the npm package when
  release ships it (SHA256SUMS then only cross-checks), and refuses a zip holding anything but
  one real `Vyre.app` folder (no entries beside it, no symlinked app).
- `vyre up`: `--connect` with no address is refused (`no_address`), `--json --system` is refused
  (`bad_input`), and any throw under `--json` is one `{ error: { code: "failed" } }` object.
- `core/cli/ending.js`: the "Vyre is ready." block (ADR 0008 section 6), shared by `vyre box add`
  and `vyre up`.
- `core/cli/tailnet.js`: the Mac's own view of its tailnet, read-only (`tailscale status --json`
  through PATH or the Mac app's CLI), and `probe()` for a box's `/v1/health`. Finding the box
  among the peers is `link.find`.
- ADR 0008 and `docs/JOURNEY.md`: the install journey from one command to the assistant's hello.

#### Learning: accept by reply from a person only; presence codes; jobs; skill plugins

- Accept or decline by reply only when a person typed the prompt into an interactive Claude
  Code (Security's condition). The enrich hook, for a plain yes or no only, runs `ps -o
  tty=,args=` on its parent once (500 ms timeout): a `claude` with a terminal and none of `-p`,
  `--print`, `--output-format`, `--input-format`, and not a Switchboard thread (`VYRE_THREAD`
  is the session) or an agent's (`VYRE_AGENT`). `harness.enrich` and `learn.signal` take
  `interactive` (absent means no; an agent's thread never is). The proposal must have been told
  in the turn just before (a number no longer reaches earlier turns), and that turn must have
  passed a Stop (a yes mid-turn no longer accepts). Otherwise nothing changes and Claude tells
  the user to accept with `vyre learn accept <id>`, the Deck or the Capsule. ps costs 1.3 ms p50,
  2.3 ms p95; the hook about 4 ms more on a yes or no, nothing on other prompts.
- `learn.edit` refusals that only a person can get past (a loosening: `learn.relax`; a proposed
  lesson: `learn.accept`) throw code `presence_required` with `detail {tool, id}`, for surfaces'
  presence flows once main's registry passes codes through. The CLI's terminal confirm stays.
- Distillation jobs: the `thread.stopped {reason: "done"}` that follows a one-shot job's
  `thread.text {done: true}` at once waits for the answer's handler (it could mark the job
  failed, then done). Notices and deltas are never the answer.
- Learned skill plugins as the Switchboard loads them: a private project's is
  `vyre-learned-<slug>` (was `vyre-learned-project-<slug>`), an agent's
  `vyre-learned-agent-<name>`, lower-case kebab; `pluginDirs` keeps any folder with a
  `plugin.json`, as `learnedDirs` does.
- The preference taught to Memory names the user as `{ kind: "me" }` (Memory's `me:you`), not a
  person called "the user". Memory's teach() must map it; until then it is logged as not taught.

#### Learning: review fixes (ADR 0007, decision 11)

- The human-only learn tools (accept, retire, relax, skill-install, skill-retire, skill-dismiss)
  refuse the `local` caller. Until ADR 0004's registry enforces presence, `vyre learn` and
  `vyre call` ask the person at a terminal to type the id back, and refuse with no terminal or no
  `/dev/tty` (Claude's Bash has neither). New `core/cli/confirm.js`.
- A forged enrich no longer restarts the turn: the same prompt_id is a duplicate, and a prompt
  before the last turn passed a Stop keeps its edits and send-back count and declines nothing.
  Offline the same. A migration adds `learn_turns.stopped`.
- weakens() asks for `vyre learn scope`, `vyre learn skills install|retire|dismiss`, `claude
  plugin disable|uninstall|remove`, writes under `~/.claude/plugins/`, running `hook.js` by hand,
  and scripts that call a human-only tool through vyred. The store, `learned/`, hooks, plugins
  and human-only tools are guarded with no lesson active. Store names count only in the home,
  hooks only under the loaded plugin root (`plugin_root` on `harness.rules`), and git `-m`
  messages are ignored.
- distill() skips questions, firm words about someone else, and instructions for now ("yet",
  "for now", "here", "this time", "for this PR"); "stop the server" is not a soft correction.
- A declined-command proposal needs 3 nos in at least 2 sessions; headless threads infer none.
- `learn.edit` refuses a proposed lesson. PreToolUse fetches 1 `harness_files` row; index
  `learn_writes (path, done)`.

#### Learning: more signals, behaviour proposals, jobs, scope, metrics and skills (ADR 0007, decisions 6 to 10 and 12)

- Check kinds `tool` (a tool or shell command ruled out, optionally `instead`), `path` (files
  kept out of, held at PreToolUse on writes and on shell commands that write) and `after` (a
  command that must run after changing matching files, checked at Stop in order). `paths` on any
  check narrows it to files: a text check with paths applies to what is written there, not to
  the reply. All work offline, where the order comes from the per-session counter.
- `distill()` learns: an unquoted banned phrase ("never say circle back", "don't use the word
  synergy"), "don't use sed -i", "never push to main", "use pnpm not npm" (and "don't use npm,
  use pnpm"), "don't touch migrations/", "in docs never use X", "always run lint after editing
  ts", "run X before Y", and the scope words "in this repo" and "everywhere". "run the tests
  before we merge", "use the blue button not the red one" and other ordinary prompts do not
  distill (negative tests).
- Signals carry `key`, `project`, `agent` and `meta` (a migration on `learn_signals`): `repeated`
  (the same key from 2+ sessions in 30 days), `rejected` (`gate.rejected`, kinds and ids only),
  `reverted` and `rewritten` (sha256 of a file up to 256 KB before and after Claude writes it;
  at the next prompt or Stop at most 20 recent writes are statted, then hashed only when mtime or
  size moved; Claude's own git checkout or a command naming the file is not the user), `failed`
  and `fixed` (a new internal `learn.observe`), `test-fix` and `untested` runs, `declined`
  (PreToolUse saw it, Vyre did not hold it, no Post or PostFailure by Stop), `denied` and
  `allowed` (`ask.answered`), and `corrected` (`memory.corrected`, counted per `prior_rule`, no
  lesson for Claude). No signal keeps content: keys are hashes, meta holds shapes and kinds.
- Behaviour becomes a proposal, never above ask: one file reverted in 2 sessions proposes a
  `path` check at ask; one command shape declined or denied 3 times in 14 days with no allow
  proposes a `tool` check at ask; tests failing, code changed and no test after it proposes an
  `after` check at remind. Each is told once in the thread it came from, and a plain yes accepts
  it there.
- Jobs (`learn_jobs`): plain-words corrections (and a soft one said in two sessions) queue for
  a model. `pump()` runs on events only: one at a time, 10 minutes apart, at most
  `learn.distill.daily` (default 6) a day, never while a Switchboard thread is working, through
  `threads.launch {model: "haiku", plugin: false, tools: "none", settings: false, once: true,
  budget_usd: 0.05}`. The answer must be one JSON object; it is validated like a person's input
  and only ever proposed (`source {kind: "model", job}`), replacing the plain-words proposal
  while that still waits. Without the Switchboard jobs wait, capped at 200, and `vyre learn
  signals` shows them to write by hand. New event `distill.finished {job, kind, ok, lesson,
  skill}`.
- Scope is inferred: a scope word, then the agent, then a project for path, after, before,
  touched and tool checks, else everywhere; a key already said in another project widens to
  everywhere and says so. Narrowing (a project, an agent, `paths`) is `learn.relax`; widening
  back is `learn.edit`.
- "use pnpm not npm", accepted, teaches Memory a `preference` (`subject: "the user"`, `rel:
  prefers`, `key: lesson:<id>`) through `ctx.memory.teach`; retiring the lesson forgets it.
- Metrics: `learn_days` (turns per day, project and agent) and `learn_lesson_days` (applied,
  caught, broken, repeats). `learn.stats {id?}` returns `{before, after, escapes, attempts,
  turns, verdict}`. A lesson quiet for 60 days and 200 turns in scope goes dormant (out of the
  brief and reminders, still checked, `lesson.dormant`) and wakes on a catch; an ask lesson
  allowed 5 times out of 5 emits `lesson.allowed` for the user to decide on a demotion.
- Skills wired: steps recorded at Stop, the turn marked clean at the next prompt, a procedure
  clean in 3 sessions proposed (a drafting job when the Switchboard answers, else the template).
  New tools `learn.skills {status?}` (with drift), `learn.skill-install`, `learn.skill-retire`
  (owner callers, presence) and `learn.skill-dismiss`. A retired skill's procedure is never
  proposed again. The account plugin moved to `<home>/learned/account`, where the Switchboard's
  `learnedDirs` already loads it. Skill events carry ids, counts and kinds only.
- `learn.signals {kind?, since?, limit?}` (owner callers): signals without text, counts, repeats
  by key, Memory corrections per rule, and jobs.
- Retention: `learn_commands`, `learn_calls`, `learn_writes` and `learn_turns` keep 7 days,
  pruned at start and at most hourly from Stop; daily from Stop, dormancy, old procedures (90
  days), finished jobs (30 days) and metrics older than a year. No timers.
- Harness: `harness.rules` passes `tool_use_id`; `harness.learn` also takes Bash and failures
  (`ok: false`, `error_head`, `interrupted`) and calls `learn.observe`. `hooks.json` widens
  PostToolUse to Bash and adds a PostToolUseFailure piece (`hook.js fail`), whose fields
  (`tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms`) were read from Claude
  Code 2.1.283 itself; the hook reads them tolerantly.
- CLI: `vyre learn` gains an effect column; new `show`, `scope`, `relax`, `stats`, `signals`,
  `skills [show|install|retire|dismiss]`.
- Hook cost with 50 active lessons, in process: `harness.rules` p50 2.2 ms, p95 3.3 ms;
  `harness.stop` p50 2.3 ms, p95 4.0 ms; `harness.enrich` p50 0.3 ms.

#### Learning: enforcement that cannot be dodged (ADR 0007, decisions 8, 9, 11 and 12)

- Project lessons now apply. `inScope` read `projects.of().project`, which does not exist, so a
  lesson scoped to a project never held anywhere. `scope.project` holds the slug; a name, home or
  folder (older lessons, or what a person typed) still matches and is stored as the slug.
- Accept by reply. A proposal told to a thread is answered by the user's next prompt, read in
  `learn.signal`: a plain yes ("yes", "keep it", "yes keep lesson 7", "sure", "do it") accepts it
  inside Learning, a plain no ("no", "don't", "drop it", "no thanks") declines it (retired,
  `source.declined`). Anything else leaves it waiting. Claude is no longer told to call
  `learn_accept`; it is told it cannot.
- `learn.accept`, `learn.retire` and the new `learn.relax` declare `presence` with a summary
  naming the lesson, and take only `cli`, `local`, `deck` and `capsule` callers, so MCP, agents
  and hooks are refused before the presence registry lands.
- `learn.edit` only tightens. Lowering the level, narrowing or moving the scope, changing or
  removing the check, narrowing `when`, lowering `max_level`, pinning or rewriting the rule is
  refused with an error naming `learn.relax`. New columns `max_level` and `pinned`; escalation
  stops at `max_level` and never moves a pinned lesson. `vyre learn level` lowers through
  `learn.relax`.
- Guards (`weakens()`), asked wherever any lesson is active, online and offline: writes or shell
  commands reaching `lessons.json`, `learn-offline/`, `vyre.db`, the socket, `vyred.pid` or
  `learned/` in the Vyre home (by path, `~`, `$HOME`, `$VYRE_HOME` or a glob), the Harness's
  `hooks/`, Claude Code settings files, `vyre call learn.*|harness.*`, `vyre learn
  retire|relax|edit|level|accept`, raw socket clients, and stopping vyred (`vyre down`, `pkill`,
  `kill` by pid file, `launchctl`, `systemctl`). Read-only commands and other folders pass.
- Offline is complete. `lessons.json` is version 2 and carries each project lesson's slug and
  folders; the hook matches `cwd` by prefix (longest folder wins) and still reads version 1.
  When the file is missing or unreadable the hook reads active lessons from `vyre.db`, read-only
  with a 200 ms busy timeout (about 5 ms more per hook process, measured). vyred keeps the
  snapshot's sha256 in `learn_state`; a file changed or removed while it was down is a `tampered`
  signal (no content) and a `lesson.tampered {}` event, then rewritten.
- After the cap. A turn can no longer reset its block count by showing another `prompt_id`: only
  a real prompt or a Stop with `stop_hook_active` false starts it over, online and offline. The
  next prompt in that thread opens with the broken lesson, ahead of memory; the next brief in
  scope says "Lesson N was broken M times this week"; `lesson.broken` carries `{lesson, session,
  level, stage}`.

#### Link and the real Tailscale

- `core/link/transport.js` ignored `VYRE_TAILSCALE_BIN` and ran the Mac's Tailscale app (or
  `tailscale` on the PATH) for whois and status. A test that ran `vyre up` on a Mac could
  therefore query the user's real Tailscale. The link now uses `VYRE_TAILSCALE_BIN` when it is
  set. Under `node --test` it never uses the real binary unless a test opts in with
  `VYRE_TEST_REAL_TAILSCALE=1`. Without one, whois answers "unknown peer" and the peer list is
  empty. A test fails if the real app is resolved during tests.

#### Release

- `package.json` "files": the tarball carries what runs (bin, core, harness, local, deck,
  modules, box) plus SPEC, MODULES, INSTALL, GETTING-STARTED and the ADRs. It leaves out tests,
  fixtures, `testing` helpers, design boards, working notes and Capsule build output: 186 files,
  about 570 KB packed. The embedder stays an optional dependency. npm -g still installs it
  (about 480 MB), because npm ignores `--omit=optional` for a global package's own optional deps.
- `scripts/build-site.sh --src <checkout> [--mac-zip <zip>]` puts what the box installer downloads
  under `site/box/`: the compose files, the host wrapper, the Dockerfile, `install-box.sh`,
  `vyre.tgz` (npm pack, until the package is on npm), `Vyre-mac.zip`, `VERSION` and `SHA256SUMS`.
  It also copies the installer to `site/install.sh`. All generated and gitignored. The Capsule
  zip (about 120 MB) is over Pages' 25 MiB file limit. It goes to the R2 bucket `vyre-downloads`
  (`dl.vyre.run`) under a key named by its hash, and the generated `site/_redirects` sends
  `/box/Vyre-mac.zip` there. Before zipping, the whole Vyre.app is ad-hoc signed
  (`codesign --force --deep -s -`). Packager signs only the Electron binary, which fails
  `codesign --verify`, and a downloaded app in that state is refused as damaged.
- `scripts/release-check.sh [--skip-tests] [--claude] [--live]`: the suite, then the pack and what
  the tarball may and may not hold. Then a global install into a temp prefix, and `vyre up`,
  `status`, `modules`, `call` and `down` in a temp HOME. Then the Harness MCP server from the
  installed folder, and with `--claude` a real `claude -p --plugin-dir` call. Then `site/box`
  against its checksums, and with `--live` the bytes vyre.run actually serves.
- `vyre up` on a Mac (role `local`) now finishes the Mac's setup once the box answers. If the
  Mac is not paired, it starts pairing and prints the `vyre link approve <code>` line to run on
  the box, or shows the code of a pairing already waiting. Then it opens the Capsule
  (`vyre capsule`), or points at the Vyre-mac.zip download when no Capsule is installed.
  `--no-capsule` skips the Capsule.
  With no box configured it asks `link.find` and takes the one box on the tailnet, if there is exactly one.
- `scripts/release.sh [--ref REF] [--claude] [--skip-tests] [--mac] [--dry-run]`: puts REF
  (default main) on vyre.run from a scratch worktree. It rebuilds and uploads the Capsule zip
  only when `local/capsule` changed since the live zip (`Vyre-mac.source`), then builds the
  site and runs release-check. It deploys only when vyre.run serves something different, then
  checks the live site and prints a summary. Running it twice changes nothing.
- `SHA256SUMS` lists `Vyre-mac.zip` too, though it is served from R2, for `vyre capsule install`.
  vyre.tgz carries `box/Vyre-mac.sha256` (the zip's checksum alone), so a Mac's install can pin the
  zip to its own version.
- `/start` and GETTING-STARTED: "What works today" and "What's coming" replace "What is not
  finished".
- `scripts/build-mac-zip.sh OUT.zip`: `vyre capsule build --app`, whole-bundle ad-hoc signing,
  zip, and a signature check after unzipping; the build output is deleted afterwards.
  `release-check` runs perf-check after the suite (`--skip-perf` to leave it out).
- `docs/GETTING-STARTED.md` and the site's `/start` page: the server one-liner, onboarding over
  `ssh -L`, the Mac install from the tarball, the unsigned Capsule's first open, and what is not
  finished. `site/404.html`: missing files now answer 404, where Pages served the landing page
  with 200.

#### Glass

- ADR 0005: Glass is a module and a set of Deck views on top of computers. RFB over a WebSocket
  stays the stream (ADR 0003). A hidden tab disconnects, so a background Deck runs no timer.
- `core/glass` (module `glass`, role box). Tools: `glass.targets`, `open`, `close`, `take`,
  `release`, and `glass.files.list`, `stat`, `preview`, `download`, `upload`, `move`, `mkdir`,
  `trash`. Events: `glass.opened`, `closed`, `taken`, `released`, `file.uploaded`, `moved`,
  `trashed`, `created`, carrying paths and sizes, never content.
- `glass.take` and `glass.release` declare presence. `take {private: true}` is the private
  sign-in: it raises the computers shield, and undoes the take-over when the shield is missing.
  Hand-back leaves a note in the agent's thread (who, how long, the person's note), never what
  was typed.
- The Deck proves presence with a passkey for `glass.take` and `glass.release`: it asks
  `/v1/presence/challenge` for WebAuthn options, gets Touch ID or Face ID, and repeats the same
  call with `x-vyre-presence`, through `attempt(name, input, { presence: true })` in `js/api.js`.
  With no passkey enrolled, it links to Settings to add one.
- Files: one guard for every path. Paths are relative, no `..`, no NUL, symlinks must stay
  inside the root, and secret places (`.vyre`, `.ssh`, `.env*`, keys, Chrome's cookie and
  login stores) are refused and hidden at any depth. Bytes move only on ticketed
  `/v1/glass/raw` and `/v1/glass/put` (one use, 60 s, size-bound), served `nosniff` with a
  sandboxing CSP; only raster images and PDFs are shown inline. An agent reaches only its own
  computer's files through Glass.
- A file whose first 512 bytes are a PEM, OpenSSH or PuTTY private key is refused whatever its
  name: no preview, no download, and an upload of one stops before it lands (the test link's
  files module applies).
- `ctx.route(name, fn)`: a raw HTTP route at `/v1/<module>/<name>`, the same shape link uses.
- `deck/glass`: Screen, Files and a disabled Terminal tab, the take-over bar, Sign in privately,
  a phone layout with touch gestures, drag and drop upload, and drag-out download. noVNC 1.7.0 is
  vendored under `deck/glass/vendor/novnc` (MPL 2.0, as separate files); Glass needs an RFB client
  in the browser and noVNC is the maintained one.
- `computers.helper` (thaws without a screen slot) and `computers.shield` (the hands refuse reads
  as well as input, hands-chrome drops its CDP connection, computerd answers 423 on its eyes and
  hands and cuts CDP pipes), both module-only. computerd serves `/fs` for Glass behind the same
  deny list, with a parity test. `capsule:<device>` is a person's surface.
- Fixed in the first live run on the box: an invalid `PidMode` failed every container create;
  the image lacked `vncpasswd`; a take-over expired at 90 s while the person typed (the relay now
  pings every 30 s and renews on the holder's input and pongs); `.vnc/passwd` was browsable. The
  image no longer sends the clipboard to viewers, refuses resizes and caps at 24 fps.
- Capsule: "Open Glass" for an agent with a computer or a thread of one, and `glass <agent>` /
  `glass box`, opening the paired box's `/glass/<target>` in the default browser.

#### Link heartbeat

- The Mac's link heartbeat ran every 30 seconds on every Mac, paired or not, which broke the
  60-second floor for recurring timers (principle 8, `scripts/perf-check`). It now starts only
  once the Mac is paired, runs once a minute, and stops on unpair or when the box forgets the
  Mac. Recovery does not depend on it, because a failed call only pauses retries.

#### Link follow-ups

- The tailnet peer that box's listener establishes now reaches the tool. `handler(policy)`
  forwards the fourth argument `{ node, stableId, login }`, and the router passes it to
  `registry.call` as `meta.peer`. The box can now tie a pairing and a link key to the Mac's node,
  and it lets the owner approve a pairing from another of their devices. A `peer` in tool input
  is still only input.
- A test drives pairing through the real names listener, with whois simulated. The Mac's node
  starts the request. Approving from that node is refused, and approving from the phone works.
  Only the Mac's node collects the key, and the key is refused from any other node.
- `link.find` on the Mac lists online tailnet peers that answer as a Vyre box. For each one it
  reads the name on the peer's certificate, because the box answers at `<you>.vyre.run` and
  checks Host. It pins the connection to that peer's stable ID. `vyre up` can offer pairing from
  this list.
- Files: the key rule is narrower. A Keynote document is a folder named `*.key`, and the old rule
  hid every one. Now only regular files named `*.key` or `*.pem` are refused, plus any file
  whose first bytes are a private key (PEM, OpenSSH or PuTTY), whatever it is called.

#### Link and files

- `core/link` (module `link`, both roles) makes the Mac and the box one system. The Mac's vyred
  pairs with the box once. The Mac asks for pairing and shows a six-digit code. The owner types
  that code on the box (`vyre link approve 123-456`), or approves from another of their devices.
  A process on the box never sees the code, and the Mac cannot approve its own request, so
  pairing needs the owner at both ends. Codes are kept only in memory, as HMACs under a key made
  at start. Five wrong codes cancel every request.
- The Mac pins the box's Tailscale node when it pairs, and checks every connection's peer with
  its own `tailscale whois` before it writes a byte. A changed DNS record cannot send the Mac to
  another node. The box identifies the Mac by whois too (ADR 0002), so no header is trusted in
  either direction.
- `ctx.remote(tool, input)` lets a Mac module call a box tool. It resolves like `ctx.call`, or to
  `box_unreachable` or `no_link`. Once the box is known to be down, calls fail fast and retry
  with a growing pause, so the Mac keeps working on its own (floor rule 9). Events `link.lost`
  and `link.connected` say when that changes.
- `GET /v1/link/events` on the Mac's socket proxies the box's event stream, each event tagged
  `source: "box"`, so the Capsule sees box threads as they stream. It says `link.down` while the
  box is away instead of hanging.
- `core/files` (module `files`, both roles): `files.search`, `files.stat`, `files.preview` and
  `files.fetch`. The Mac searches with Spotlight. The box searches file names and, with
  ripgrep, contents, under `files.roots` only (default `/work`). A Mac search merges both
  machines, tags each result with its source, and does not wait more than four seconds for the
  box. Every path goes through realpath and must stay inside a root. Vyre's home, the vault,
  credential folders, secret-looking files and dotfiles (apart from a short harmless list) are
  never served or listed. `files.fetch` pulls a box file to the Mac in 1 MiB chunks, and fails
  if the file changes on the way.
- Core: `registry.call` takes a fourth `meta` argument, which reaches `run` beside the caller.
  A network listener uses it to pass the tailnet peer, and it never enters tool input. Modules
  can serve a raw route on the socket at `/v1/<module>/<name>` (`ctx.route`), which is what a
  stream needs. vyred's stop now closes those connections too.
- `vyre link`: status, `pair <address>`, `approve <code>`, `deny <id>`, `unpair`.

#### Push

- `core/push` (module `push`, ADR 0011): Web Push to the Deck and the Capsule for `ask.raised`,
  `gate.held`, `thread.watched` and `lesson.proposed`. The payload is `{kind, title, path, tag, at}`:
  a fixed title and a Deck path holding only an id, never content. Tools, for people's surfaces
  only (`cli`, `local`, `deck`, `capsule`): `push.key` -> `{public_key}`, `push.subscribe
  {subscription, label?}` -> `{device}`, `push.unsubscribe {device|endpoint}`, `push.devices`
  (never the endpoint), `push.settings {quiet?: {start, end, timezone?}|null, kinds?}`,
  `push.test {device?}`.
- VAPID (RFC 8292) and aes128gcm (RFC 8291) use node:crypto only, with no dependency. They match
  RFC 8291 Appendix A byte for byte. The VAPID private key is made on first use and kept in the
  Vault as `push-vapid`, granted to `push`. Endpoints must be https on a known push service host.
  A 404 or 410, or a passed `expirationTime`, drops the device.

#### Switchboard

- `core/switchboard` (module `threads`): headless Claude Code sessions owned by vyred, so they
  outlive every surface. A thread's id is its Claude Code session id, fixed with `--session-id`.
  Tools: `threads.start`, `send`, `list`, `get`, `lease`, `release`, `asks`, `answer`, `stop`.
  Events: `thread.started`, `thread.sent`, `thread.text` (partial text throttled to 20 a second),
  `thread.tool`, `thread.finished`, `thread.stopped`, `ask.raised`, `ask.answered`, `lease.changed`.
  Events stay small: no tool outputs, no thinking, and no hook output, because the user's own
  hooks print whatever they like.
- Permissions: Claude Code 2.1.283 sends `can_use_tool` requests only when given
  `--permission-prompt-tool stdio` as well as `--permission-prompts host`. The second flag alone
  denied every question on the spot. Open asks are rows as well as events, so a surface that
  reconnects can see what is open now. Ask ids are 72 random bits, because an ask id works as
  a capability. A model can never answer one: `threads.answer` refuses MCP callers.
- The lease (floor rule 4) ports the prototype's lessons: a 90-second expiry, a take-over that
  records who went quiet and for how long, and re-taking your own lease is not a conflict.
- `core/agents`: the assistant and agents. The tools are `agents.list`, `create`, `update`, `ask`,
  `threads` and `stop`. Credentials come from the Vault through `vault.release` and are set
  only in that agent's child process. The rule is a setup token first, then the API key when
  the subscription's limit is reached, within `budget_usd`, and the thread says so. Only the
  assistant can drive other sessions from inside its own thread.
- An agent's scope reaches the Harness: `harness.brief` and `harness.enrich` take `projects`, and
  the MCP server tags calls `mcp:agent:<name>`. It hides `threads.*`/`agents.*` from non-assistant
  agents and holds `recall.search` inside the agent's project folders.
- Agents fetch credentials from the real vault through `ctx.vault.fetch(name)`, declared as
  `needs.vault: ["per-agent"]`, which the loader now accepts the way it accepts `per-watcher`.
  Each item needs a grant to module `agents` (`vyre vault grant <item> agents`). Without one,
  `agents.ask` fails with `<agent> cannot start: <item> is not granted to agents · vyre vault
  grant <item> agents`. The switchboard tests put and grant items in the real vault.
- `threads.answer` declares `callers: ["cli", "local", "module", "deck", "capsule"]`, so the loader
  refuses `mcp` and `mcp:agent:<name>` with `denied` and leaves it out of their `/v1/tools`.
- Agent identity is checked. Each agent thread gets `VYRE_AGENT_KEY`, 24 random bytes new per
  process, held only in the Switchboard's memory. Inside the thread the MCP server calls as
  `mcp:agent:<name>` and the hooks as `harness:agent:<name>`, and the client sends the key as
  `x-vyre-agent-key`. vyred refuses (403 `denied`) any caller that names an agent unless the
  internal `threads.vouch {agent, key}` finds a live thread of that agent holding that key. The
  Harness takes the agent from `harness:agent:<name>` over `input.agent`; Memory reads
  `agent:<name>` after a space or a colon.
- The assistant's brief says how to act for the user on threads: `threads_watch {thread, notify:
  "capsule", note}` to watch one, `threads_send` and then a watch to drive one, and no polling,
  since the Capsule reports the watch when it fires.
- Usage metering: every turn is a row (`threads_turns`: thread, agent, auth, cost, duration,
  input/output/cache tokens), and `thread.finished` carries `tokens`. `agents.usage {agent?, since?}`
  returns, per agent, `{agent, kind, auth, turns, threads, duration_ms, cost_usd, api_cost_usd,
  tokens: {input, output, cache_read, cache_write}, by_auth: {<auth>: {turns, duration_ms,
  cost_usd}}, budget_usd, spent_usd, left_usd, limit, last_at}`. With no agent, a row with `agent:
  null` covers threads no agent ran. The CLI is `vyre agents usage [name]`.
- Budgets are enforced turn by turn for API-key agents. At 80% the thread gets a notice, and at 100%
  it stops with `thread.stopped {reason: "budget"}` and a note naming the command that raises it.
  New internal tools `threads.notice` and `threads.halt` carry both.
- The subscription's rate limit: every `rate_limit_event` becomes `thread.limit {status, kind,
  resets_at, utilization?}`, is kept on the thread (`last_limit`), and a warning or a refusal is
  said in the thread once per status.
- Learned skills: `<home>/learned/account/` loads into every thread with the Harness, and
  `<home>/learned/projects/<slug>/` into that project's threads, `<home>/learned/agents/<name>/`
  into that agent's threads, each only if it holds
  `.claude-plugin/plugin.json`. Lean threads and jobs load none of them. `threads.launch
  {plugins: [dirs]}` adds folders explicitly, even with `plugin: false`.
- `agents.list` rows carry `computer` again; without it core/computers refused every agent a
  computer. Found by the computers workstream, which made the same one-line fix on its branch.
- Lean threads: `threads.start {lean: true}` runs with no Vyre plugin, `--tools ""`,
  `--strict-mcp-config` and `--setting-sources ""`. Checked on Claude Code 2.1.283 with haiku:
  "What is 2+2?" cost $0.013 (6.5k tokens of Claude Code's own system prompt), where the
  Capsule measured $0.027 with the plugin. Not `--bare`, which skips keychain reads and with
  them a subscription's login.
- Jobs: internal `threads.launch` takes `plugin: false`, `tools: "none"`, `settings: false` and
  `once: true`. A one-shot thread stops after its first `thread.finished`, with
  `thread.stopped {reason: "done"}`. These options are kept on the thread (`threads_runs.opts`),
  so a resume runs the same way.
- `ask.answered` carries `tool` and `summary`, so an approval or a denial can teach Learning.
- `threads.watch {thread, until?: finished|asks|either, notify?, note?}` -> `{watch, fired}` and
  `threads.unwatch {watch}`. Exactly once, `thread.watched {watch, reason: finished|asked|stopped,
  notify, note, by, summary?}` is emitted. A stop always fires it, and a thread already stopped
  fires at once. Watches are rows (`threads_watches`), so they survive a vyred restart.
- `agents.history {agent?, limit?, before?}`: past exchanges with an agent, or with every agent,
  newest last: `[{id, at, agent, thread, project, surface, text, answer}]`. `text` is what was
  sent and `answer` the done replies before the next send. `before` takes an exchange's `id`.
  Built by the internal `threads.history` from stored `thread.sent` and done `thread.text`
  events. Guarded like `agents.threads`. This is the shape the Deck's ask view reads.
- Adopt: `threads.send` to a session the Switchboard did not start (a terminal `claude`) finds its
  transcript, makes its record (cwd and name from the transcript, `stopped_reason: "adopted"`) and
  resumes it headless with the lease. Before resuming any thread that is not running here, it
  refuses with `{sent: false, open_elsewhere: true, note}` if the session is open elsewhere: bound
  to a running claude that is not ours, named by a running claude's arguments (`--resume <id>`),
  or its transcript written in the last 30 seconds by anything but our own child
  (`core/switchboard/adopt.js`).
- Tools learn the verified thread: `registry.call(tool, input, caller, via)` and
  `run(input, { caller, thread?, agent? })`. vyred sets both for an agent caller whose key it
  vouched. For any other session, the SessionStart hook calls `threads.bind {session, pid}` for
  its claude process (its parent, as the MCP server's is) and writes the key to
  `<home>/sessions/<pid>.json` (0600). The MCP server sends `x-vyre-session` and
  `x-vyre-session-key` from that file on every call. vyred refuses a claim whose key does not match
  or whose process is gone. A session binds only from a running `claude` (or a live headless
  child), and a session bound to one live process cannot be taken by another.
- `gate.request` files a held item under the verified thread, and its project when the
  Switchboard knows it. From a model, a different `thread` in the input is refused.
- `threads.answer` declares `presence: { summary }` for security's presence proof (ADR 0004); the
  summary reads like "Allow Write to /work/notes.md: write notes.md (thread Intake)". The loader
  ignores the key until presence lands.
- `agents.delete {agent}` -> `{agent, deleted}` (CLI `vyre agents delete <name>`), for people's
  surfaces only. It removes the record and its spend, and refuses the assistant or an agent with a
  running thread. Transcripts and events stay.
- vyred refuses (403) a request that carries `x-vyre-agent-key` but names no agent, so a thread's
  Bash forging "local" or "cli" with its own key is refused visibly, not taken as the user.
- `callerKind` (and the vault's rules) drop the agent part: `mcp:agent:kit` is an `mcp` caller to
  every allowlist, so an agent's `vault.grant` waits as pending like any model's.
- Tests: the vault's per-agent stub is module `roster`, not `agents`; Memory's graph test and the
  gate + chat test use the real `agents` and `threads` modules (the latter over the fake
  `claude`), and call as an agent in-process, since no test holds a thread's key.
- A turn's partial text (`thread.text` with `delta`) is deleted from the event log 60 seconds after
  its `thread.finished` (`VYRE_TEXT_PRUNE_MS`); the `done` text stays. Modules get
  `ctx.events.prune(type, { before, thread, has })` for their own event types only.
- CLI: `vyre threads start|send|watch|lease|release|asks|answer|stop` (other `vyre threads`
  arguments still search the catalogue) and `vyre agents [create|update|ask|threads|stop]`.
- Verified with real Claude Code on haiku: a thread started from the CLI streamed to two curl SSE
  clients, a Write permission was answered from one of them, the lease moved between them, and
  `agents.ask` got a reply from a test agent.
- A terminal `claude --resume <id>` on a thread vyred is running headless is now visible (floor
  rule 4). The Harness SessionStart hook passes `headless` (true only inside vyred's own child),
  and `harness.brief` asks the internal `threads.claimed {session}` ->
  `{headless, holder, status}`. When the thread is live, the brief opens with a warning naming the
  holder and `vyre threads stop <id8>`, and the internal `threads.contend` emits
  `thread.contended {thread, session, holder}`. The session still starts: the hook never blocks.

### M5 · the box (2026-09-26)

#### Box

- Onboarding per ADR 0008: `onboard.name {action:"reserve"}` claims the vyre.run name only with
  a zone token (`CLOUDFLARE_VYRE_TOKEN` or vault `cloudflare-vyre-token`) or `network.domain`,
  else serves the ts.net name; the result says `via` ("vyre.run", "ts.net" or "domain"). HTTPS
  off in the tailnet blocks the step with `code: "https_off"` and `adminUrl`; reserve again
  retries. `onboard.you` saves `onboard.person` (one line, up to 60) without `names.check`, and a
  name that passes `checkName` becomes the default `name`. Status adds `person`. On a box with
  no sessions, history says they arrive with the Mac. `names.status` adds `zone`.

- Shared core, kept small: `ctx.handler(policy)` gives a module that opens its own listener
  vyred's router, with the caller the module established and limits on which tools, paths and
  event types it can reach. The router never takes a caller from a listener's headers.
  `config.save(patch, root, live)` writes config.json atomically at 0600 and updates the loaded
  config every module shares. `paths()` gains `certs`, `names`, `models` and `env`. `/v1/health`
  reports `supervisor` ("systemd" or null), so `vyre up` knows who restarts vyred.
- `core/names`, the parts that reach the outside world, each with a fake-server test:
  - an RFC 8555 ACME client for DNS-01 (ES256 JWS, nonce retry, and TXT records always cleared);
  - a hand-rolled PKCS#10 CSR;
  - a Cloudflare client that refuses any name outside the configured zone, because the user's
    token may cover other zones;
  - a 0600 certificate store.

  None of these add a dependency. Exercised live once: records under `_vyre-test.vyre.run` were
  created, updated in place and deleted (0 left), and a Let's Encrypt staging account was
  created. Staging refused the `_vyre-test` order with `rejectedIdentifier`, as expected for an
  underscore label, so issuance itself still needs a real name.
- The `names` module (role box). vyred serves the Deck on the box's tailnet addresses with its
  own certificate. It identifies each connection by `tailscale whois` of its source address and
  serves only `network.owner`, from a node that is not the box itself and is not tagged. Headers
  are never trusted (ADR 0002). Tools:
  - `names.status`, `names.check`, `names.claim` (A record, then DNS-01 certificate, then serve,
    in the background);
  - `names.fallback` (ts.net with `tailscale cert`), `names.release`, `names.connect`
    (`tailscale up`), `names.owner`;
  - the internal `names.claim-code`, a one-time link for a tagged box.

  Renewal runs daily at 30 days left. Under systemd the listener takes fd 3 from the socket unit.
  Exercised on a Mac against real Tailscale (read-only): the listener bound only the two tailnet
  addresses, loopback could not reach it, and a request from the box itself with forged
  `Tailscale-User-Login` and `x-vyre-caller` headers got 403. Real `whois` passed the owner's
  other devices and refused a node of another login.
- The `onboard` module (role box): the six steps of spec section 1.
  - Tools: `onboard.status`, `onboard.name`, `onboard.claude` (the token goes to the vault and
    never comes back), `onboard.tailscale`, `onboard.history`, `onboard.skip` and
    `onboard.finish`, plus the socket-only `onboard.link`.
  - Before the owner is seen on the tailnet, a loopback listener on 127.0.0.1:7300 serves only
    `/onboard/...`, those tools (plus `projects.catalog`, `projects.create` and
    `recall.status`) and `onboard.*` events.
  - Everything sits behind a one-time token that becomes an HttpOnly, SameSite=Strict cookie.
    The token is hashed, single use, and expires after an hour.
  - The listener checks for a loopback Host (against DNS rebinding) and a JSON body with a
    loopback Origin. It closes when the owner first reaches the tailnet address.
- Installing on a box: `scripts/install-box.sh` sits behind
  `curl -fsSL https://vyre.run/install.sh | sh`. It asks before installing Node, Tailscale or
  Claude Code, and prints every change with `--dry-run`.
  - `core/names/system.js` plans the systemd units and the Tailscale operator setting, and
    `apply` changes nothing unless asked. `vyre.socket` binds port 443 on `tailscale0` and
    `vyre.service` runs as the owner's own account, never root (docs/INSTALL.md).
  - `core/names/backup.js` backs up config, a consistent store copy, vault, watchers, modules
    and certificates, and restores them with traversal checks.
  - No Linux box was used: the Linux paths are proven by unit tests and a dry run against stub
    binaries.
- `vyre up` moved to `core/cli/commands/up.js` and grew. It starts vyred, or restarts it when
  it runs an older version or the wrong role; under systemd it lets `Restart=always` bring the
  new code up. Then it prints:
  - on a box: the onboarding link, plus the `ssh -N -L` line over SSH, or the address once
    set up;
  - on a Mac: the box it connects to.

  `--box` makes a Mac the box, and `--connect <addr>` points a Mac at one. Also new:
  `vyre up --system` / `vyre uninstall --system` (with `--dry-run`), `vyre name`, `vyre owner`,
  `vyre backup`, `vyre restore` and `vyre daemon`.
- Security fixes from a review of the listeners:
  - The tailnet listener refused no cross-site POST. A page the owner visited could have made
    their browser call any tool as the owner. Every POST there must now be JSON with this
    box's own `Origin`, and `Host` must be the box's.
  - `x-vyre-caller` on the socket could claim `module:*` (past the internal-tool gate, so
    `vault.release`) or `tailnet:*`. Only plain labels pass now, and anything else becomes
    `local`.
  - The onboarding session was a cookie, which browsers share with every port on 127.0.0.1.
    It is now a header the page holds in memory.
  - The box's own addresses are read before the first connection under systemd too, and whois
    naming this node is refused.
  - `onboard.link` allows only terminal callers.

#### Gate

- `core/gate`: the only way out for an agent (sections 7.7 and 11, floor rules 1 and 2). An agent
  calls `gate.request {kind: send|spend|delete, via, to, content}`; the item is held until a person
  approves the final content with `gate.approve {id, edited?}` or discards it with `gate.reject`.
  `gate.held`, `gate.get` (draft, final and a word-level diff) and `gate.senders` complete the set.
  A model never approves: every `mcp` caller is refused, and a module may approve only when
  `gate.approvers` in config.json names it (default `chat`, which checks the owner pressed the button).
- Senders are configured by the person in config.json: `gmail` (a hand-built RFC 822 message to the
  Gmail send endpoint) and `http` (exact-origin allowlist, `{{vault}}` only in headers or the body,
  redirects never followed). The credential is fetched from the Vault at the moment of sending
  (`needs.vault: ["per-sender"]`, each item granted to `gate`), or added by the owner's Vyre through
  `vault.relay` for a sender with a relayed pass, and results and errors are scrubbed of it.
- Events `gate.held`, `gate.released`, `gate.failed` and `gate.rejected` say what and where, never
  the content: a draft is the user's words and every module reads the log. A failed send returns to
  held with its error so the user can try again; two Sends at once send once.
- What the user changed before approving is taught to Memory as `draft.edited` (the recipient, the
  agent and the diff, keyed `gate:<id>`), the first of the Gate's learning signals (section 7.11).
- `gate.route` (internal) tells harness.rules to deny a sending MCP tool inside an agent's thread and
  point the agent at `gate_request`; the user's own sessions keep the interim ask-first rule.
- `gate.revise {id, edited}` changes a held item without sending it (event `gate.revised`, no
  content), and `gate.approve` takes the whole edited content, where an empty field clears it. Send
  sends exactly the latest revision, never the original; a changed `to` counts as an edit.
- An item left in "sending" by a vyred that stopped mid-send goes back to held on the next start,
  marked as possibly sent, so the person decides rather than the Gate sending twice.
- `core/harness`: harness.rules asks `gate.route` about a floor rule 1 send when the call comes from
  an agent's thread. Without the Gate running, the ask-first rule still applies.
- `core/modules`: `ctx.vault.fetch` accepts any `per-<thing>` declaration, not only `per-watcher`,
  so the Gate (`per-sender`) and agents (`per-agent`) can fetch items named at run time.

#### Chat

- Mattermost ships as a compose fragment for the box (`modules/chat/compose.yml`: 11.7 ESR, Postgres
  16, loopback only, sign-up and telemetry off), with an `mmctl` bootstrap in `SETUP.md` that pipes
  the bot and slash tokens straight into the Vault. Not yet run under Docker.
- `modules/chat`: Mattermost as a surface over the same real sessions (section 9). A channel per
  project and a thread per session; `thread.started`, finished text, what other surfaces typed,
  `ask.raised` and `gate.held` become posts, and answered or released ones are patched in place
  with their buttons gone. The owner's replies go to `threads.send` (taking the keyboard, and
  saying who had it), a root post starts a session in that project, and buttons call
  `threads.answer`, `gate.approve` and `gate.reject`. `/vyre held|send|discard|body|subject|new`
  covers the rest.
- A held post has no Edit button (the user's rule: edit inline, then Send sends exactly what is
  shown). It always shows the words Send will send: `/vyre body <id> <text>` and `/vyre subject`
  revise them and the post is patched in place, and "Edit in Deck" links to the Deck when
  `chat.deck` is set. Chat takes leases as `chat:<owner>`.
- The Edit button is back, because Mattermost cannot edit inside a post: it opens an interactive
  dialog filled with the words Send would send now (To, Cc, Subject and Body for an email; URL and
  Body for a request). Saving calls `gate.revise`, never `gate.approve`, so the item stays held,
  the post is patched to the new words, and the person presses Send. An emptied field clears it.
  The dialog's `state` carries the hook secret and only the owner is obeyed, on `/chat/dialog`.
- Why polling and not the websocket: no dependency, nothing to reconnect after Mattermost
  restarts, and `since` turns a missed interval into a delay rather than a lost message.
- Only the configured owner is obeyed. Every button carries its id and a per-install hook
  secret, so a request that did not come from a post Chat made is refused even with a real id;
  the slash token is compared in constant time. The bot token is a vault item fetched per
  request through a thunk (the prototype's lesson), so it never sits in an object that gets
  logged; a test checks it is absent from events, logs, status, tables and posts.
- Unconfigured, Chat starts idle and `chat.status` names what is missing; Mattermost down is a
  `failed` state that retries, never a failed vyred.
- `package.json`: the test glob now includes `modules/**/*.test.js`.

#### Learning

- Drafts the user edited before approving are signals. Learning subscribes to the Gate's
  `gate.released` where `edited` is true and reads the draft and what was sent with `gate.get`;
  Gate does not know Learning exists. A banned-by-name character the user took out everywhere
  (an em dash, an en dash, emoji, semicolons) becomes a proposed lesson at remind, which the
  thread is told about once at its next prompt. Only a summary of the edit is kept, never the
  message.
- Fix: a command run in the same millisecond as a file change counted as after it, so a test
  run could clear a commit it did not follow. Commands now count only when strictly later.
- Fix: offline, "strictly later" by the clock dropped a test run made in the same millisecond as
  the edit before it, so a commit after fresh tests was denied (the flaky "tests from before the
  last change" test: 358 of 2000 probe runs, 15 of 60 file runs, alone or in the suite). The
  offline state now orders edits and commands by a counter it keeps (`n`), not by `Date.now()`;
  a state file from before the counter starts over rather than letting its timestamp outrank it.
  The online check still compares the Harness's timestamps with Learning's.
- Lessons are checked with vyred down, as the floor is. Learning keeps the accepted lessons in
  `<home>/lessons.json` (mode 0600), rewritten on every change. When vyred does not answer,
  `hook.js` runs the tool and Stop checks in-process from it (`core/learn/offline.js`), keeping
  each thread's turn in `<home>/learn-offline/`. What it caught or saw broken is appended to a
  log that the learn module counts on its next start, escalation included. Offline, only lessons
  scoped to everyone or to this agent apply, since Projects is not there to place a folder.
  Verified in real Claude Code with vyred unable to start: an em dash reply sent back once and
  the final reply clean; a code-only turn sent back until it updated the changelog; both counted
  when vyred came back.
- `core/learn`: lessons Vyre learns from corrections and enforces with hooks, so a lesson is code
  rather than advice (section 7.11). Tools `learn.lessons`, `learn.add`, `learn.accept`,
  `learn.edit`, `learn.retire`, `learn.check {stage: tool|stop|brief}` and the internal
  `learn.signal`. Events `lesson.proposed`, `lesson.learned`, `lesson.caught`, `lesson.broken`,
  `lesson.escalated`, `lesson.retired`.
- A correction in a prompt ("never use em dashes", "update CHANGELOG.md whenever you change code",
  "run the tests before you commit", never say "X") is only proposed. Claude is told to ask, and
  the lesson is in force once the user says yes (`learn_accept`, or `vyre learn accept <id>`).
  Nothing becomes a lesson unseen. A free-text rule with no known shape becomes a reminder.
- Three check kinds: forbidden text (in the final reply at Stop, and in what Write or Edit is
  about to write), a required file changed in the same turn as code, and a command that must run
  before another. The Stop hook returns `{"decision":"block","reason"}` naming the lesson, at most
  twice a turn; then the turn ends and the lesson counts as broken, is repeated in the next
  prompt, and moves up a level (remind, ask, block) the second time.
- Hard to get around: retiring or editing a lesson from inside a turn, a command that reaches
  `vyre.db` or the socket directly, and `vyre down` all ask the user first, even when Claude
  Code's own permissions allow them.
- Harness changes, kept minimal: `harness.enrich` calls `learn.signal` (slash commands too, since
  every prompt starts a turn); `harness.rules` asks `learn.check` after the floor, which it can
  never loosen; `harness.stop` runs the Stop checks and returns the block; `harness.brief`
  appends active lessons. `hook.js` passes `prompt_id`, `stop_hook_active` and
  `last_assistant_message` (sent by Claude Code 2.1.283, confirmed with a probe) and prints
  Stop's answer at the top level. `tool.held` now carries `lesson`.
- `vyre learn [add|accept|retire|level]`, `/vyre remember <text>` and `/vyre lessons`.
- Verified in real headless Claude Code (haiku): an em dash reply was sent back once and the
  final reply had none; a turn that wrote code without the changelog was sent back and then
  updated it; `learn_retire` was held although `--allowedTools` allowed it.
- Fix during review: a correction without a check matched every other lesson without one, so a
  second free-text rule was never proposed.

#### Deck

- The onboarding (`deck/onboard/`), the first screen after `vyre up`: six steps, one a screen,
  each skippable, with live progress for the Claude sign-in, Tailscale sign-in, the address and
  history indexing, and a project picker over the session catalogue. It calls `onboard.*` (box
  stream) and answers from fixtures until those land. The one-time token is taken out of the
  address bar and kept for the tab only. Its board, `docs/design/boards/Onboard.dc.html`, is
  built from the rendered steps so the two cannot drift.
- The Deck's foundation: one stylesheet of the tokens (dark, and paper for the light theme), a
  small `h()` helper that only ever makes text nodes from strings (there is no `innerHTML` in
  the Deck, so thread text cannot become markup), and one API client. Tools that other streams
  have not merged answer from `deck/fixtures/*.json`, only with `?fixtures=1` and only when the
  live tool is missing; otherwise the view names the module that is not running.
- The shell and **Now**: header with the address, search over every turn (Recall, with ⌘K and
  arrow keys), the needs-you pill; the rail with pinned or recent projects and the machine it runs
  on; a bottom tab bar under 760 px. Now shows drafts held at the Gate and open asks in Beacon with
  their actions, running threads, and what memory learned today in gold with pin and mute. When
  nothing runs it lists the latest sessions, so Now is never empty. Views load one at a time from
  `deck/views/`, each with its own stylesheet.
- The Deck installs as an app on a phone: a manifest, the app icon, and a service worker that
  caches only the Deck's own files, network first, and never an API response.
- **Projects**: every project with pins, a new-project form, and the project board: threads
  (recorded sessions from Recall merged with live switchboard threads), the brief, and the thread
  itself, with tool lines, recalled memory in gold, held calls in Beacon with their answers, and a
  composer that takes the keyboard lease first and goes read-only when another screen holds it.
  The files pane lists what a thread touched; file contents have no API yet, and it says so.
- **Memory**: a map of each project's facts drawn as inline SVG, a list, and a fact panel with
  its source turns quoted from the threads they came from, pin, mute and forget (mute everywhere,
  with undo). Everything on it came from memory, so it is the one view where gold is the norm.
- **Agents**: the assistant and every agent, a new-agent form that picks credentials by Vault
  item name only, and the agent page: its job, what wakes it (watchers with on/off switches), its
  model and effort, a way to talk to it (`agents.ask`), and its computer with the pool screen and
  limits. Each part says which module is not running when it is missing.
- **Vault**: items by name, who holds each, what used it today, passes to and from other
  people's Vyre, and offboarding. No value is ever shown: values only go in, through password
  inputs that are read once and cleared before the call is sent, and the view keeps only the named
  fields it draws from every response.
- **Settings**: every onboarding step with its state and a way to finish it, the assistant,
  Claude Code and network status, history and memory with re-index and rebuild, lessons from
  Learning with edit and retire, the modules vyred runs, dark or paper, and this machine.
- **Phone views**, checked at 360 and 390 px: one held item full screen (`/needs/:id`), either a
  question with what it changes and Allow once / Always in this project / Deny, or a draft held
  at the Gate with its recipient, subject, the words that came from memory numbered against their
  sources, and Send / Edit / Discard fixed above the tab bar. **Ask** (`/ask`) talks to the
  assistant or any agent with @-chips, and shows an answer that came from memory as memory, with
  its sources and the time it took, and an "Ask a model" to go further. Every view fits 360 px
  without sideways scrolling.
- `/agents/:name/glass` loads Glass from `deck/glass/`, which the computers workstream builds, and
  says plainly that it is not here until then.
- Vendored `deck/vendor/qrcode.js` (qrcode-generator 2.0.4, MIT, unmodified, one file) for the
  phone QR code in the onboarding: the Deck has no build step and loads nothing from a CDN, and
  a QR encoder is not worth writing. Named `.js` because vyred serves `.mjs` without a script type.
- `deck/test/world.js` and `deck/test/shoot.js`, test helpers only: a temp `VYRE_HOME` seeded with
  the fictional corpus, a real vyred, a loopback proxy to its socket, and headless Chrome
  screenshots that can click through a flow.

#### Vault

- `core/vault`: credentials sealed at rest, released one item at a time to a module holding a
  grant, and shared with other people's Vyre by pass, so a teammate who leaves has nothing to
  walk off with. How and why: `docs/adr/0001-vault-crypto.md`. No new dependencies: everything
  is `node:crypto` (AES-256-GCM, HKDF, scrypt, Ed25519, X25519).
- Sealing: a master key in the macOS keychain, a 0600 key file, or wrapped by a passphrase; a
  key per item, bound to the item's id and name so a sealed file moved to another item's slot
  fails to open. Values live in `vault/items/`; names, kinds, field names and hosts in vyre.db.
- Items: `secret`, `api-key`, `login` (with TOTP), `card`, `note`, `env-set`. Tools: `vault.put`,
  `list`, `delete`, `grant`, `revoke`, `pending`, `approve`, `inject`, `totp`, `generate`,
  `import`, `audit`, `match`, `unlock`, `lock`, `identity`, `pass.create`, `pass.list`,
  `pass.revoke`, `pass.accept`, `relay`, `offboard`, and the internal `vault.release`.
- Who may call what: giving access needs a person, taking it away never does. `vault.put`,
  `inject`, `approve` and `unlock` refuse Claude and are left out of its tool list; Claude's
  grants and passes wait as pending until `vyre vault approve`. A module may `vault.put` new
  items or its own (`{name, value}` is shorthand for one field) and grant only those, which is
  how onboarding stores the Claude credential. Every release, refusal and relay
  is an audit row with names only.
- Passes: relayed by default (the holder's signed request goes to the owner's relay listener,
  which adds the value, only for the item's own hosts, with redirects off, and scrubs the value
  from the reply); sealed on request (encrypted to the holder's device key; revoking marks the
  items "rotate"). `vault.offboard` revokes everything a person holds and lists exactly what they
  received sealed. Verified between two vyred processes in two temp homes.
- Import from `.env`, 1Password CSV, Bitwarden CSV and JSON, Chrome and Safari CSV. vyred reads
  the file itself, so values never pass through Claude; the file is left alone and the user is
  told to delete it.
- `vyre vault`: `put` prompts without echo (and refuses a value on the command line), `run <item>
  -- <cmd>` puts values in one child's environment and scrubs them from its output, plus `list`,
  `grant`, `pass create/accept/revoke`, `relay`, `offboard`, `totp`, `generate`, `import`,
  `audit`, `card`, `unlock`.
- Tests prove no value appears in events, logs, `vault.list`, the audit trail, the MCP server's
  tool list, the HTTP API or any file under either home. Under `node --test` the keychain
  keystore refuses the login keychain; its own test uses a temporary keychain.
- The keychain keystore retries `security` when the keychain daemon is busy (reads, `-U` writes
  and deletes are safe to repeat). Keychain tests share `core/vault/testing.js`: a keychain with a
  unique name per test, taken off the user's search list under a machine-wide lock, never a
  rewrite of the whole list, and cleanup registered first. Ten parallel runs pass together.
- Autofill (`docs/adr/0010-vault-autofill.md`): a fill listener (`vault.fill: {host, port}` in
  config) that only paired browser extensions reach. Pairing is a one-time code from `vyre vault
  pair`; nothing is filled until the person unlocks with their unlock passphrase (or the vault
  passphrase, or later Touch ID through the Capsule), sessions end after 10 idle minutes, and a
  login fills only into a page whose origin is one of its hosts. Web pages are refused outright.
  `vault.fill` is a route there, never a tool, so no agent can call it. A minimal Chrome
  extension is in `modules/vault-extension/`.
- `vault.backup` and `vault.restore` (`vyre vault backup <file>`, `restore <file> [--replace]`):
  the whole vault, including the device identity so passes stay valid, sealed to its own
  passphrase (scrypt, AES-256-GCM), safe to keep in any cloud drive. Restoring re-seals every
  item under the new vault's key.
- Relayed passes can be bound to the holder's Tailscale login as well as their device key:
  with `vault.relay.identity: "tailscale"` the listener answers only through `tailscale serve`,
  and only the login on the holder's card.
- 1Password `.1pux` import, through a small ZIP reader over `node:zlib` with CRC checks and a
  zip-bomb guard.
- Shared core, kept small:
  - vyred no longer trusts a `module:` caller claimed over HTTP, which let anything on the socket
    call internal tools such as `vault.release`.
  - A tool may declare `callers`; other callers are refused and do not see it in `/v1/tools`.
  - `ctx.vault.fetch(name, { field, watcher })`, and `needs.vault: ["per-agent"]` alongside
    "per-watcher", for the agents module, whose item names differ per agent.
  - The daemon client no longer pools connections: the first call after a vyred restart failed
    as "unreachable".
  - Rule 8 also denies shell commands that print the Vault's keychain item.
- ADR 0006 step 1: every tool that hands out, writes, moves or unlocks a value declares
  `presence` with a summary naming items and destinations, never a value (put, delete, import,
  grant, approve, inject, totp, backup, restore, pass.create, pass.accept, offboard, unlock,
  unlock-passphrase, device.code, device.unlock). The registry on main ignores the field until
  ADR 0004 merges, so this is a declaration only for now. The fill listener refuses `/pair`
  without an extension Origin and any Host that is not loopback or `vault.fill.names` (DNS
  rebinding). `vault.generate` from Claude only creates new names.
- ADR 0006 step 2, crypto v2: each put seals a new item version under a random item key,
  wrapped under its vault's key; the body carries `meta` (kind, url, hosts, apps, reprompt),
  checked against vyre.db on open, and the version sits in the AAD and in a MACed row, so an
  older file put back fails. Item, grant, pass and device rows carry an HMAC; a row that fails
  it is ignored and audited as `tamper`. ECIES v2 binds the recipient key and a purpose and
  refuses an all-zero shared secret; v1 tickets still open. Two vault classes: `agents` (key
  wrapped by the keystore's device key, opens unattended) and `personal` (key wrapped under the
  account unlock key, Argon2id or scrypt of the password XOR the Secret Key). New tools
  `vault.account.create`, `vault.account.unlock`, `vault.account.lock`. A v1 home is re-sealed
  at start, v1 files removed only after every v2 copy verifies; once done, a v1 file is refused.
  Keys are KeyObjects and `lock()` drops them all. Backups keep format v1 and old ones restore.
- Touch ID unlock of the personal vault: `mac/enclave.swift` (Secure Enclave P-256 key with
  biometryCurrentSet; verbs create, derive, auth) wraps the account unlock key in
  `vault/touchid.json`. Tools `vault.account.enroll-touchid`, `vault.account.status`, and
  `vault.account.unlock {method: "touchid"}`.
- Interim presence (`prove.js`) until the ADR 0004 registry merges: every tool that returns or
  moves a value asks `proof.prove` first. Touch ID or the Mac password on a Mac, confirm (and
  the tailnet owner when known) on the Deck, refused where there is no Touch ID. Reveal is on
  for the Deck and the Capsule behind it (SPEC 11 rule 8); `vault.deck.reveal` is gone.
- The keychain keystore writes through `mac/keychain.swift`, so only that helper is on the
  item's access list (`security find-generic-password -w` no longer returns the key without
  asking). Items the old path wrote are moved on first read.
- Item history: the last 10 older sealed versions per item under `vault/history/<id>/`, and
  `vault_history` rows (MACed) naming the changed fields, computed from per-field HMACs.
  `vault.history {name, field?}` (names only, Claude may call it), `vault.revert {name,
  version}` (presence), and `version` on `vault.reveal` and `vault.copy`.
- Relay rules (`relay.body`) are sealed in the item's meta and checked on open like hosts;
  changing them makes a new version. Items whose rules predate this are re-sealed once.
  `vault_ssh_keys` and `vault_marks` are numbered migrations now, with MACed rows.
- CLI: `vyre vault account create | unlock [--touchid] | lock | enroll-touchid | status`.
  The password is a hidden prompt (twice on create); the Secret Key is printed once.
- No test raises a system dialog: `mac/dialogs.js` refuses a real enclave `auth`/`derive`, the
  type helper, and any keychain call without `noUI` under node --test (unless
  VYRE_TEST_DIALOGS=1) or with VYRE_NO_DIALOGS=1. The keychain helper labels each item with
  the build that wrote it and has an `info` op that never reads the secret; an item from a gone
  build is refused with `vyre vault migrate-key`, the one person-run path that may prompt.

- Your other devices: a new Mac or a box joins with a code and a fingerprint you compare, and an
  approval on a device you already have. A box joins as storage: it runs agent items and keeps
  personal ones as ciphertext it cannot open. Items sync between devices, and a change reaches
  the others through a poke rather than polling. Shared items can be deleted. New CLI verbs:
  `vyre vault vaults`, `members`, `move` and `device`.
- Shared vaults (ADR 0006, decision 5): a team vault whose key is wrapped for each member, a
  signed, hash-chained membership manifest, roles, and sync through the owner's relay listener
  with merges and kept conflicts. Removing a member changes the key and flags every item they
  could read. Offboarding covers shared vaults too. Items show up as `<vault>/<item>` and work
  with run, grants and the Deck. Multi-device join is next.
- Sharing, hardened (ADR 0006, findings 4, 5 and 12): pass tickets are signed by the owner and
  checked against the owner's pinned card, for this holder only, and a held pass can never be
  taken over by another owner. Old unsigned tickets are refused, and passes held from them are
  dropped: ask the owner to issue them again. Relayed values go in headers unless the item
  allows the body, over https except to loopback, within optional method and path allowlists;
  replay nonces survive a restart; envelopes are bound to the owner's relay; a 500 says nothing
  about why. Cards v2 are signed and pinned on first use, with fingerprints and safety words; a
  changed key blocks new passes until a person verifies it. `vyre vault people`, `fingerprint`
  and `kit` (a one-time printable recovery page with a QR code, from a small encoder in plain
  JS). The kit needs the account Secret Key, which lands with the key hierarchy.
- Vault CLI (ADR 0006 section 6): `vyre vault get|read|add|edit|rm|inject|share|ssh|git-credential`
  and `run --env-file`, `--json` on every command (exit 3 presence, 4 locked); tools
  `vault.item`, `vault.resolve`, `vault.render`, `vault.edit`, `vault.git`, `vault.ssh.*`; an
  ssh-agent for the new `ssh-key` kind (`vault.ssh.socket`); `bin/git-credential-vyre`. Presence
  is declared on value tools but not enforced until ADR 0004 merges.

- Vault surfaces: sessions for the Deck, Capsule and extension (idle 10m, max 12h, locked on
  sleep and screen lock), `vault.reveal`, `vault.copy` through a concealed, self-clearing
  clipboard helper, `vault.fill.native` for the Capsule, TOTP with a session, and the extension's
  inline chooser, keyboard fill, one-time codes and save on submit. Presence is declared on
  each tool; until ADR 0004 merges it is not enforced, so reveal and copy from cli/local run
  without a proof.
- The Deck's Vault app (ADR 0006, section 6): places in the rail (a chip row below 1200px),
  fuzzy search over names, hosts, kinds and field names, the keyboard map, the item pane with
  concealed fields, copy with a draining 90 s toast, reveal behind `vault.caps`, TOTP ring,
  history, add and edit per kind with an inline generator whose value is made on the box,
  Watchtower, passes with approvals on top, the share and offboard sheets, devices, and a phone
  layout. The passkey presence client is `deck/vault/presence.js`. New tools `vault.caps`,
  `vault.health`, `vault.breach.check` (opt-in network call, `vault.breach: "ask"`) and
  `vault.update` (merging put with `generate`). vyred now serves the Deck's shell for any folder
  path, so `/vault` routes even though `deck/vault/` exists.

#### Watchers

- `core/watchers`: the watcher runtime (spec 7.6). Claude writes a folder in
  `~/.vyre/watchers/<name>/` through the write-a-watcher skill; the runtime runs it. Tools:
  `watchers.list`, `watchers.test`, `watchers.create`, `watchers.pause`, `watchers.resume`,
  `watchers.logs`, `watchers.items`. Events: `watcher.created`, `watcher.fired`, `watcher.failed`,
  `watcher.paused`, `watcher.resumed`. No Gmail, Slack or other integration ships with it; that is
  the point.
- Every run is a child process with no inherited environment, a timeout (60s default, 300s at
  most), and Node's permission model: read access to its own folder only, no writes, no child
  processes. Measured: reading another file, writing, spawning and reading the parent's env all
  fail inside a watcher.
- Vault items reach a watcher only through `vault.fetch` for names in its own `needs`, checked by
  the runtime, which declares `needs.vault: ["per-watcher"]`. A released value is scrubbed from
  logs and errors, and an item that carries one fails the run, because items are filed and taught.
- `watchers.create` turns on exactly what the last successful dry run ran (a hash of both files).
  An edit afterwards pauses the watcher until it is dry-run and created again, so a watcher cannot
  widen its `needs` or change what it does without the user seeing it.
- Items are deduped by `id`, filed as `watcher.item` rows in the project, and taught to Memory
  with `project_cwds` set to the project's folders, so they appear in that project's
  `memory.facts` and no other. Without the project's folders they are filed but not taught, so a
  client's items never become a fact for everywhere.
- Cursor: `since` is what `watch` returned, or the start of the last successful run. Failures
  retry after 30s and 2m; the third in a row pauses the watcher and says why.
- A small cron parser (five fields, steps, ranges, lists, `@hourly` style shorthands), which
  refuses a step past the end of its field: `*/120` in minutes means minute 0, which is never what
  was meant. Claude wrote exactly that in a real session.
- Webhooks: a watcher with schedule `webhook` gets `POST /v1/watchers/<name>/hook` with a token
  made at create, checked in constant time; the JSON body reaches `watch` as `hook`. Calls that
  arrive mid-run are queued, not dropped.
- On the real vault: every fetch names the watcher, so the vault releases only against a grant
  for that one watcher; a grant to one watcher is not a grant to another listing the same item
  (tested). `vault.fetch(name, { field })` inside a watcher picks a field (a login's username,
  an env set's key), passed through as `ctx.vault.fetch(name, { watcher, field })`.
- `vyre watchers [test|create|pause|resume|logs|items] [name]`.
- Shared core, kept minimal: the registry gains `hook: true` tools (reachable only as caller
  `hook` through vyred's new `POST /v1/<module>/<name>/hook` route, never listed or offered to
  Claude). Nothing else outside `core/watchers/` changed.
- The write-a-watcher skill, rewritten from five real Claude Code sessions (Haiku, Harness loaded):
  it now loads before Claude asks questions, beats `/loop`, calls `watchers_list` for the folder
  instead of guessing `~/.vyre` (one session wrote there), calls the MCP tools directly rather
  than from a shell, never runs `watch.js` with plain `node`, fetches in parallel, logs what it
  read, and does not widen a filter to manufacture items. When a watcher needs a vault item, it
  gives the user the exact `vyre vault grant <item> watchers --watcher <name>` before the dry run,
  since a grant can only come from a person.
  A grant Claude asks for through `vault_grant` stays pending until a person runs
  `vyre vault approve <id>` (listed by `vyre vault pending`); the skill says so. It also warns that
  a ranked list such as a front page has no id cursor: skipping ids below the highest seen drops
  older stories that climb onto it, which Haiku wrote in a real session.

#### Capsule

- A lesson scoped to a project or an agent reads in words on its card, not as an object.
- An action marked `hide: true` in shows.capsule (the vault's fill) runs with the Capsule out of the
  way: it hides, waits until the app the user was in is frontmost again, calls, and says the
  result as a notification.
- With vyred down, the hidden Capsule looks for it every 3 s doubling to a minute (the event
  stream's reconnect doubles to 30 s), not every 3 s forever; opening the Capsule looks at once.
  Perf measured the steady retry at about 0.8% CPU hidden against a 0.2% budget.
- Modules can offer the Capsule results and actions (`shows.capsule`, SPEC 5.1): `lib/providers.js`
  reads them from GET /v1/modules, which now carries each module's `shows`. Their results (names
  only, never a value) rank with the rest on the slow path; Enter runs the first action, → or ⌘K
  lists the others, each call gets `{...input, id, front}` with the app that was in front when the
  Capsule opened (from the double-Control line, or `bin/local`'s `front` op for other ways in),
  and what the module says is shown as it is. A one-time code counts down. This is how the vault's
  fill, copy, code and lock appear.
- Proposed lessons wait in the Capsule, quietly: "Vyre proposes: <rule>" joins the waiting list
  from `learn.lessons {status: "proposed"}` and `lesson.proposed`, leaves on `lesson.learned` or
  `lesson.retired`, and never turns the dot or the tray Beacon. Accept is `learn.accept`, Decline
  `learn.retire`. Memory sources show how old they are and how sure memory is.
- Quick answers start lean (`threads.start {lean: true, append}`): no plugin, tools, MCP servers
  or settings, about half the cost of a full thread. Watches set from the Capsule use the
  switchboard's `threads.watch {notify: "capsule"}`, which outlives restarts, and any
  `thread.watched` meant for the user (the assistant can set one on their behalf) becomes a
  notification and a report. The Capsule's own filter on the stream stays as the fallback.
- File results with taste: noise paths are gone (dependencies, SDKs, third-party code, build
  output, caches, ~/Library, dot-folders), a name start or word start beats a substring, recently
  used documents, images and folders in Documents, Desktop and Downloads rise, files inside code
  repos sink, and at most 4 files show (8 when the words look like a file name). On eight real
  queries, noise rows went from 5 of 30 to none.
- Files on the box, through this Mac's vyred (`files.search {where: "box"}`), join the list when
  they land, never delaying the Mac's own; picking one fetches it (`files.fetch`) and opens it.
- `vyre capsule build --app` signs from the inside out (frameworks, each helper with its own
  identifier, then the bundle) and fails unless `codesign --verify --deep --strict` passes, so a
  downloaded app is not reported as damaged.
- Hidden memory under the 250 MB budget (about 212 to 238 MB, from about 300): the network service
  and GPU run in the main process and no spare renderer is kept. Warm open stays 18 to 50 ms.
- Open Glass on an agent with a computer, a thread of one, or `glass box` (from the glass stream).
- Drive and watch sessions from the Capsule. "watch the intake thread" offers a row per thread it
  could mean; picking one sets a watch (`lib/watch.js`), a filter on the event stream the Capsule
  follows anyway. When the thread finishes, fails, stops or asks, a macOS notification says so and
  the report (the last thing it said, and its cost) waits in the empty Capsule until read. "tell
  the intake thread to run the tests" shows the thread and the words, sends them as the user and
  watches the thread; a thread someone else holds says who, and only ⌘⏎ takes it.
- In the Capsule: clipboard items rank beside apps and files, "clipboard" lists them newest first
  with a row that clears the history, and Enter puts one back on the pasteboard and closes, for the
  user's own ⌘V. `@` an agent opens a DM: its history, your messages from any surface, the reply
  streaming into the list, and its asks in Beacon to click and answer. A test run watches a
  private pasteboard, never the user's.
- Clipboard history, on this Mac only (`lib/clips.js`, `clip.watch` in `bin/local`): the helper
  reads the pasteboard's change count every 750 ms, the one thing that runs while the Capsule is
  hidden. Concealed, transient and auto-generated items, password managers, Universal Clipboard,
  and anything that looks like a secret (token prefixes, JWTs, keys, codes, card numbers,
  high-entropy strings) are never recorded. At most 200 items for 7 days, in a 0600 file. Picking
  one writes it to the pasteboard for the user's own ⌘V; nothing is typed for them.
- Direct messages with agents (`bridge.openDm`, `st.applyDm`): an agent's current thread as
  history, the user's messages from any surface marked with where they came from, a sent message
  shown at once and reconciled when it lands, the reply streaming into the same list, and the
  agent's asks beside it. Nothing is fetched unless a DM is open.
- Result rows look native: each has its real picture (a 24 px box that never moves when the
  icon lands), its name, where it is, and its kind or the key that takes it, with the selected
  row in Signal. Vyre's own kinds (agents, the assistant, projects, threads, memory in Recall gold,
  the vault, box files, held items in Beacon, quick answers) are drawn as one set of glyphs.
- A question shows "Ask Claude", the assistant and "deeper" as the top rows, each naming its
  destination. Enter streams the answer in place, rendered from markdown (built node by node,
  never as HTML), with Copy, a one-press deeper retry, the model, cost and time, and what memory
  said in gold. Esc stops a streaming answer; the next Esc closes. Follow-ups go to the same
  thread. Enter pressed before the destination for the new words is worked out shows it and
  sends nothing.
- Files rank a little below the same match on an app or a pane, and at most four show beside
  other results. Icons from the first build were drawn a quarter size; the cache moved to
  `icons-2`.
- Real icons, fetched by `bin/local` in batches off the main thread: app bundle icons,
  system type icons or QuickLook thumbnails for files, each settings pane's own icon (resolved
  from its extension bundle), and contact photos when Contacts is already allowed. `lib/icons.js`
  keeps them as 64 px PNGs in a bounded cache (1500 files, 24 MB, least recently used first),
  keyed by path and mtime.
- Questions get answers in place: a bare query that reads as a question offers Claude (a fast
  model, haiku) or the assistant, whichever fits: the assistant first when it names the user's own
  projects, threads, agents or people. A deeper option runs sonnet. A quick answer is a headless
  thread started in `<vyred home>/capsule/ask`; follow-ups go to the same thread, `cancel()` stops
  it, and the reply carries its model, cost and what memory said.
- `vyre capsule` opens an installed Vyre.app (/Applications or ~/Applications) when there is no
  dist build of this source, and leaves it on its own bundled helpers. Packaged apps declare
  `NSContactsUsageDescription`, without which macOS refuses the Contacts ask silently.
- A bare query in the Capsule finds things on this Mac first: `lib/launcher.js` ranks apps,
  settings, the calculator, contacts, definitions, files and Vyre's own agents, projects and
  threads as one list (`route.rank`, frecency from picks), and `route.intent` decides whether
  Enter opens the top result or asks: a question, or no strong match, goes to the ask row that
  names the assistant. Local results arrive on every keystroke with no debounce; files join
  when `mdfind` answers. It all works with vyred down. Picking a sum copies it. The window no
  longer takes focus when driven by a test (`VYRE_CAPSULE_DRIVE`), and `capsule.open` carries
  the gesture time, so the page reports keypress-to-visible and keystroke-to-results timings.
- Local results, all on this Mac and offline (proposal: the Capsule replaces Spotlight, milestones
  1 and 2, without taking ⌘Space). `lib/calc.js`: a calculator and unit converter with its own
  parser (no eval), which returns nothing rather than guess. `lib/local.js`: apps from the
  Applications folders, files and folders through `mdfind` (the query escaped, no shell, killed on
  timeout), 45 System Settings panes with verified `x-apple.systempreferences:` ids and synonyms,
  a scored `match()`, and `Frecency`, which stores result ids and six-letter prefixes only.
  `swift/local.swift` (built to `bin/local`) and `lib/helper.js`: Contacts and the Dictionary in
  one long-lived child. Contacts asks for permission only on the first contacts lookup.
- Runs against the real switchboard, proven in a temp home with the fake Claude: the assistant and
  `@agent` through `agents.ask`, `@thread` through `threads.send` with the lease (taken only on the
  user's ⌘⏎, released on close, including a thread the Capsule started), asks through
  `threads.asks` and `threads.answer`. Switchboard threads join `@` completion via `threads.list`.
  The Capsule listens before it sends, so a fast reply is not lost. `thread.text` is read as
  `{message, delta}`, and a withdrawn question as `ask.answered` with decision "cancelled".
- Held drafts are edited in place, with no Edit button: To, Subject and body read as text and
  show an underline when focused. Send (⌘⏎) sends what the card shows through `gate.approve
  {id, edited}` with every field; Discard is `gate.reject`. Esc leaves a field, then the card. The
  words come from `gate.get` when the card opens; a send the sender refused stays up with its error.
- Sending follows the switchboard's shapes: `agents.ask {wait: false}` streams the reply,
  `threads.send` into a thread another screen holds says who has it, and only the user's ⌘⏎ takes
  the keyboard (`threads.lease`). Answered asks leave the list; `thread.stopped` ends a reply.
- `local/capsule/`: the Capsule. Press Control twice anywhere on the Mac, and a command bar
  opens over the current app with the caret in it. By default you talk to the assistant.
  `@` completes agents, projects and threads from the running vyred, and a "Sends to" row shows
  the destination before anything is sent (floor rule 2). A question gets an answer from memory
  as you type, in Recall gold, with its sources; Enter shows the source turn (floor rule 7).
  Gate holds and open permission asks wait in one Beacon list, oldest first (press ↑). A hold
  opens for review: send, edit, discard, allow or deny. A reply streams back from the thread it
  went to. Ported from the prototype's floating panel and rebuilt against the Capsule board.
  The prototype's workbench window is left behind: the Capsule is the command bar.
- The Capsule talks to vyred only through its API over the socket (`lib/vyred.js`, the same
  `{ data } | { error }` shape as `core/daemon/client.js`), in the main process. The window is
  sandboxed with no Node. Everything that decides meaning (what `@` completes, where Enter sends,
  how a destination reads) is in `lib/route.js`, and the page asks for it, because the
  prototype's second decision path made one sentence mean two things.
- The switchboard's `agents.*` and `threads.*` and the Gate's `gate.*` are used by their spec
  names. Which of them exist is read from `/v1/tools`, and each missing feature says so in words
  before Enter, not after. Open asks come from `threads.asks` when it exists, and otherwise from
  the event log.
- Lessons carried over from the prototype: the window is an NSPanel at screen-saver level on
  every Space, so it opens over a fullscreen app. An agent's question never opens the Capsule or
  takes the keyboard; it turns the menu-bar dot Beacon (floor rule 6). Escape hides the window
  and hands the keyboard back to the app that had it. The event stream is followed in the main
  process, because a hidden window's timers are throttled. When vyred goes away, everything from
  it is cleared and the Capsule says it is offline. There are no infinite animations.
- Fix, found on this Mac: with another app active, focusing the panel alone did not make it
  key, so typed keys reached neither app. On the user's gesture the Capsule now takes the
  keyboard (`app.focus({ steal: true })`), and `app.hide()` gives it back on close. Verified with
  real key events over TextEdit.
- `swift/hotkey.swift`: the double-Control listener, run as a child of the Capsule and read over
  stdout, so the gesture works with vyred down. It re-arms a tap macOS disables, exits when its
  parent dies, and reports a missing Input Monitoring grant in words. `--check` prints what
  macOS allows; `--simulate` posts a real double-Control through the system, for tests.
- `swift/launcher.swift` (`vyre-launcher`): one macOS identity for vyred, so Accessibility is
  granted to Vyre alone rather than to every shell. `build.sh` compiles both into
  `local/capsule/bin/`, ad-hoc signed.
- `vyre capsule` opens it and starts vyred if needed. `vyre capsule --dev` runs it from source in
  the terminal. `vyre capsule build [--app]` builds the helpers, and with `--app` packages
  Vyre.app with a stamp of its source hash. `vyre capsule` runs the package only while that
  stamp matches the source, and otherwise runs the source and says why, because a packaged app
  runs `app.asar` and ignores every edit silently.
- The `capsule` module (role `local`): `capsule.status`, and `capsule.show {action}`, which emits
  `capsule.requested` so the assistant, the CLI or a phone can open the Capsule. `capsule.autostart:
  true` in config.json starts the app hidden with vyred. It is off by default, so a vyred started
  for a test or over SSH never opens a window.
- Dev only: `VYRE_CAPSULE_DRIVE=1` with `--dev` reads JSON commands on stdin and sends keys into
  the Capsule's own window, and saves window-only screenshots. Typing through System Events goes
  to whatever app is in front; during testing it typed four characters into a terminal.
- Dependencies: `electron` and `@electron/packager`, devDependencies of `local/capsule/` only,
  never the root package. Fonts: Instrument Sans and JetBrains Mono (both SIL OFL 1.1, licences
  beside them) are bundled in the app, so it looks the same with no network (floor rule 9).
- `local/hands-mac/`: computer use on macOS through the accessibility tree, as the module
  `hands` with `hands.observe` and `hands.act`. Every act is verified by observing again. An
  action the accessibility API accepted is not counted as done until the re-read shows it.
  Secure fields never show their value, and `hands.acted` events carry the action and selector,
  never the typed text. Verified for real on TextEdit (set and type) and Calculator (press).
- Shared core, kept small: `GET /v1/health` returns `last_event`, so a surface can follow the
  stream from now. `since=0` replays the whole log, and a guessed cursor past the end drops live
  events. `npm test` now runs `local/` tests. The hygiene scan now covers `.swift` and skips build
  output (`dist/`, `bin/`).

### Shared core for the parallel workstreams (2026-09-26)

- `ctx.vault.fetch(name)`: a module gets only the vault items its manifest declares, through the
  vault module's `vault.release`, an **internal** tool: callable only by modules, never listed,
  invisible to Claude, the CLI and surfaces.
- `ctx.memory.teach(kind, fact)`: only declared kinds; a no-op when Memory is not running.
- `GET /v1/events/stream`: server-sent events with backlog replay and `Last-Event-ID` resume,
  for the Deck, the Capsule and the Switchboard. Open streams no longer hold `stop()` open.
- vyred serves `deck/` for every non-API path, with a strict content security policy, and never
  a file outside `deck/`.
- `docs/design/`: the design boards and brand tokens, so every session builds from the same design.

### M2 · the Harness (2026-09-26)

- `harness/`: a Claude Code plugin. Load with `claude --plugin-dir harness`. Verified in real
  headless Claude Code sessions: the brief reaches Claude at SessionStart, MCP tools are callable
  (`mcp__plugin_vyre_vyre__<tool>`), and the vault rule denies a Read even when `--allowedTools`
  allowed it.
- Hooks are one runner (`harness/hooks/hook.js <piece>`) that calls vyred and prints Claude Code's
  JSON. With vyred down they print nothing, except the security floor, which runs in-process.
- `core/harness` module: `harness.brief`, `harness.enrich`, `harness.rules`, `harness.learn`,
  `harness.touched`, `harness.stop`. Brief and enrich compose `projects.*` and `memory.relevant`
  through `ctx.call` and return nothing when those modules are absent.
- Floor rules now enforced at PreToolUse: rule 8 (nothing reads the vault folder, by any path,
  relative or not) and rules 1 and 2 (an MCP tool that sends as the user asks first and names
  the destination; drafts and reads pass).
- MCP server with no dependencies: lists vyred's tools live (dots become underscores), forwards
  calls, starts vyred if needed.
- Skills: `write-a-watcher`, `use-the-vault`, `work-in-a-project`. Command: `/vyre`.
- Fix: a long `VYRE_HOME` made vyred fail with EINVAL (unix socket paths are capped near 104
  bytes). Such homes now use a private per-user `/tmp/vyre-<uid>/` folder, checked for owner and
  mode 0700 so no one else can plant a socket that poses as vyred.

### M1 · projects and memory

#### Contracts (main)

- Recall's tables are a published contract (`core/recall/schema.js`): a turn is identified by
  `(session, seq)`, never by FTS rowid.
- `ctx.call(tool, input)`: one module uses another's tool through the rules, as `module:<name>`.
- `ctx.paths`: the `~/.vyre` paths, for modules that keep files.
- CLI commands are one file each in `core/cli/commands/`, found at run time.
- `test/fixtures/corpus.js`: the fictional corpus every M1 module tests against.

#### Recall

- The embedding package is now installed on main (the user approved the one-time download of the
  23 MB model from Hugging Face; nothing about the user is sent). `package-lock.json` is committed
  so installs resolve the same versions.

- `core/transcripts`: the one adapter that reads Claude Code transcript files. It lists
  sessions and subagents (`<parent>/agent-<id>`), and when one session id has two files (a
  resume from another folder, an archive copy) the fullest wins, so they cannot take turns
  looking changed. It reads turns, the last `/rename`, the real cwd from the lines, and whether
  a person started it (not a subagent, not an SDK run). Tool traffic, thinking and lines Claude
  Code injects (`isMeta`) are not turns. It never throws over a bad file or line.
- The redactor is ported and runs before any text leaves the adapter: turns, titles and names.
  Placeholders keep the kind and last four characters, so "rotate the billing token" still
  finds the conversation.
- `recall` module: indexes on start and every `recall.every` minutes (default 5) in the
  background, one pass at a time, yielding between files so vyred keeps answering. Indexing is
  append-only: a grown transcript appends its new turns and keeps every vector; a rewritten one
  is indexed again from scratch; an unchanged size and mtime is not read. History outlives the
  transcript: a deleted file keeps its rows.
- Vectors are optional. With the model, turns are embedded one at a time (batching was slower
  and changed the numbers), in 900-character chunks with 200 of overlap, and a vector is written
  only if its turn still holds the text it was made from.
- Search pins the top half of the keyword answer before blending in meaning, so hybrid never
  loses an exact match; any failure of the model ends in the keyword answer. FTS5 grammar a
  person did not mean (a hyphen, half a parenthesis) falls back to the literal phrase.
- Tools `recall.search`, `recall.thread`, `recall.sessions`, `recall.index`, `recall.status`;
  event `session.indexed`; commands `vyre recall <query>` and `vyre index`.
- Under `node --test`, Recall refuses to read the real `~/.claude`, whatever the config says, so
  a test that starts vyred with default settings cannot index someone's conversations.
- Dense retrieval (`core/recall/dense.js`). Search could only re-rank turns that shared a word
  with the question, so "making it easier for blind visitors" never reached an accessibility
  audit, which contradicted the measurement the spec quotes (dense retrieval won). Every vector
  now sits in one in-memory array, built on the first hybrid search and dropped after a pass
  writes. A brute-force dot product adds the nearest 200 turns to the pool, filtered by role and
  project folder.
- A dense hit needs a minimum cosine, so nonsense still returns nothing, and the minimum rises
  with the corpus because the best score noise reaches does (about sqrt(2 ln n)). A fixed 0.25,
  right for the 16-turn fixture, let every nonsense query through on the real corpus: "asdf
  qwerty" had 287 chunks above it. Measured with the real model: fixture nonsense at most 0.186
  against real matches 0.339 and 0.473; the real corpus (36,878 chunks) nonsense at most 0.413
  against the weakest real question's best 0.476. The floor is 0.276 and 0.444 there, capped at
  0.45. On the real corpus every test question gets dense candidates and no nonsense query does.
- The dense index builds in pages in the background once embedding finishes. The first hybrid
  search on the real corpus went from 3.3s to 83ms.
- Rankings now merge by reciprocal rank. A blend of keyword position and cosine let hundreds of
  one-common-word matches bury a turn that meaning alone had found. The pinned half now comes
  from the strict keyword pass (the query as typed), which is where exact matches live.
- A rewrite bumps a generation number in `recall_meta`, and the dense index rebuilds when it
  moves. Without that, a stale snapshot scored a (session, seq) that now held different text.
- `recall.status` and `vyre status` say "downloading the search model (23 MB, once)" while the
  first download runs.
- An eval harness: `recall.eval` and `vyre recall eval <file>`. It runs a labelled set (each
  question with the turns that answer it) three ways, keyword, dense and hybrid, and reports
  MRR@10 and recall@10. It also checks the dense floor from both sides: nonsense that clears it,
  and answers that fall under it. `test/fixtures/recall-eval.json` is a fictional set on the
  fixture corpus. A set built from someone's own sessions stays outside the repo.
- New vectors are appended to the dense index in place. Rebuilding it after every pass that
  wrote anything cost a full read of every vector, one to six seconds, every few minutes for an
  active session. Only a rewrite, which deletes turns, still rebuilds.
- Dependency: `@huggingface/transformers`, optional, because it is the only way to run the
  embedding model locally from Node; without it search is full-text and says so.

#### Memory

- Picked threads are room members in a live vyred: room sync reads `picks` from `projects.list`
  (below), so a thread picked into a project counts in its room under the anchor rule. The eval
  world now uses the real list shape and checks every pick lands in its room; leakage stays 0.
- `memory.facts {thread, room?, limit?}` (default 50, at most 200): the facts whose evidence
  includes a turn of that thread, oldest first, each with `refs: [{seq}]` for the turns in that
  thread and `taught` as before. Main graph without a room (owner surfaces only), a room's rows
  with one; agents only in their granted rooms. `mentioned_in` rows and muted nodes are left
  out. For gate-chat's Chat view.
- Presence: `memory.correct`, `memory.merge` and `memory.split` declare `presence: { summary }`,
  one plain line under 400 characters with control characters stripped, e.g. `Correct: "Dana
  Reyes works at Harlow Legal" -> "Bramble Dental" (everywhere)`. The owner allowlist and the
  agent refusal stay; the tools also refuse any non-owner caller themselves.
- Refusals throw with `code: "denied"` (access to a room or the main graph, an agent's grants,
  corrections), which vyred on main passes through as the tool error's code.
- `tailnet:<login>` callers read as the owner: `memory.graph`, `facts`, `why`, `stats` and
  `corrections` (which drops its `callers` list and checks in the tool, since the registry
  compares the whole caller string). Never `correct`, `uncorrect`, `merge` or `split`, and not
  `relevant`.
- Scope fixes from review (ADR 0007, decisions 1 and 4). A correction for everywhere applies in a
  room only to what that room's own sessions derive: wrong, ended and confirm touch rows the room
  has; add and replace only when the room keeps the subject, with an object it keeps or a value
  the correction names (a title, a date). A correction's note reads only in the scope it was made
  in (`fact().correction.note`, `memory.why` corrections). Before, every room got every
  correction for everywhere, nodes included.
- Nested projects: a folder belongs to the most specific project that holds it, for rooms,
  `graph.view`, the floor plan and lessons scoped to folders. Agents are checked by project slug,
  so an agent granted `~/Work` is not granted a project at `~/Work/northwind`, and a project with
  no folders (only picked threads) is read by slug. A room Memory has not read yet falls back to
  the folders passed with it.
- A caller that names no agent and no room reads the main graph (`memory.facts`, `relevant`,
  `why`, `stats`) only from `deck`, `cli`, `local`, `capsule` or a module; anyone else passes
  `room` or `project_cwds`. The Harness's Enrich and the project brief now send `room: <slug>`.
- Correct, merge, split, uncorrect and corrections refuse any caller naming an agent, `deck
  agent:kit` included (the registry reads that as `deck`).
- `memory.correct` resolves the new object exactly: a node id, an exact label, an address or a
  domain; anything else is a new node of the kind the relation holds (`title:`, `date:`, `pref:`,
  `decision:`, `note:`, `name:`). "North" no longer becomes Northwind Bakery.
- `memory.correct` answers at once with `pending: true` and derives behind the answer;
  `memory.curated` marks completion. `wait: true` (the CLI) answers after, with the facts.
- Conflicts between rooms skip confirmed facts as well as the user's own, so derive never closes
  a confirmed fact.
- Lessons are indexed once per derive: 8,000 lessons about one organisation derived in 5.7s,
  now 0.25s.
- Deck Memory sends `room: <slug>` on every `memory.graph`, `memory.facts` and `memory.why`
  call (the last one included), never the project's folders.
- Eval: the gold file gains `corrections` (made with `memory.correct` before measuring) and leak
  cases for them. Old code leaks 12 facts on it; leakage is 0.

- One identity per domain: organisation spellings that share a domain ("Keel & Ash", "Keel & Ash
  Architects") fold into one node before anything is counted, named by the longest proper
  spelling. The others are kept in the new `memory_aliases` table (per room), so a prompt or
  `memory.resolve` using them still finds the node. Spellings a user correction or a lesson
  names, and a room's split copies, are left alone. The migration asks every home to derive once.
  `memory.relevant` also drops a fact whose text repeats a higher one.
- Eval: the Harlow deadline (18 September) is closed at the eval's clock, as the ADR closes a
  deadline two days after its date. The gold says so, and the eval now fails a closed fact that
  `memory.relevant` offers (`closed.offered`, target 0). A second run with
  `config.memory.relations` on reports `prefers` and `decided` as optional relations with
  precision, recall and whether they clear the 0.8 bar. `relevant` timing warms up and takes the
  best p95 of three rounds, so heavy machine load no longer fails the 5 ms bound.

- Resolution (decision 2): an address matches a person across sessions when exactly one kept
  person has its local part and works at its domain (0.75); a word-like TLD or a trailing
  organisation word in a domain spells the organisation (`harlow.law` is Harlow Law,
  `keelasharchitects.com` is Keel & Ash); two names written with one address, sharing a first
  or last word, are one person; `Dana M. Reyes` is Dana Reyes. `architects` and `architecture`
  join the generic organisation words.
- New relations, each derived per room from the room's own turns: `has_title` (the appositive,
  one per person), `client_of` (the user's own words, "X is a new client", "our new client X";
  taught ones too), `repo_for` (a repo named after an organisation, together in 2+ sessions) and
  `deadline` ("due / launches / ships (on / by) <date>", read against the turn's own time,
  closed at read time two days after its date). `prefers` and `decided` are read only with
  `config.memory.relations.{prefers, decided}`, off by default. Client, deadline, preference and
  decision phrasings count only in user turns; code talk ("the API client", "ship it Friday")
  makes none. Titles, dates, preferences and decisions are value nodes a prompt never matches.
- Migration 5 re-reads every turn once (in the background), because extraction changed.
- The derive's write is one transaction per room with a yield between. Measured on 4,350
  fictional sessions (9,300 turns), best of four: cold derive 820 to 908ms, worst block 57 to
  104ms; an unchanged re-derive 146 to 286ms, worst block 14 to 67ms; `memory.relevant` p95
  under 1ms. On the eval world `relevant` p50 0.08ms, p95 0.17ms.

- The user corrects a fact (decision 4). `memory.correct {fact | subject, rel, object; action;
  object?; at?; note?; room?}` with `wrong` (never true, dropped from every vote in scope),
  `ended` (closed at `at`; older evidence never reopens it, newer opens a new row), `replace`
  (ended, plus a row sourced `user`, confidence 1, shown as "your correction"), `confirm`
  (confidence 1, no decay, never closed by derive) and `add`. Corrections are rows
  (`memory_corrections`), applied in derive after the votes, so no pass derives them away;
  `memory.corrections` lists them and `memory.uncorrect` undoes one. A newer transcript that
  disagrees with the user marks a conflict and changes nothing.
- `memory.merge {node, into}` makes two nodes one; `memory.split {node, room}` makes the one a
  project's sessions name someone else (two different people with one name, both labelled the
  same), and `memory.split {node, other}` keeps two nodes apart (it undoes a merge).
- Correct, merge and split are owner callers only (`deck`, `cli`, `local`, `capsule`): a session
  or an agent gets `denied`. Events: `memory.corrected {id, action, rel, scope, prior_source,
  prior_rule, prior_confidence}` with no labels, node ids, addresses, notes or session ids;
  `memory.merged {id, scope}`; `memory.split {id, scope}`. Facts carry `origin` and
  `correction`; `memory.why` returns `corrections`.
- CLI: `vyre memory correct|corrections|uncorrect|merge|split|pin|mute`, and `--project <slug>` on
  `vyre memory` and `vyre why`. Stale facts print "last said 10 months ago"; conflicts are marked.
- Reads compile each SQL statement once and cache a room's sessions, so `memory.relevant` p50 on
  the eval world went from 0.21 to 0.16ms.

- Rooms (ADR 0007, decision 1). A room is a project (its folders plus the threads picked into
  it) or `unfiled`. The curator derives every room from its own sessions and lessons with the
  same rules, and writes rows with `room = '<slug>'`; `'*'` rows are the main graph. Deleting
  every other room's sessions leaves a room's rows identical (tested). A session in several
  rooms counts in room R only for things R has from a session of its own or a lesson, so a
  shared planning thread cannot carry one client into another's room. A room keeps its own
  node counts, dates, roles and short forms (`memory_room_nodes`, `memory_shortforms.room`).
- Short forms keep every claimant; a read picks the most precise one in view, so "Summit" means
  Summit Dental in one project and Summit Roofing in another. A short form followed by another
  capitalised word is part of a different name and is not matched.
- Hub rule: an org is a hub of the main graph when it is in at least `max(3, rooms/2)` rooms, or
  anywhere past the session share when no project is named for it. One taught as `client_of` is
  never a hub, so the user's main client is no longer the thing Memory hides.
- When two rooms' `works_at` winners differ and were seen within 90 days of each other, the
  `'*'` row is marked `conflict`; further apart, the newer holds in `'*'` and the older is closed
  there and stays open in its room. Facts and floor-plan edges carry `conflict`.
- `memory.facts`, `relevant`, `why` and `graph` take `room` (a slug or `"unfiled"`, alias
  `project`). Folders one project owns read its room; other folders keep the strict folder view.
  The unfiled room is for the user and agents granted every project. The Harness's Enrich hook
  reads `room: "unfiled"` outside every project instead of the session's folder.
- Memory stores the rooms (`memory_rooms`) from `projects.list` on its first pass and after
  `project.created`, `project.changed`, `thread.picked` and `thread.unpicked`. Picked threads are
  read when `projects.list` gives their ids (`threads` as a list); today it gives counts.
- Decay at read time (decision 3). `memory_edges.seen` is the newest supporting turn over all
  evidence, not the capped six; derive still never reads the clock. `fresh = max(floor, 0.5 ^
  (days / half-life))`: identity 365 days (floor 0.4), `works_at` 180 (0.25), `mentioned_in` 30
  (0.1); what the user said or confirmed does not decay. `memory.relevant` multiplies its score
  by `fresh` and leaves out facts under 0.35 unless pinned; `memory.facts` lists them with
  `stale: true`, `fresh` and `seen_age` ("10 months"). Silence never closes an edge.
- Migration 4 adds `room`, `seen`, `conflict`, `origin` and `rule` to `memory_edges` (the unique
  key gains `room`) and a `rederive` flag, so every existing home derives once more.

- `memory.graph {project_cwds?, around?, depth?, limit?, since?, agent?}`: the graph as a floor
  plan for the Deck. One room per project (from `projects.list`), a Shared room for the people
  and organisations several projects have, and a No project room; entity, thread and fact nodes;
  capped (entities, then taught facts, then two recent threads each); `around`/`depth` for one
  node's neighbourhood. `updated` is a durable cursor (`memory_meta.graph_version`) that moves
  when a derive writes something or a pin or mute changes; `since` returns `{unchanged: true}`.
  `memory.curated` now carries `updated`.
- Project graphs are strict (SPEC 7.4): with `project_cwds`, facts, relevant, why and the floor
  plan use only that project's sessions and the lessons taught for it (or for everywhere). A
  fact another client's sessions established is not shown, not cited as a source, not counted,
  and not even found by name; a closing date only another project's sessions give is left off.
  Folder matching is exact (it used SQL `LIKE`, which ignores case).
- The main graph is for the user and the assistant. A named agent (in the caller as
  `agent:<name>`, or `input.agent`) is checked against `agents.list`: an agent granted every
  project sees it, any other sees only its projects' graphs, and when agents cannot be checked
  it is refused. `memory.graph` without a scope is drawn only for the Deck, the CLI, modules and
  verified all-projects agents. `memory.stats`, `curate`, `pin` and `mute` are guarded too.
- Measured on a copy of a 108k-turn index with 12 projects: main graph 70ms, one project 150ms,
  `around` 50ms, an unchanged poll under 1ms.

- A taught fact can carry `project_cwds`, the project's folders. `memory.facts {project_cwds}`
  includes facts taught for that project (a folder equal to or under one asked for, the rule
  sessions follow) even when no session of the project names their subject, and leaves out
  facts taught only for other projects; `memory.relevant` applies the same rule. A fact taught
  without folders belongs everywhere and keeps the stored form and key it had before.

- Short forms are measured per identity, not per spelling. One firm written several ways
  ("Harlow Legal", "Harlow Legal Group") shares a domain, so its spellings are pooled and the
  result is credited to the most-seen one. On the real index one firm's spellings measured 0.57,
  0.29 and 0.21 apart, so "the Harlow team" found nothing although the word meant that firm
  every time; pooled, it clears the bar. The bar itself (0.6, two sessions) is unchanged, and a
  common word that starts a name ("park" for Park Dental) still measures far below it.

- `memory.teach {kind, fact, from}`, the internal tool behind `ctx.memory.teach`: only modules
  can call it, and the lesson is recorded under the calling module the loader names, never the
  `from` it claims. A fact is graph-shaped (`subject`, `rel`, `object`, `text`, `at`, `key`,
  `forget`) and lands on the same nodes the transcripts build. Its provenance is
  `{module, kind}` (table `memory_lessons`) where a transcript fact has `(session, seq)`, so
  `memory.why` names the module that taught it, and a fact with no supporting turn has
  `source: "taught by <module>"`. Teaching the same fact twice changes nothing; an explicit
  key replaces; `forget` removes it. A taught `works_at` is a strong vote, not an override.
  Taught facts make a graph even with no Recall index.
- Facts now include every relation except `mentioned_in`, so taught relations and notes show in
  `memory.facts` and `memory.relevant`.
- The first derive after vyred starts no longer blocks the event loop for about 600ms on a
  large corpus: the rowid map and the observations are read in pages with a yield between
  pages. Measured on a copy of a real 103k-turn index: worst block 70 to 120ms.

- `core/memory`: the graph and the curator, the only writer of `memory_*` tables. It reads
  Recall's tables and never runs a model. Each turn is read once by `(session, seq)` into
  observations; the graph (people, organisations, addresses, domains, repos, who works where,
  learned short forms) is derived from those and written as a difference, so a second pass
  over the same turns changes nothing.
- Edge `valid_from` is `NOT NULL`, 0 meaning atemporal. A NULL inside the unique key is what let
  the prototype append a copy of every edge on each run.
- `works_at` is voted by focus (a session's share of its organisation mentions), plus explicit
  phrasings ("Sam Okafor at Northwind Bakery") and addresses at an organisation's domain. Tools,
  hubs and the user's own organisation (from `config.me`) get no vote, because each of them
  outvoted real clients in the prototype. A move closes the old edge where the new one starts.
- Short forms ("Harlow" for Harlow Legal) are learned by measuring their precision over Recall's
  full-text index, and used only at 0.6 or above.
- Tools: `memory.facts`, `memory.relevant` (for the M2 Enrich hook), `memory.why`, `memory.pin`,
  `memory.mute`, `memory.curate`, `memory.stats`. Emits `memory.curated`; listens to
  `session.indexed` and drops a rewritten session's observations before reading it again.
- Curation runs in the background on start and shortly after each `session.indexed`, yielding
  to the event loop. With no Recall tables the module starts and answers with nothing.
- `vyre memory [about]` and `vyre why <fact>`, in the Recall gold.
- A fact's `source` is a readable label (the thread's name) and `age` is in words ("3 weeks"),
  which is what the Enrich hook and the projects brief print; the exact turn is in `ref`.
- Measured on a copy of a real 103k-turn index: first pass 6.7s, a pass with nothing new 5ms,
  one new turn 1.2s in the background; `memory.relevant` p50 0.06ms, p95 1.4ms.
- Deck Memory on `memory.graph` (ADR 0007, decision 13): one call with the `since` cursor
  instead of a `memory.facts` call per project. A `memory.curated` whose `updated` is what is
  drawn does nothing; while the tab is hidden it only marks the view dirty, and the one fetch
  waits for `visibilitychange` (no timers, SPEC principle 8). Scope select (Everything or one
  project), rooms and room counts from `graph.rooms`, a truncated footer with Around (depth 1)
  and a breadcrumb back.
- Facts list with gold provenance: the source thread links to the exact turn (`?seq=N`), with
  age and confidence in mono. Inline pin and mute act on the fact's subject and say so. Correct
  turns the fact's object into a field in its own sentence: Cmd+Enter saves (`memory.correct`
  `replace`), "No longer true" (`ended`), "Wrong" (`wrong`), Esc cancels; the closed fact then
  shows muted above the new one, sourced "You, just now", with Undo (`memory.uncorrect`). A
  missing `memory.correct` says so in a status line. "Forget this fact" (it muted the whole
  person) is gone.
- Lessons tab at `/memory?tab=lessons`: Proposed (a Beacon count on the tab), Active, Retired
  (folded) and Proposed skills when `learn.skills` exists. Rows show the rule, level, check,
  scope in words, `applied · caught · broken`, the `learn.stats` verdict and a link to the source
  turn. Accept, Edit (rule and when, through `learn.edit`), Retire, Relax; a `presence_required`
  answer shows how to confirm (the passkey, else the terminal command or the Capsule), in a
  sheet on a phone. `lesson.*` events repaint only the row they name.
- Keyboard: Up and Down move through the list (roving tabindex), Enter opens, Esc closes; in the
  panel P pins, M mutes, C corrects, ignored while typing. Phone: the list, and sheets.
- `deck/fixtures/learn.json` now has core/learn's shape (integer ids, `scope` as `"all"` or
  `{project}` or `{agent}`, `check` objects, `source: {kind, session, seq}`); `memory.json` gains
  `memory.graph`. `deck/test/memory.test.js` covers the cursor, links, lesson words and both
  fixtures' shapes.

#### Projects

- `projects.list` rows add `picks`: the picked thread ids, subagents folded to the parent.
  `threads` and `picked` stay counts. 0.05 ms of a 16 ms list at 1,800 picks.

- Integration on main: `vyre resume` and `vyre start` load the Harness with `--plugin-dir` and
  leave the brief to its SessionStart hook, so Claude reads it once. `VYRE_PROJECT` tells the
  hook which project was chosen, for a thread picked into several. `harness.brief` now asks
  `projects.context {cwd, session}` directly, the shape Projects actually offers. Verified with
  real Claude Code: a project made with `vyre new` briefed a session started in its folder.

- `core/projects`: a project is `<home>/.vyre/project.json`. The marker is the truth and
  `projects_projects` only caches where each home is, so a project outside the configured roots
  is still found and a hand-edited marker is followed. Paths in the marker are relative to the
  home.
- Projects are made by hand. A thread belongs because a person picked it (kept in the marker,
  never removed automatically) or because it ran in one of the project's folders (worked out on
  every read, so a folder added to a marker brings its sessions with it). A thread can be in
  several projects: a hub session picked into two clients belongs to both. Auto-sorting by
  content was dropped because it filed hub sessions under whichever client they named most.
- The catalogue lists every session in Recall's index with its /rename name, first message,
  folder, last activity and projects; subagents fold into their parent. Search matches names,
  first messages and folders, and what was said through `recall.search`; without Recall it
  searches titles only and says so.
- The brief (`projects.context`) is plain text for Claude, capped at 2,400 characters, cut at a
  line break, from one project only. It asks Memory for facts about the project's own folders
  only, never a picked hub's folder, which would pull in other projects' facts. A thread picked
  into several projects and started outside all of them gets no brief rather than a guess.
- Folders are compared by real path. A home typed as `/var/...` never matched a session
  recorded as `/private/var/...` on macOS.
- Tools: `projects.list`, `create`, `add-threads`, `remove-threads`, `catalog`, `of`, `threads`,
  `context`. Events: `project.created`, `project.changed`, `thread.picked`, `thread.unpicked`.
- CLI: `vyre` alone opens this folder's project or lists them; `vyre projects`, `new`, `open`,
  `threads`, `resume`, `start`, `context`, `pick`, `unpick`. `vyre resume` runs
  `claude --resume <id>` in the folder the thread ran in with the brief as
  `--append-system-prompt`; `vyre start` runs `claude -n <name>` in the project home. Every
  prompt has a flag, and prompts read piped stdin a line at a time.
- Every thread Vyre launches loads the Harness with `--plugin-dir` when this install has one,
  and then leaves the brief to its SessionStart hook, so Claude never reads it twice.
- `projects.of` returns `{slug, name, home, folders}`, the shape the Harness calls it with.
- The `vyre` home (spec section 10): `vyre` with no arguments, from any folder, lists every
  project (threads, last activity), New session without a project (`claude` with the Harness in
  this folder), and every agent from `agents.list` ("agents arrive with the switchboard" until
  that tool exists). A project opens to its sessions, newest first, plus New session in it; a
  session resumes. Inside a project's folder that project is preselected, not opened. It is an
  arrow-key list with type-to-filter on raw-mode stdin, with no dependencies and plain ANSI, so
  it works over SSH. Enter picks, Esc clears the filter or goes back, and q quits (while
  filtering, q is a letter). Piped, it prints the same list and exits. The list logic is pure
  and tested directly; the flow is tested through stand-in terminal streams with a fake
  `claude`, and was run once through a real pseudo-terminal.
- The catalogue was taking 2.6 seconds per call on a real 614-session index, with or without a
  search, because it resolved every session's folder through realpath. Most of those folders no
  longer exist, so each lookup walked up the parents failing at every step. Session folders are
  now used as recorded, since Claude Code already writes real paths. A search takes 17 to 30 ms,
  with one `recall.search` call (limit 100, Recall's cap), and a test bounds both the Recall
  calls and the path lookups.

### M0 · the skeleton (2026-09-26)

- `vyred`: one daemon per machine on a private unix socket (`~/.vyre/vyred.sock`, mode 0600).
  Refuses a second copy on the same home and clears a stale socket left by a crash.
- HTTP API under `/v1/`: `health`, `modules`, `tools`, `tools/:name`, `events`. Every response
  is `{data}` or `{error:{code,message}}`.
- Module loader: validates the five-verb manifest, starts modules in dependency order, and
  fails one module without taking the daemon down. A module can register only the tools and
  emit only the events its manifest declares.
- Every tool call, from any surface, passes through the rules hook before it runs.
- Event log in SQLite; names must read `noun.past-verb`; payloads that look like secrets are
  refused.
- Store: WAL and a 10 second busy timeout on every connection; module tables must carry the
  module's name; each migration runs once, in a transaction. The database files are mode 0600.
- `vyre` CLI: `status`, `up`, `down`, `modules`, `tools`, `call`, `version`.
- A hygiene test fails the build if shipped code names a real person or carries a key.
- No dependencies.

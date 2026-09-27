# Capsule parity: Electron vs native

Audit by capsule-now, 2026-09-27. Electron: `work/capsule-now` (`local/capsule/app`, `lib`,
`swift`). Native: `work/capsule-pro` at 4b15618 (`local/capsule/native`). Both were read, not
run. Electron behaviour is from the code and `docs/work/capsule.md` Done; the native status is
from its code and `Tests/`.

Status: **same** (parity), **partial** (there, with a gap noted), **not wired** (built and often
tested, but nothing in the running app reaches it: `App.swift` gives the model only Apps, Settings,
Files and Dictionary), **missing** (not built), **native only** (Electron never had it).

## Retire blockers, in order

Electron can go when these reach **same**. Everything else below is polish or native-only.

1. **Waiting list and review cards.** Gate holds, asks and proposed lessons, the ↑ list, the mail
   draft card with in-place edits, Allow/Deny, Accept/Decline. The native types and folding
   exist (`State.swift`, `Bridge.swift`) but nothing subscribes and there is no UI. This is the
   Capsule's main job for agents.
2. **Destinations router.** Native always asks haiku with no chip, and sends to the chip with
   one. Electron's router picks the assistant for "your own things", shows "Sends to / Or" with
   ↓ alternatives before Enter (floor rule 2), and picks a thread inside an @agent or @project.
   `Route.destinations` is built and tested but not wired.
3. **Follow-up, Deeper, Copy.** Native has none in the reply view. A follow-up starts a new thread.
4. **DMs with agents.** The native model (`State.swift` DM fold) exists; there is no view and no
   `threads.get` history.
5. **Menu-bar Beacon dot and waiting count.** Native shows a plain "Vyre" item.
6. **Clipboard history, module rows and vault fill, one-time codes, contacts, Glass, watch and
   drive rows, notifications for watched threads.** All built and tested natively, none wired.
7. **Calculator Enter.** Native's calc row has no action, so Enter does nothing (⌘C works).
8. **Offline line in the panel.** Native has no "vyred is not running" state in the panel beyond the
   `@` line and send errors.
9. **Stop really stops.** Native calls `threads.stop` with `id` instead of `thread`, so Esc only
   stops following. Quick threads are also never stopped on hide, and no lease is released.
10. **Tooling.** `vyre up` reports a native-only setup as "not installed". `capsule.status` and
   autostart still point at Electron. The native app ignores `capsule.requested`, so
   `capsule.show` from vyred does nothing.

## Opening, window, Spaces

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Double-Control, chords ignored, listen-only tap, re-arm on timeout | hotkey.swift child, 450 ms | Hotkeys.swift in-process, same rules | same. Native starts it only when Input Monitoring is already granted |
| Hot key without permission | none | ⌥Space via Carbon, `VYRE_CAPSULE_HOTKEY` (space, return, k, j, v only) | native only (partial parser) |
| Turn on Control twice from the menu | helper exits 2 with a message, retried every 30 s | "Turn on Control twice…" asks once | partial: native needs a relaunch after the grant |
| Front app captured at the gesture | yes (gesture line, 150 ms fallback) | `host.front` at wake | same |
| Toggle on gesture / relaunch | gesture toggles; second instance shows or `--toggle` | gesture toggles; reopening Vyre.app toggles | same. Native: `vyre capsule` while open hides it |
| 680 wide, 56 px bar, grows down, screen under the mouse | 18% down | 22% down | same (placement differs a little) |
| Over full-screen apps, no Space switch (rule 6) | only with `VYRE_CAPSULE_STAY=1` | nonactivating NSPanel, popUpMenu, collection behaviour re-set each show, orderFrontRegardless + makeKey | native is better, and is now the default |
| Hide on blur; pinned while a reply streams or a card is open | yes | hides on click elsewhere or key lost; no pin | partial: native has no pin, so a click away mid-reply or mid-edit closes it |
| Reset on open, keep a streaming reply | reset every open | reset after 30 s hidden | same in spirit |
| Only the user's gesture focuses the box | yes | yes (key only on show) | same |
| Remote open (`capsule.show` -> `capsule.requested`) | followed | not subscribed | missing |
| Autostart (`capsule.autostart`) | spawns Electron `--hidden` | Electron only | missing for native |
| No Dock icon, single instance | yes | LSUIElement, accessory | same |

## Menu bar

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Mark with Beacon dot when something loud waits | yes, quiet lessons excluded | plain mark | missing |
| Tooltip "N waiting on you" / "vyred is not running" | yes | "Vyre" | missing |
| Menu: Open, Waiting · N, hotkey state, vyred state, Quit | yes | Open, hotkey state, Turn on…, vyred state, Quit | partial: no waiting line |

## Typing and @

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| @ completes agents, projects, threads (7 rows, ranked, subtitles) | yes, at the caret | yes, at the end of the text only | partial: caret ignored |
| Chip, ⌫ at start removes it, agent opens a DM | yes | chip and ⌫ yes, no DM | partial |
| No match copy, no switchboard copy | yes | "Nothing called that in Vyre." | same |
| Catalog: agents, projects, catalog, threads, per-project threads | parallel | sequential; never sets the box address | partial (Glass off because of it) |
| Staleness refresh on project/thread/agent events | yes | reload on each show | partial |

## Destinations and sending

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Destination shown before send, Enter sends what is drawn (floor rule 2) | "Sends to / Or" rows, ↓ alternatives | "to X" label on the bar | partial: one destination only |
| Router: assistant for own things, fast/deeper Claude, memory-only | yes | built and tested (`Route.destinations`), not used | not wired |
| @agent picks its best thread; @project new vs best thread | yes | agent: agents.ask; project: new thread only | partial |
| Unavailable destination said before Enter | yes | error after Enter | partial |
| agents.ask wait:false, thread named by thread.sent | yes | yes | same |
| threads.start in a project, lease held | yes | yes | same |
| Existing thread (threads.send), holder refusal, ⌘⏎ takes the keyboard | yes | refusal words yes, no ⌘⏎ take | partial |
| Busy-session queue (rule 5) | yes | yes, with the "still gets it" stop note | same |
| Lease released and quick threads stopped on hide | yes | no release or reap found | missing: quick Claude processes may idle while hidden |

## Memory box

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| memory.relevant limit 3, recall.search limit 10 per_session 1 | yes | yes | same |
| Quote vs fact, "From memory" / "From your sessions" (rule 2) | yes | yes | same |
| Ranking: drop echoes and Capsule threads, statements first, max 2 (rule 7) | said.js | Said.swift | same |
| "You own a blue Volvo XC40." line with its quote as source | yes | yes | same |
| When it shows | recall only for questions and default destination | question-like, or no local row at 0.6 | same in spirit |
| Open a source (recall.thread, turns around the hit) | ⏎ / click | `SourceView` unused | missing |
| "<ms> ms", "more" facts, memory-only view with "⇥ ask X instead" | yes | no | missing |

## Quick answers and the reply

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Lean haiku thread in the scratch folder, named "Capsule: …" | yes | yes | same |
| Memory on screen sent in the append (rule 1), "said" line not sent | yes | yes | same |
| "You" line, then who and state, then the answer (rule 4) | yes | yes | same |
| Notices as a faint status line (rule 3) | yes | yes | same |
| Streaming text, done block wins | yes | yes | same |
| Tool lines ("running · Read x") | last 6 drawn | tracked, not drawn | partial |
| Cost and time when done | "haiku · $0.013 · 2.1 s" | "haiku · done · $0.003" | same |
| Markdown: fences, headings, lists, quotes, inline, links shown not followed | yes, built node by node | inline only | partial |
| Follow-up in the same thread | ⏎ | new thread each time | missing |
| Deeper (sonnet) button | yes | no | missing |
| Copy the answer | button | select text only | missing |
| Esc stops, then closes; stop wording | yes | yes, but `threads.stop` is called with `{id}` (CapsuleModel.swift:406) and the tool requires `{thread}`, so the process is not stopped | partial: bug, one-word fix |

## DMs with agents

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| History, pending messages, streaming turns, tools, asks, holder | yes | fold built and tested, no view, no threads.get | not wired |

## Waiting list and review

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| gate.held, threads.asks (or event log), learn.lessons proposed | yes | fold built, not subscribed | not wired |
| ↑ from an empty box, list with ages, A allows | yes | no | missing |
| Mail draft card, To/Subject/body edited in place, ⌘⏎ sends what you see (gate.approve edited) | yes | `HeldCard` types only | missing |
| Non-mail holds, asks (threads.answer), lessons (learn.accept / retire) | yes | no | missing |
| Presence refusal wording (Deck or vyre learn) | yes | "Presence from the Capsule is not built yet." | partial |
| "N waiting on you. Press ↑" hint | yes | no | missing |

## Local results

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Match tiers, synonyms, accents, frecency (same file format) | yes | yes | same |
| Apps | directory scan, 60 s cache | scan + running apps, mtime cache, Hide/Quit/Show in Finder | native better (Hide/Quit not reachable by key) |
| Settings, 45 panes | yes | yes, real pane icons | same |
| Files | mdfind 400 ms, file taste | NSMetadataQuery, file taste, Open with, Trash confirm | native better; ⌥⌘C, ⌘⌫, ⌘Y and drag are not reachable (see notes) |
| Dictionary | yes | yes | same |
| Calculator and units | ⏎ copies and closes | parsed; Enter does nothing, ⌘C copies | partial |
| System commands (lock, sleep, volume, dark mode, restart…) | no | 11 of 19 run, 8 say "not wired up yet"; Lock sleeps the display | native only (partial) |
| Contacts with the one-time grant row | yes | built and tested | not wired |
| Clipboard history, secret filter, clear | yes | built and tested | not wired |
| Module rows (`shows.capsule`), ⌘K actions, vault fill with step-aside | yes | rows and fill built and tested; no ⌘K list | not wired |
| One-time code with countdown | view with a live countdown | status line "20 s left" | not wired |
| Glass rows | yes | built and tested | not wired (catalog never sets the box) |
| Box files (files.search on the paired box) | yes | no | missing |
| Watch and drive rows ("watch X", "tell X to Y") | yes | parser only | missing |
| Recent files, in-documents, mail, currency, time zones, colour, emoji, snippets | no | built and tested | native only, not wired |
| Icons | helper PNG cache | IconCache, QuickLook thumbnails | same |

## Notifications and watches

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| threads.watch, reports, "X is done" notification, click opens the report | yes | `Watches.swift` built and tested, never created | not wired |
| Reports and "Watching A, B" on the empty Capsule | yes | no | missing |

## Offline, dialogs, lightness, tooling

| Feature | Electron | Native | Status / notes |
|---|---|---|---|
| Health backoff 3 s -> 60 s hidden, SSE resume | yes | yes | same |
| Offline banner in the panel, local results still work | yes | local works; no banner | partial |
| dialogsAllowed gating | yes | yes (Notifier, hotkey ask, osascript, extensions) | same |
| Permission states | Contacts via helper | only Accessibility, Screen Recording, Input Monitoring checked | partial |
| Hidden footprint | 212-238 MB, clip poll only | cooled providers, no key monitor hidden | native better (numbers not measured yet) |
| perf-check covers it | Electron | not the native app | missing |
| Driven mode for tests (VYRE_CAPSULE_DRIVE) | yes | none; FakeVyred unit tests instead | missing (needed for journey tests) |
| Open and keystroke timings | open 47 ms, results 11 ms, files 273 ms | none | missing |
| `vyre capsule`, `--hidden`, build, install | Electron | native by default, `--electron` / `VYRE_CAPSULE=electron` fallback | same |

## Keys

| Key | Electron | Native |
|---|---|---|
| ↑↓, ⏎, Esc layered | yes | yes |
| Tab asks (sends to the first destination) | yes | picks an @ row only |
| → / ⌘K action list | yes | missing |
| ⌘⏎ take the keyboard | yes | used for row actions (Show in Finder) instead |
| ↑ from empty box opens waiting, A allows | yes | missing |
| ⌘C | Copy button on replies | copies the selected row |

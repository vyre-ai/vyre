# capsule-apps

Branch: work/capsule-apps · Worktree: ../vyre-capsule-apps · Owner session: capsule-apps · ADR 0022

## Scope

Every Mac app as an `@App` target in the Capsule, without granting each app separately.
Type `@WhatsApp`, Tab, `@juno`, a message, and it is sent after one presence proof.

Owns `local/apps/` (the vyred `apps` module), `core/cli/commands/apps.js`,
`local/capsule/native/Sources/Extensions/apps/` (the Swift half, on capsule-pro's seam) and
`docs/adr/0022-capsule-apps.md`.

### Adapter tiers, best first

1. `connector`: a real API through the connectors team's MCP hub (`mcp.call`) or `google.*`.
   Slack, Gmail, Calendar.
2. `intents`: App Intents through the `shortcuts` binary (Clock timers and alarms). The system's
   App Intents metadata (`Metadata.appintents/extract.actionsdata`) says what exists; a shortcut
   runs it without opening the app.
3. `script`: AppleScript dictionaries run by `osascript` (Notes, Reminders, Mail, Music, Finder,
   Safari). User text goes in through `argv`, never spliced into script source. The Automation
   consent is asked by macOS at first use, only under `dialogsAllowed()`.
4. `ax`: any app's own UI through capsule-sight's `hands` tools (observe, act, verify after each
   act, commit for sends). WhatsApp is the flagship.

### Tools (module `apps`, roles local)

- `apps.list {q?}`: installed apps (name, bundle id, path, tier). Read from the Applications
  folders, cached; no mdfind.
- `apps.targets {app, q}`: contacts, channels, notes, lists inside one app. Cached per app
  for 60 s.
- `apps.act {app, action, args}`: an action that sends nothing as the person (a timer, a note,
  a reminder, the weather, opening a chat). Refuses a sending action with code `sends`.
- `apps.send {app, action, args}`: an action that sends, posts, pays or deletes as the person.
  Declares `presence` with the summary "WhatsApp → juno: <text>", so every non-module caller,
  models included, needs a person's proof for each call. In SESSIONABLE (the lead's decision):
  a short presence session opened by one strong proof covers a burst of sends, each previewed.
- `apps.route {text, app?}`: natural words to `{app, action, args, sends}` (rules first; a lean
  model call only for what the rules cannot place). Never runs anything itself.

### Safety

- The floor and HUMAN_ONLY stand. apps calls hands as a module, so apps.send carries presence
  itself; apps.act never reaches hands.commit.
- Tests use fakes only: a fake `shortcuts`, a fake `osascript`, a fake hands (fake AX tree), a
  fake WhatsApp window the test owns, a fake fetch for weather. No real message is ever sent.
- Light: no timer, no poll, nothing while hidden. Caches expire on read.

## Plan (slices, each usable)

1. Clock (timer, alarm), Notes, Reminders, Weather through the `apps` module and `vyre apps`.
   - T1 module skeleton: manifest, apps.list, the adapter registry, osascript and shortcuts
     runners (injectable), apps.act / apps.send split with presence summary. Tests.
   - T2 adapters: clock (shortcuts), notes and reminders (osascript), weather (Open-Meteo,
     injectable fetch, "Open in Weather"). Tests with fakes.
   - T3 router and apps.route, `vyre apps` CLI ("vyre apps timer 10 min"). Tests.
2. The `@App` picker in the native Capsule (Swift extension on capsule-pro's seam).
3. Slack through connectors' MCP hub.
4. The Accessibility adapter, WhatsApp flagship (contact search, preview, presence, send).
5. A generic "any app" adapter.

### Slack (slice 3) design, agreed with connectors
- Slack sends are `gated` actions: apps.act runs them (no presence), calls
  `mcp.call {server, tool, arguments}`, and returns `{ held, preview }`. The surface then calls
  `gate.approve {id}` as the person: that is the one proof, and the hub releases the approved
  arguments once. The Deck's Gate shows the same item. apps.send (presence, session) is for AX
  sends only (WhatsApp), where no Gate exists.
- The Slack server is picked by the person in settings (stored by name); a default is suggested
  by matching tool names (slack_post_message, slack_list_channels, slack_get_users, or
  conversations_add_message, channels_list). Tests use core/mcp/testing/fake-mcp.js with
  FAKE_MCP_LOG to prove nothing arrives before approval and exactly one call after.

## Done
- ADR 0022 claimed in docs/work/README.md.
- Slice 1, T1 and T2: the `apps` module (local/apps): env.js (injectable exec, osa with argv
  only, shortcuts over temp files, the no_dialog and not_mac gate), installed.js (apps.list scan,
  5 min cache), adapters clock, notes, reminders, weather, and the four tools. 39 tests, all
  with fakes, pass on the testbox (`node --test local/apps/*.test.js`).
- Review fixes: notes append refuses locked notes and notes with attachments (not_supported),
  notes targets skip the trash and join once, weather has 10 s timeouts and null guards,
  reminders set time in one step, refuse the past and judge days in env.timeZone, list ids as
  targets, osascript timeouts are setup with the Automation hint, apps.list is capped at 100,
  targets are pruned on write and cleared after an act. 48 tests pass on the testbox.
- Slice 1, T3: `apps.route` (route.js, rules only, model seam at config apps.model),
  `apps.setup` (setup.js, Clock's shortcuts written, signed, opened) and `vyre apps`
  (core/cli/commands/apps.js). 150 targeted tests pass on the testbox, 5 opt-in skipped.

- Slice 3 Slack (2026-09-27): adapters/slack.js, gated sends (apps.act -> held -> gate.approve),
  gatedMark in apps.route, apps.send refuses gated, adapter.ready() for "Which app?". Testbox:
  local/apps/*.test.js + cli apps 204 pass, 0 fail, 5 skipped; slack.test.js includes a real vyred
  with the real hub and Gate and a fake Slack MCP stdio server: nothing arrives before approval,
  exactly one call after. docs:ref regenerated, test/docs-* 61 pass.

- Slice 3 hardening (lead, 2026-09-27): Slack reply/recent/sent actions; no double hold (the
  same held item is returned, again/tried); unreachable coding; the Capsule's approveHeld (native
  7b08a18) checks `sent` after a failed approval and before re-approving a tried item. Testbox:
  apps 209 pass; slack.test.js includes a real vyred where the fake Slack server is SIGKILLed
  after the post arrived: the item goes back to held, sent finds it, a resend is the same item, one
  post only. Swift 285/285.

- Slice 4 WhatsApp (2026-09-27): adapters/whatsapp.js over hands (find/act/commit), sends via
  apps.send; partialTargets for on-screen chats; ax apps offered only when installed. Testbox:
  local/apps + cli apps 214 pass, 0 fail, 5 skipped (whatsapp.test.js: a fake WhatsApp window in
  a Registry with the real apps and hands modules).

## Doing (2026-09-27, resumed)
- T4 done (main merged at abd1e79): planner by default, needs prompts on the route and tool side,
  apps.route {text, app, to} for answers (sendTo in route.js), the `vyre apps` prompt loop (TTY:
  numbered pick, Enter for a lone Did you mean, 3 rounds; else exit 3, JSON with --json),
  local/apps/fuzzy.test.js, CHANGELOG. Testbox: local/apps + core/cli/commands/apps.test.js
  196 pass, 0 fail, 5 skipped. Reviewed; fixed: Apple words inside a message, Ctrl-D as cancel
  plus one Enter at the preview after a question, candidates by id (two people with one name are
  asked about), the bare "whatsapp juno ..." first word, y/n answers, a fuzzy app answer.
  Note for AppsExtension: an id in args.to makes the adapter's preview show the id; real adapters
  must preview with the title.
- Main merged at 1992ab2 (the planner is on main). route.js reads no time now: parseDuration,
  parseClock and reminderParts are gone. The rules say which app and kind (a Clock timer or alarm
  and a Reminders reminder carry `time` until read); askFor/fromPlanner (route.js) and index.js
  parsed() ask planner.parse for the time, and for words no rule placed ("5 min", "10 min timer
  please"), which become a Planner add, or the Mac app for that kind when apps.planner is "apple".
  A Mac app's timed route with no planner.parse is code setup, never a guess; a Planner add stands
  (planner.add reads it). The planner adapter's fallback line comes from planner.parse too.
  route.test.js runs the same table through the real core/planner/parse.js: 105 pass, 0 fail.
- Slice 2 Kit (work/capsule-apps-native): capsule-pro 07af5e5 merged at 8cba106 (resolutions as
  recorded before; plus AgentDestinations lost a stale askItem call). Extension suites 18/18 on the
  Mac; capsule-mac CI run 36282275995 on 8cba106 was cancelled at 45 min: the "Vyre Local signing"
  step hangs on capsule-pro's line (their 834b28e too; main skips it). 7423c8c (includes 8cba106)
  pushed, run 36312964068; every step before signing passed. Handed 7423c8c to capsule-pro
  (2026-09-27) with the hang report.
- AppsExtension (same branch, 8ce0cad + 4d40355): @App from apps.list with .file(path) icons,
  known apps first, others once named; nesting apps list apps.targets (read on pick, refreshed per
  words); Enter: apps.route with the contact's raw id; non-sends run at once via apps.act; sends
  preview then send on the second Enter via apps.send presence:true; gated (Slack) sends apps.act
  then gate.approve presence:true. Review fixes: Kit boxChanged() (called on text/chip change)
  forgets a preview, held Return ignored (Panel), hide/box generation guard, busy guard, gated
  without held stops, no send by display name. Extension suites 28/28 on the Mac.
  7423c8c: the row for words without @ (AppsWords.swift, a full-speed provider): app-like first
  words only reach apps.route; sends use the host's ResultAction.confirm. Extension suites 29/29.
  The presence summary is still defaultSummary until capsule-pro's host.prove(summary:) lands.
- Lead (2026-09-27): the real-Mac check runs after the integrator merges work/planner.

## Next
1. DONE: handed 7423c8c to capsule-pro. Was: send capsule-pro the hash to merge. Then run capsule-mac CI on
   4d40355 (the AppsExtension) and hand that over too (it changes Kit, CapsuleModel,
   ExtensionHost and Panel by one line each: see Changed contracts).
2. DONE (native a8859f0, Swift 284/284): sends prove via host.prove / link.call(summary:). capsule-pro merged
   7423c8c at 6ff7185 and fixed the CI signing hang. capsule-pro merged a8859f0 (d9e42018) and added
   apps.send to VyredClient.sessionable (a8dd925a): one Touch ID covers a burst of sends.
3. DONE: Slack adapter (slice 3), see Done. Next: WhatsApp over hands (slice 4: hands.find,
   settleMs up to 5000, press Send rather than key Return; needs_front for keys), then any-app.

### Real-Mac check (planner default; the lead with the user, on the Mac, in the user's own terminal)
Before: the planner module (work/planner, ADR 0025) must be on the branch under test, or steps 4
and 5 answer code setup, "The planner is not on this Vyre yet" (that answer is itself a pass for
"never silently nothing"). No step sends a message to anyone.
  1. `cd <worktree> && VYRE_MAC_REAL=1 nice -n 15 node --test local/apps/mac.test.js`: the five
     scripts compile.
  2. Run vyred from this branch (`bin/vyre down`, then `bin/vyre up` from the worktree).
  3. `bin/vyre apps find note`: Notes shows tier script and bundle id com.apple.Notes.
  4. Planner (the default): `bin/vyre apps timer 1 min`, `bin/vyre apps remind me in 2 min to
     check vyre`, `bin/vyre apps todo buy milk`, `bin/vyre apps note: Vyre check`. Each prints one
     line and no prompt of any kind appears (no Touch ID, no Automation dialog, Clock, Notes and
     Reminders stay closed). The timer and reminder ring through the planner on time.
  5. `bin/vyre call planner.list '{}'` (or the Deck's Planner page) shows the four items.
  6. Apple Notes, opt-in: `bin/vyre apps note: Vyre check in apple notes`: allow Notes in the
     Automation prompt once; it prints "Note saved: Vyre check" and the note is in the default
     folder. `bin/vyre apps targets notes vyre` lists it with its id; a note moved to Recently
     Deleted is not listed. `bin/vyre call apps.act '{"app":"Notes","action":"append","args":{"note":"<id>","text":"line two"}}'`
     adds the line; on a note with an image the answer is not_supported and the image stays.
  7. Apple Reminders, opt-in: `bin/vyre apps --app Reminders remind me in 2 min to check vyre`:
     allow Reminders once; the reminder is in the default list and alerts two minutes later.
  8. Weather: `bin/vyre apps weather tomorrow` roughly matches the Weather app;
     `bin/vyre call apps.act '{"app":"Weather","action":"open"}'` opens Weather.
  9. Apple Clock, opt-in: `bin/vyre apps --app Clock timer 1 min` answers setup;
     `bin/vyre apps setup clock` opens two Shortcuts import windows: click Add Shortcut on each
     (an unknown action: build it from the printed steps and note the identifiers for ACTIONS in
     setup.js). Then `bin/vyre apps --app Clock timer 1 min` starts a Clock timer and
     `bin/vyre apps alarm 7:05 in apple clock` adds a 07:05 alarm. Clock does not come to the front.
  10. Questions, never nothing: `bin/vyre apps tell juno I'm running late` asks "Which app?" with
      the messaging apps on this Mac; press Ctrl-D and it prints "nothing sent".
      `bin/vyre apps tell juno I'm running late < /dev/null` prints the question and exits 3
      (`echo $?`). Nothing is sent in either.
  11. Delete the check note, reminders, todo and alarm (and the planner items).
- Known limit: Notes' trash is skipped by its name ("Recently Deleted", or config
  apps.notes.trash); the dictionary gives that folder nothing else, so another language needs it.
- The Capsule half (@App, contacts, Enter twice) is checked once capsule-pro has merged the
  native branch; its steps come with that handoff.

### Real-Mac check, WhatsApp (the lead with the user; sends ONE real message, to the user's own
"Message yourself" chat, only with the user watching and saying yes)
  1. Build hands (local/hands-mac/build.sh, through the build lock) and grant Accessibility once.
  2. With WhatsApp open: `bin/vyre call hands.find '{"app":"net.whatsapp.WhatsApp","role":"AXTextField"}'`
     and the same for AXCell, AXTextArea, AXButton: note the real names of the search field, the
     chat rows, the message field and Send. Put any that differ in config apps.whatsapp.
  3. `bin/vyre apps targets whatsapp`: the chats on screen, by name.
  4. `bin/vyre apps whatsapp <the user's own chat name>: Vyre check` and prove it: WhatsApp stays
     in the background, the chat opens, the words appear, Send is pressed, "Sent to ... on WhatsApp".
  5. A wrong name (`bin/vyre apps whatsapp nobody-here: x`) is not_found and nothing is written.

## Standing rule (user, 2026-09-27): Vyre must not nag
The user runs on bypass permissions. No prompt or Touch ID for the person's own actions (notes,
reminders, timers, todos, planner items). Touch ID only for pairing a new device, vault secrets,
and sending, posting or paying to the outside world (WhatsApp and Slack sends), and one Touch ID
covers about 30 minutes per device (the presence session). The preview plus Enter stays for
outbound sends. So apps.act never asks; apps.send and gate.approve do, riding the session.

## Needs from others
- capsule-pro: merge the Kit branch once handed over; add host.prove(tool:input:summary:) and
  the host-minted presence session (secret in memory only, dropped on lock/sleep/restart).
- capsule-pro: the native host must be on main before the Swift half runs in the app (slice 2).
- capsule-sight: hands.observe/act/commit on main for the AX adapter (slice 4).
- connectors: the MCP hub on main, and which server name the user's Slack uses (slice 3).
- lead/user: import of the Vyre Clock shortcuts once (one click each), checked on the real Mac.

## Changed contracts
- core/gate (owner gate-chat): gate.settle {id, outcome "sent", evidence} and gate.settled; a
  failed approval says reached. core/mcp/hub.js (owner connectors): errors carry detail.reached.
  Both noted in docs/work/gate-chat.md and docs/work/connectors.md. The Capsule (native 95aad5f)
  settles what it found in Slack and skips the check when reached is "no".
- core/gate/index.js (owner: gate/security): previewOf also reads an MCP call's words from
  content.arguments (text, payload, message, body, content), so gate.approve's presence line is
  not blank for hub-held calls. core/mcp/hub.js (owner: connectors): TO_KEYS gains
  conversation_id. Both from the Slack slice's review; tested in local/apps/slack.test.js.
- apps: an adapter action may be `gated` (apps.act runs it, the Gate holds it, apps.send refuses
  it with code gated); apps.route marks such routes `gated: true`; adapters may have ready(env).
- Native Capsule (owner capsule-pro), on work/capsule-apps-native: Kit `CapsuleExtension.boxChanged()`
  (default no-op); CapsuleModel `extensionBoxChanged` called from the text and target didSets;
  ExtensionHost forwards it to every extension; Panel ignores a repeated Return (isARepeat).
- apps.route takes `to` with `app` (an answer to a question); apps.list rows carry `actions` and
  `nests` for apps with an adapter.
- New module `apps` (local/apps) and CLI file core/cli/commands/apps.js.
- core/presence/index.js (owner: presence/security): `apps.send` added to SESSIONABLE, so a
  presence session (ADR 0004: one strong proof, 5 min idle, 30 max, device-bound) proves it.
  docs/adr/0004-presence.md's list of session tools says so. apps.send declares
  `presence.session: () => true`. HUMAN_ONLY is unchanged.

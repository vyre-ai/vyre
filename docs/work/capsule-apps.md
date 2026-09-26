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

## Doing (saved 2026-09-27 at logout)
- T4 WIP (uncommitted work saved as a wip commit, tests NOT run): planner by default and
  structured re-prompts. Files: local/apps/adapters/planner.js, local/apps/fuzzy.js, edits in
  route.js, route.test.js, adapters/index.js, index.js. Spec, as approved by the lead:
  - timer, alarm, wake me, remind me, todo and note route to Planner add {text, kind}, which
    calls ctx.call("planner.add"); if planner.add is missing, code setup, "The planner is not on
    this Vyre yet". Apple Clock, Notes and Reminders are opt-in: "in Apple Notes", config
    apps.planner = "apple", or an @Notes/@Clock/@Reminders scope.
  - planner.parse becomes the single time parser (owned by the planner team, ADR 0025,
    ../vyre-planner). They port our route.js rules (parseDuration, parseClock/fixed, wall, ahead,
    reminderParts, the route.test.js table). Asked for: local answer on the Mac, no box round
    trip. Switch apps.route to it when they send the hash.
  - Never silently nothing: apps.route returns {needs:{app?, recipient?}, ask, text, app?, action?},
    candidates first with didYouMean ("Did you mean Ammi jee on WhatsApp?"). The tool fills the
    candidates (messaging apps; fuzzy apps.targets matches). CLI: prompt on a TTY, else exit 3
    with the needs shape. Tests: ambiguous app, ambiguous recipient, unknown recipient, a refused
    sentence ("tell mom I'm on slack now").
- Slice 2 Kit (branch work/capsule-apps-native, worktree ../vyre-capsule-apps-native):
  708b533 (nested + async mentions) and ff82b8f (all 11 review fixes; CI not rechecked after it).
  Merging origin/work/capsule-pro c778f56 was aborted at logout: conflicts in CHANGELOG.md and
  Sources/Host/{CapsuleModel,ExtensionHost,Panel}.swift. Redo the merge (never rebase, never
  force-push), push, run capsule-mac CI, then send the hash to capsule-pro to merge.

## Next
1. Finish T4 (run local/apps tests on the testbox, fix, commit, push), then review it.
2. Kit: merge c778f56, CI, hand off to capsule-pro.
3. AppsExtension (Sources/Extensions/apps on the native branch): installed apps as @ targets
   with real icons (nests: true for apps with targets), refreshMentions/mentionPicked call
   apps.targets, send() calls apps.route with the app scope; first Enter shows the preview,
   second Enter sends. Sends: apps.send with presence (via capsule-pro's host.prove with
   our summary line, and the session the host mints); Slack: apps.act returns {held} and the
   Capsule calls gate.approve. Rows without @ come from providers (ImmediateResults) through apps.route.
4. Slack adapter (slice 3, design below), then WhatsApp over hands (slice 4: hands.find,
   settleMs up to 5000, press Send rather than key Return; needs_front for keys), then any-app.
5. Rewrite the real-Mac check below for the planner default (Apple steps become opt-in).

### Real-Mac check (after T4, Apple is the opt-in path: add "in Apple Notes" etc. to steps 4-10)
- Real-Mac check (the lead with the user, on the Mac, in the user's own terminal):
  1. `cd <worktree> && VYRE_MAC_REAL=1 nice -n 15 node --test local/apps/mac.test.js`: the five
     scripts compile.
  2. Run vyred from this branch (`bin/vyre down`, then `bin/vyre up` from the worktree).
  3. `bin/vyre apps find note`: Notes shows tier script and bundle id com.apple.Notes.
  4. `bin/vyre apps note: Vyre check`: allow Notes in the Automation prompt; it prints "Note
     saved: Vyre check" and the note is in the default account's default folder.
  5. `bin/vyre apps targets notes vyre`: the note is listed with its id; a note moved to Recently
     Deleted is not.
  6. `bin/vyre call apps.act '{"app":"Notes","action":"append","args":{"note":"<id>","text":"line two"}}'`:
     the line is added. On a note with an image, the answer is not_supported and the image stays.
  7. `bin/vyre apps remind me in 2 min to check vyre`: allow Reminders; the reminder is in the
     default list and alerts two minutes later. `bin/vyre apps targets reminders` lists ids.
  8. `bin/vyre apps weather tomorrow` roughly matches the Weather app;
     `bin/vyre call apps.act '{"app":"Weather","action":"open"}'` opens Weather.
  9. `bin/vyre apps timer 1 min` answers setup. (Both shortcuts start with Get Text from Input,
     since `shortcuts run --input-path` hands the input over as a file.) `bin/vyre apps setup clock` opens two Shortcuts
     import windows: click Add Shortcut on each. If one shows an unknown action, build it by
     hand from the printed steps and note the identifiers for ACTIONS in setup.js.
  10. `bin/vyre apps timer 1 min` starts a Clock timer; `bin/vyre apps alarm 7:05` adds a 07:05
      alarm with its label. Clock does not come to the front.
  11. Delete the check note, reminder and alarm.
- Known limit: Notes' trash is skipped by its name ("Recently Deleted", or config
  apps.notes.trash); the dictionary gives that folder nothing else, so another language needs it.

## Standing rule (user, 2026-09-27): Vyre must not nag
The user runs on bypass permissions. No prompt or Touch ID for the person's own actions (notes,
reminders, timers, todos, planner items). Touch ID only for pairing a new device, vault secrets,
and sending, posting or paying to the outside world (WhatsApp and Slack sends), and one Touch ID
covers about 30 minutes per device (the presence session). The preview plus Enter stays for
outbound sends. So apps.act never asks; apps.send and gate.approve do, riding the session.

## Needs from others
- capsule-pro: merge the Kit branch once handed over; add host.prove(tool:input:summary:) and
  the host-minted presence session (secret in memory only, dropped on lock/sleep/restart).
- planner: planner.parse with our time rules, answering locally on the Mac; the hash when ready.
- capsule-pro: the native host must be on main before the Swift half runs in the app (slice 2).
- capsule-sight: hands.observe/act/commit on main for the AX adapter (slice 4).
- connectors: the MCP hub on main, and which server name the user's Slack uses (slice 3).
- lead/user: import of the Vyre Clock shortcuts once (one click each), checked on the real Mac.

## Changed contracts
- New module `apps` (local/apps) and CLI file core/cli/commands/apps.js.
- core/presence/index.js (owner: presence/security): `apps.send` added to SESSIONABLE, so a
  presence session (ADR 0004: one strong proof, 5 min idle, 30 max, device-bound) proves it.
  docs/adr/0004-presence.md's list of session tools says so. apps.send declares
  `presence.session: () => true`. HUMAN_ONLY is unchanged.

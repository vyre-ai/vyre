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

- Slice 1, T3 (part): `apps.route` (route.js, rules only, model seam at config apps.model) and
  `apps.setup` (setup.js, Clock's shortcuts written, signed, opened).

## Doing
- Slice 1, T3: `vyre apps` (core/cli/commands/apps.js).

## Next
- Slice 1, T3: `apps.route` (rules first) and `vyre apps` (core/cli/commands/apps.js), including
  `vyre apps setup clock`, which the Clock setup error already names.
- The two Clock shortcuts ("Vyre Timer": Start Timer with the input as seconds; "Vyre Alarm":
  Create Alarm from JSON {time, label}) have to be built and shipped as files to import. Both
  must start with "Get Text from Input": `shortcuts run --input-path` hands the input over as a
  file, not as text.
- On the Mac, with the lead's say-so: `VYRE_MAC_REAL=1 node --test local/apps/mac.test.js`
  compiles the Notes and Reminders scripts with osacompile (skipped everywhere else).
- Notes' trash is skipped by its name ("Recently Deleted", or config apps.notes.trash): the
  dictionary gives that folder nothing else to tell it by, so another language needs the config.
- First real run on the Mac, with the lead's say-so: the AppleScripts in notes.js and
  reminders.js have only been checked against fakes.

## Needs from others
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

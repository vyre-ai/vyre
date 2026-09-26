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
  models included, needs a person's proof for each call. Not in SESSIONABLE: one proof, one send.
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

## Done
- ADR 0022 claimed in docs/work/README.md.

## Doing
- Slice 1, T1.

## Next
- See Plan.

## Needs from others
- capsule-pro: the native host must be on main before the Swift half runs in the app (slice 2).
- capsule-sight: hands.observe/act/commit on main for the AX adapter (slice 4).
- connectors: the MCP hub on main, and which server name the user's Slack uses (slice 3).
- lead/user: import of the Vyre Clock shortcuts once (one click each), checked on the real Mac.

## Changed contracts
- None yet. New module `apps` (local/apps) and CLI file core/cli/commands/apps.js.

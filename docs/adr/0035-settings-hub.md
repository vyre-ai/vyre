---
title: "ADR 0035: The settings hub"
summary: One hub on the box holds every setting, session option and design token, at account, project, device and session level. It is one file a person can edit by hand, and every surface (the Deck, the phone, the hosted app, the Capsule) reads it live and repaints on settings.changed.
audience: builders, agents
owner: native-core
status: stable
---

# ADR 0035: The settings hub

Status: accepted, 27 Sep 2026 (the lead) · Workstream: native-core ·
Builds on the settings registry (core/settings, core/config/settings.js), ADR 0033 section 3 and
decision 6 (one hub; the theme and prompt layers are hub values), ADR 0032 (the person and the
device), ADR 0030 (sessions) and ADR 0029 (resilience).

## Context

The person asked for one place for everything they can change: every setting, every session
option and every design token. Every surface should read it live and repaint when it changes.
Today the values are spread out:

- the registry's own table (`settings_values` in the store), for Vyre-owned keys a module has no
  better place for;
- `config.json`, for keys the daemon reads (store `config`);
- each module's own tools (store `tool`: sessions' models and limits, push's kinds, the planner);
- Claude Code's own files (store `claude`), shared with the terminal;
- `config.theme.colors`, served as `/theme.css`, which reads config on every request and knows
  nothing of devices;
- the session's own chips (model, effort, mode), which live with the thread.

`settings.schema`, `settings.get`, `settings.set` and `settings.reset` already give one list over
the first four. What's missing: a file a person edits by hand, a device level (a dark phone beside a
light Mac), the session level in the same list, design tokens as values, and one live read that
every surface follows.

## Decision

### 1. One hub, one list, four levels

The hub is the settings registry: every key any running module declares, with its type, levels,
owner and where it's stored. A key's value is resolved per read, and a narrower level wins:

```
session  >  device  >  project  >  account  >  default
```

| Level | What it is | Who holds it |
|---|---|---|
| account | the person's own value, everywhere | the hub file (or the key's store) |
| project | one project's value (`project: <slug>`) | the hub file (or the key's store) |
| device | one of the person's devices (`device: <id>`): a Mac's Deck, the phone, the Capsule | the hub file |
| session | one thread's chips: model, effort, mode, thinking | sessions (store `tool`), shown through the hub |

A key says which levels it allows (`levels` in its declaration). Device level is for how a surface
looks and behaves (theme, text size, sounds, keys), never for what Claude may do: a key with
`confirm` or `security` may not declare `device`. Session level is only for keys sessions serves;
the hub reads and writes it through sessions' own tools, so a thread's chips and the hub never
disagree.

The device id is the one ADR 0032 already gives each device: the tailnet node for the Deck and the
phone over the tailnet, `device:<id>` for a relay-paired device, and `mac:<host>` for the Capsule.
A surface never invents one: when `device` is left out, the hub uses the caller's own device, and
`settings.snapshot` says which one it resolved (`device` in its answer).

The checker enforces the levels: `session` only on a key kept in a module's own tools (store
`tool`, since the thread's chips live with sessions), and `device` never on a key with `confirm`
or `security`.

### 2. The hub file

Every Vyre-owned value (account, project and device level) lives in one file:

```
<home>/hub.json
{
  "rev": 42,
  "account": { "sessions.effort": "high", "appearance.theme": "vyre" },
  "projects": { "northwind": { "sessions.model": "sonnet" } },
  "devices": { "tailnet:alex-phone": { "appearance.scheme": "paper" } }
}
```

- It replaces the `settings_values` table as the place those values live. The first start moves
  the table's rows into the file (one forward migration) and the table is kept, read-only, for one
  release.
- Keys stored in `config.json` move into the hub file too, except the kernel's boot keys (role,
  ports, paths, modules on and off), which stay in `config.json` because they're read before any
  module runs. The loader reads a moved key from `config.json` for one release when the hub has
  none, and `vyre doctor` names it.
- Claude Code's files stay where they are, so the terminal and Vyre keep sharing them. The hub
  lists those keys with owner C and never copies their values into `hub.json`.
- A module's tool store stays with that module (sessions' models, push's kinds). The hub reads it
  and writes it through the module's own tools, as it does now.

A secret key (`secret: true`) never goes into `hub.json`, which is plain text and in every backup: its value stays in the store, and a hand edit that names one is refused on its row.

Writes are atomic (a temp file, then rename), keep the file's key order, and add 1 to `rev`. The rev that counts is the store's, which `settings.schema` and `settings.snapshot` return; the file's `rev` is a hint, brought up to date on the next write, so vyred never rewrites a file the person is editing. The
store's one write function returns the new `rev`, and every writer (settings.set, platform's
`settings.write`, a hand edit) goes through it, so the event's `rev` is never computed twice.
`hub.json` is in `vyre backup` (core/names/backup.js), so the rollback of a failed `vyre update`
restores the values the old code knew. vyred
watches the file with `fs.watch` (no polling; a missed event is caught on the next read, which
checks the file's mtime). When a person saves a change by hand, vyred reads the file, checks each
changed key the way `settings.set` does, stores the good ones, and emits `settings.changed` for
each. A bad value is kept out, and its row says why ("hub.json: appearance.tokens: text on paper is
3.9:1, needs 4.5:1"). The file is never rewritten to remove it, so the person's text isn't lost.

**A hand edit is not the person's proof.** Anything that can write the home can write `hub.json`,
and that includes a model's Bash. So a hand edit that would loosen security (`security: "loosens"`)
or widen what Claude may do without asking (`confirm`) isn't applied. It waits as a pending change:
the Deck and the Capsule show "hub.json asks to change sessions.mode to bypassPermissions", with the
key's loosens text and "from hub.json", and it applies only when the person accepts it there, never
with a one-click Apply. That goes through `settings.set` with the same
confirm and proof as a change made in the Deck. The harness also refuses a session's Write, Edit or
Bash on `hub.json` (a protected path, like the vault's files), so a model can't even queue the ask.

### 3. Design tokens are hub values

Following ADR 0033 section 3, the first-party `appearance` module (core/appearance, app-design)
declares the keys, at account and device level:

- `appearance.theme`: the preset, `vyre` or `<module>/<name>`. A preset carries both schemes
  (`color.dark` and `color.paper`). Its choices come from the presets installed
  (`choicesFrom: { tool: "appearance.presets", read: "presets" }`, answering `{presets: [{id, label}]}`).
- `appearance.scheme`: `system` (the default: follow the OS), `dark` or `paper`. Usually set per
  device.
- `appearance.tokens`: the person's own changes, a partial `tokens.json`, deep-merged over the
  preset. It's checked by app-design's `check` (`check: { tool: "appearance.check" }`, called as the settings module with `{key, value, level, project?, device?}`, answering `{ok}` or `{ok: false, message}`): AA contrast, a
  3:1 focus ring, the attention role kept, sizes of 12 or more, 44 px targets and fonts that aren't
  empty. The whole value is refused, naming the failing pair.

vyred serves the result for each device by calling `appearance.resolve {device}`:

- `GET /theme.css?device=<id>`: custom properties for the Deck, the hosted app and module frames.
- `GET /v1/theme?device=<id>`: the resolved tokens as JSON for the Capsule (Swift) and the phone,
  in the shape of a whole `tokens.json` (both schemes, never a partial), plus `scheme` and `rev`.
  The app may read this on every platform, the web included.

Both carry the hub's `rev` (with the device) as an ETag and answer `If-None-Match` with a 304. `/v1/theme`'s body is `{data: <appearance.resolve's answer>}`: theme, scheme, the whole tokens.json, css, version and rev. Leave `device` out and the caller's own device is used. Without the appearance module, `/theme.css` falls back to `config.theme.colors` and `/v1/theme` is a 404. `config.theme.colors` is read through `fromLegacy` for one
release, then dropped. The appearance module never applies a preset or changes a token by itself. The Deck's Dark/Paper switch writes `appearance.scheme` at device level.

### 4. Two registry additions (platform's asks)

- `check: { tool }` on a declaration: the hub calls that tool, as the settings module, with the
  proposed value before storing it. It returns `{ ok }` or `{ ok: false, message }`. The type check
  still runs first.
- `choicesFrom: { tool }`: the key's choices are asked of that tool when the schema is read (theme
  presets, installed models, projects), instead of being a fixed `enum`. (`choices` stays the
  fixed list of numbers it is today.)

Each call has a 500 ms deadline. `check` never passes by default: if its module is off or it runs
out of time, the change is refused ("appearance.check is not running", "appearance.check took too long").
`choicesFrom` falls back to the key's `enum`, or to no choices, and the row says so.

Both name only the declaring module's own tools, under the store limits ADR 0033 set.

`sessions.prompt_layers_off` (a list, account and project level) turns off a module's
`teaches.prompt` layer by name. The layers themselves are listed in the hub with their source.

### 5. The live read

One read and one event, for every surface:

- `settings.snapshot { project?, device?, session? }` returns `{ rev, values: { key: value },
  sources: { key: level } }` for the keys that surface shows. Agents may call it as well.
  Values a model shouldn't see (none today) would be left out by a declaration flag, not by
  surface.
- `settings.changed { key, level, project?, device?, session?, apply, rev, value?, by? }` is emitted on every
  change, whatever made it: the Deck, `vyre config`, a hand edit, a module's own `settings.write`,
  or sessions changing a chip. It never carries the resolved value, which depends on who reads it,
  and never a secret one. For a key that isn't secret it carries `value`, the new value at the
  level that changed (null for a reset). `settings.snapshot` returns each level per key, so a surface resolves it
  locally with no second round trip. A surface that cares about the key reads
  it again (`settings.get`, or the theme endpoints for `appearance.*`).
- On reconnect a surface compares its last `rev` with `settings.snapshot`'s and reads again if it
  differs, so a change made while it was away is never missed (ADR 0029).

How each surface follows it:

| Surface | Reads | On `settings.changed` |
|---|---|---|
| the Deck (deck/) | `settings.snapshot` at start, `/theme.css?device=` | re-reads the key; for `appearance.*`, swaps the stylesheet link to `?rev=` (no reload, no flash) |
| the hosted app and the phone (pwa, mobile) | the same, over the tailnet or the relay | the same; the phone's native shell reads `/v1/theme` |
| the Capsule (capsule-pro) | `/v1/theme?device=mac:<host>` and `settings.snapshot` | refetches with `If-None-Match: <rev>` and repaints |
| `vyre config` (polish-cli) | `settings.get` | not needed (one-shot) |
| sessions | `settings.resolve` at thread start | a key with `apply: "live"` is applied to running threads; `apply: "session"` waits for the next thread |

Nothing polls. A hidden surface doesn't re-read until it's shown again, and then compares `rev`
once.

**The known limit.** On a Mac, any program running as the person can edit `hub.json`, as it can edit
`config.json` or the store today, and so change a plain setting (a model, a limit, which asks
notify). The harness keeps sessions from touching it, and on the box the agents' uid can't reach the
home. What loosens security or widens what Claude may do still waits for the person.

**The session level through events.** sessions changes a thread's chips with its own tools
(threads.model, threads.effort, threads.thinking, threads.mode) and says so with model.switched,
effort.switched, thinking.switched and mode.changed. The settings module hears those and emits
`settings.changed {level: "session", session: <thread>}` with the next rev, so sessions never emits
another module's event.

## Build plan

Each step ships with tests in a temp home. None touches a real `~/.vyre`, `~/.claude` or the
user's files.

1. **Hub file** (native-core): `hub.json` store, migration from `settings_values`, atomic writes,
   `rev`, the file watch, hand-edit checks, pending asks for confirm and loosening keys, and the
   harness's protected path. Tests: precedence across the four levels; a hand edit emits
   `settings.changed`; a bad hand edit is kept out and named; a hand edit to `sessions.mode` waits
   for the person; a model's Write to `hub.json` is refused.
2. **Device and session levels** (native-core, then sessions): `device` and `session` on get, set,
   reset and snapshot; the session level through sessions' tools. Tests: a phone's theme doesn't
   change the Mac's; a thread's chip shows as source `session`.
3. **check and choices** (native-core, with platform): the two declaration fields, validated by
   `validateDecls` under the store limits.
4. **Appearance module** (app-design, core/appearance): `appearance.theme` and `appearance.tokens`,
   `/theme.css?device=`, `/v1/theme`, `fromLegacy`. Tests: an AA failure is refused, naming the
   pair; the ETag moves with `rev`.
5. **Surfaces**: the Deck (native-core), the hosted app (pwa), the phone (mobile), the Capsule
   (capsule-pro) follow `settings.changed` and `rev`. Each adds one test that a change repaints
   without a reload.
6. **Docs**: docs/using/settings.md (the file, the levels, what waits for the person) and the
   reference pages from `npm run docs:ref`.

## Who does what

| Team | Part |
|---|---|
| native-core | the hub file, levels, snapshot, check and choices, the Deck's Settings |
| platform | store limits, `settings.write`, the manifest schema |
| app-design | the appearance module, `tokens.json`, `applyOverride` and `check` in `lib/theme`, the preset files |
| sessions | the session level through its tools, `settings.resolve` at start, live keys |
| pwa, mobile | the hosted app and the phone following `rev` and `/theme.css`, `/v1/theme` |
| capsule-pro | the Capsule reading `/v1/theme` and repainting |
| e2e | review of the hand-edit path and the pending asks |

## Open questions

1. Whether the hub file keeps `//` comments (JSON5). Proposed: no, plain JSON, and `vyre config
   edit` opens it with the schema beside it.
2. Decided: device-level values follow a device to a new box after a restore, since they're in
   `hub.json`, which the backup holds.

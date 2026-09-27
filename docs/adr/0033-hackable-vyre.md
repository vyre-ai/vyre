---
title: ADR 0033: Hackable Vyre
summary: A stable, versioned module API, an extension point for every part, user modules and one settings hub that survive updates, `vyre update` with channels and rollback, and third-party modules installed as grants.
audience: builders
owner: platform
status: stable
---

# ADR 0033: Hackable Vyre

Status: accepted, 27 Sep 2026 · Workstream: platform ·
Builds on the module contract (SPEC section 5, docs/build/module-contract.md), ADR 0008 (install
journey), ADR 0030 (sessions and providers), the settings registry (native-core) and
docs/architecture/boundaries.md (ci).

## Context

Vyre is open source and already "everything is a module": `core/modules/index.js` loads folders
with a `module.json`, and modules reach each other only through `ctx.call` and events. The person
wants more than that. Anyone should be able to make Vyre their own, build a module for any part,
change things their own way, and still get every update the project ships.

What works today for an outside author, without editing the repo:

- A folder in `<home>/modules/<name>/` loads, with tools, events, vault needs, memory teaching,
  streams and routes. Its tools reach MCP, HTTP, `vyre call` and (through `shows.capsule`) the
  Capsule.
- Watchers (`<home>/watchers/`), colour overrides (`config.theme.colors`), per-agent instructions,
  and external MCP servers through the hub.

Everything else is a hard-wired list inside the repo: Deck routes and settings sections, chat
tool cards, Now cards, CLI verbs, harness brief and enrich, Gate senders, @App adapters, and
prompt layers. There is no API version, no way to replace a first-party module (the first module
found wins and a duplicate is marked invalid), no update command on the Mac, and no release
pipeline: vyre.run always serves one unversioned `vyre.tgz`, and `package.json` says `0.0.1`.
The full inventory is in the appendix.

## Decision

### 1. A stable, versioned module API

**The manifest gets a schema and an API version.**

- `packages/module-sdk/manifest.schema.json` is the one definition, next to a dependency-free
  checker (`manifest.js`). `vyre module check` runs it, the loader adopts it in phase 1, and a
  test holds the SDK types and every manifest in the repo to it. A new manifest key means a
  schema change first; `x-` keys are free for experiments.
- New required field for modules outside the repo: `"apiVersion": 1`. It is an integer that moves
  only on a breaking change. First-party modules get it too; a missing value means 1 during a
  grace period.
- Vyre supports the current major and the one before it. A module asking for a newer major is
  not loaded, and `vyre modules` says "needs Vyre with module API 2; you have 1".
- Additions inside a major (a new ctx method, a new manifest key) are feature-tested, not
  versioned: `ctx.api.has("settings")`.
- `requires` may carry ranges: `"requires": { "memory": ">=1.2" }`. The list form stays valid.

**The v1 manifest.** It keeps the five verbs and adds keys only where an extension point needs
one:

| Key | Meaning | New? |
|---|---|---|
| `name`, `version`, `apiVersion`, `description`, `main`, `roles`, `requires` | identity and load order | `apiVersion`, ranges |
| `does.tools` | tools it registers | |
| `does.providers` | session drivers (ADR 0030) | on work/sessions |
| `does.hooks` | harness hook points it contributes to (section 2) | yes |
| `does.senders` | Gate sender types it adds | yes |
| `does.apps` | @App adapters it adds, as tools | yes |
| `does.commands` | CLI verbs as `{ verb, tool, summary, args? }`, each running a tool (builds `shows.cli`; polish-cli writes the dispatcher) | yes |
| `watches.emits` | event types it may emit | |
| `watches.on` | event patterns it may subscribe to | yes |
| `shows.deck`, `shows.capsule`, `shows.streams` | UI slots and streams (section 2) | slot grammar |
| `settings` | its settings, in the native-core registry's `Def` shape | yes |
| `needs.vault`, `needs.tools`, `needs.network`, `needs.slots` | capabilities the person approves | `tools`, `network`, `slots` |
| `teaches.memory`, `teaches.prompt` | facts for the curator; prompt layers | `prompt` |
| `replaces` | the first-party module it stands in for (section 3) | yes |

**The v1 ctx surface.** This is what an outside module may rely on. Anything not listed is
internal and may change in a minor release.

| Member | What it does |
|---|---|
| `ctx.name`, `ctx.api.{version, has}` | identity and feature tests |
| `ctx.log.{info, warn, error, debug}` (and `ctx.log(msg)`) | module-prefixed logs; `vyre logs <module>` |
| `ctx.call(tool, input)` | the only way to use another module; home modules are held to `needs.tools` |
| `ctx.tool(name, def)` | register a declared tool (`description`, `input`, `run`, `callers`, `presence`) |
| `ctx.events.{emit, on, since, latestId}` | emit declared types; subscribe to declared patterns |
| `ctx.settings.{get, set, on}` | its own declared keys, resolved project over account over default |
| `ctx.store.{db, migrate}` | its own tables (the prefix is enforced at migrate) |
| `ctx.paths.data` | its own folder, `<home>/data/<module>/` |
| `ctx.vault.fetch(name)` | a secret it declared and the person granted |
| `ctx.memory.teach(kind, fact)` | a declared fact kind |
| `ctx.upgrade`, `ctx.route` | streams and routes it declared |

Whole-config access (`ctx.config`), `ctx.remote` and the raw `paths` stay for first-party modules
and are marked internal in the types. Modules that read `ctx.config.<mine>` today move to
`ctx.settings` as they are touched; nobody refactors them for this ADR alone.

**Deprecation rules.**

- A ctx member or manifest key is deprecated in a minor release, with a replacement that works in
  the same release.
- It keeps working for at least 90 days and two minor releases. `vyre modules` and `vyre doctor`
  name every module still using it, and the loader logs it once per start.
- It is removed only when the API major moves. Every removal is in the changelog under
  "Module API".

**Published types.** `packages/module-sdk/` holds `index.d.ts` (the ctx and manifest types,
generated from the schema and the JSDoc in `core/modules`), the schema, and `testing.js`: a fake
registry and temp home so a module's own tests run without a daemon. It publishes as
`@vyre/module-sdk` with the first npm release (npm publish is deferred by the person; until then
`vyre module new` copies the installed version's types into the new module's `types/`).

### 2. Extension points for every part

The rule for every slot: **declarative first, code second.** A module describes what it wants in
the manifest; code runs only where a description can't do the job.

| Part | Extension point | Today | v1 plan |
|---|---|---|---|
| Tools | `does.tools` + `ctx.tool` | works | `needs.tools` enforced for home modules |
| Events | `watches.emits` + `ctx.events` | emit enforced, subscribe open | `watches.on` enforced for home modules |
| Providers | `does.providers` | on work/sessions, with a conformance test | adopt as is |
| Hooks (harness) | none; `core/harness` calls a fixed list | missing | `does.hooks`: `brief`, `enrich`, `pretool`, `stop`. Each maps to a tool the harness calls with a 300 ms budget. `pretool` may only tighten a verdict (allow to ask or deny), never loosen it |
| Internal middleware | none | missing | not planned: the floor stays one function in the kernel |
| Gate senders | fixed `TYPES` map (gmail, http) | missing | `does.senders`: a tool that runs only after the Gate approved the item; the Gate still owns approval, presence and the log |
| Capsule @App adapters | `BUILTIN` list, Swift extensions compiled in | missing at runtime | `does.apps`: adapter actions become tools; a `sends` action goes through the Gate like any outbound; Swift extensions stay compile-time |
| Watchers | `<home>/watchers/` | works | unchanged; later, a module may ship watchers |
| Themes and tokens | `config.theme.colors` (colours only) | partial | hub values: `appearance.theme` (a preset, including a module's `themes/`) and `appearance.tokens` (colours, fonts, radii, spacing), checked before they're stored; `/theme.css` for the Deck and `/v1/theme` for the Capsule (section 3) |
| Prompt layers | per-agent instructions, project brief | partial | `teaches.prompt`: markdown files at account, project or agent level, ordered, capped in length, listed in the hub with their source and switched on or off there |
| Settings | none per module | missing | `settings` in the manifest, joining native-core's hub (the one place for every setting), so each key gets a Deck row and `vyre config` with no UI work |
| CLI verbs | a folder scan of `core/cli/commands` | missing | `does.commands`: `vyre <module> <verb>` mapped to a tool, with args from its input schema |
| Deck views and panels | static `ROUTES`, `PLACES` | missing | `shows.deck` slots (below) |
| Settings sections | static `SECTIONS` | missing | generated from `settings` groups |
| Chat message renderers | `switch (b.tool)` in deck/chat/blocks.js | missing | `renderer:<tool>` slot: a declarative card (title, fields, diff, link) first, code later |
| Slash commands | Claude Code's own | n/a | `slash:<name>` maps to a tool or a prompt layer |
| Now cards | fixed in deck/views/now.js | missing | `now:<tool>`: a tool that returns cards in one card shape |
| Capsule | `shows.capsule` (`results:`, `action:`) | works | adopt; document the key grammar and warn on unknown keys |

**UI code and trust.** A Deck script runs with the person's rights: it can call person-only
tools as `deck`. So module UI code never runs in the Deck's own page unless it is first-party.
A third-party view or custom renderer loads in a sandboxed iframe on its own origin
(`/m/<module>/`), talks to the Deck by `postMessage`, and every tool call it makes goes out as
`module:<name>`, so the floor treats it as a module, never as the person. Declarative slots need
no code at all, which is why they come first. app-design owns how slots look; pwa owns the loader.

**Slot rules (app-design).** A module supplies data, never styles.

- A Now card has the Needs row's shape: a title, one detail line, then `kind · source · project`,
  and at most two actions, one of them primary. A card reaches Needs only by raising a real ask
  through the Gate. Every other module card sits in a "From modules" section below Needs and
  Working.
- A tool card is the session's one-line tool row (icon, verb, mono summary, timer). It expands
  into the template: a title, label and value rows, a diff (lime for adds, a neutral wash for
  removals) and a link.
- A slash command is one line in the / menu: its name and description.
- Placement: the core rail places stay fixed. A "Modules" section under Vault holds at most three
  pinned views, and the rest are reached through the command bar; on the phone, module views sit
  in the Places sheet. Settings gets one group per module under a "Modules" heading at the end,
  drawn from the registry with the same rows, source chips and reset. A `panel:<name>` takes the
  340 px side panel on desktop and a sheet on the phone.
- An iframe gets `theme.css` (the same custom properties as deck/css/tokens.css) and the tokens
  JSON, and swaps `data-theme` when the host posts `{type: "theme", scheme}`. It uses only the two
  type families. The host draws the frame's chrome (title bar, loading, error). A frame never draws
  a Needs row and never asks for presence itself.

**The Deck seam (pwa).** One file, `deck/js/slots.js`, reads `shows.deck` from `GET /v1/modules` at
launch and again on `modules.changed` (never polled). It offers `register(kind, id, def)` and
`list(kind)` for view, panel, settings, now and renderer. The Deck's own routes, settings sections,
Now cards and tool cards become first-party entries registered at load, so they stay inline and
synchronous. `/v1/modules` gives each module's version and a content hash, so the Deck can tell a
changed module without refetching. The service worker treats `/m/<module>/` as network-only, like
`/v1/`, so an update is never masked by a stale cache and one module can't poison another's.

### 3. User modules and the one hub, both surviving updates

**One hub (the person's directive, 27 Sep 2026).** Every setting, every session option and every
design token lives in one place: native-core's settings registry, the hub. Every surface (the Deck,
the Capsule, the phone, the CLI) reads it live and follows `settings.changed`. The hub's file under
the home is the single place a person hacks by hand; the Deck's Settings and `vyre config` edit the
same values. There is no separate override folder: a theme, a theme preset and a prompt layer are
values in the hub like any other setting. native-core owns the hub and names its file.

The home holds everything the person made. An update never writes there, except forward store
migrations and the derived files that are listed in the release (the built Capsule app, the
status line script).

```
<home>/
  <the hub file>          every setting, session option and design token (native-core)
  modules/<name>/         their own modules and ones they added (code, not settings)
  data/<module>/          each module's own files
  modules.lock.json       what was added, from where, which version, which grants
```

- **Disable any module:** `vyre module disable <name>` writes `config.modules.disable`. Modules
  that require it show "off: needs <name>" instead of failing the start. The kernel and the floor
  (config, store, events, modules, presence, daemon, gate, harness rules, vault) can't be
  disabled.
- **Replace a first-party module:** a home module takes the original's name and says so,
  `"name": "memory", "replaces": "memory"` (without `replaces`, a duplicate name is refused as
  today). It must register every tool the original declares, with compatible inputs, or it is
  refused and the original loads. The same floor list can't be replaced. After an update, `vyre
  doctor` names any replacement whose original gained tools ("your memory replacement lacks
  memory.answer, new in 0.4").
- **A module's settings stay inside its own rows.** A person's change to a setting carries the
  person's authority, so a module from outside Vyre may keep a setting only in the hub's own table,
  in its own tools (called as the settings module, never as the person), or under its own name in
  config.json; never in Claude Code's files. The loader checks this when the manifest loads, and
  `checkManifest` says the same to authors. A module may write its own plain keys itself through
  the internal `settings.write`; never a key that asks for a confirm or loosens security.

**The theme, as hub values.** Two keys, declared by the module that serves the theme:

- `appearance.theme`: which preset is in effect, `vyre` or `<module>/<name>`. A module may ship
  presets as `themes/<name>.json`; they appear as choices of this key and nothing else. A module
  never applies a preset or changes the tokens by itself.
- `appearance.tokens`: the person's own changes, an object in the shape of a partial `tokens.json`,
  deep-merged over the preset (objects merge by key, arrays and plain values replace). It may set
  `color.dark` and `color.paper` (existing role names only), `font` (the two families and
  weights), `type`, `space`, `radius`, `control`, `motion`, `shadow` and `popover`. It may not
  touch `status`, `layout`, `icon` or `color.attentionAlt`, add a key the tokens don't have, or
  change a value's type.

A change to either key is checked before it is stored, by app-design's `applyOverride` and `check`
(moving from `scripts/lib/theme.js` to `lib/theme` in phase 4, since vyred runs them and `scripts/`
isn't in the package). The whole value is refused, naming the failing pair, when a text/background
pair drops under AA, the focus ring under 3:1, the attention role is removed or reused, a size
under 12, a target under 44 or a font family is empty. A preset gets the same check when it is
installed and when it is picked. The older `config.theme.colors` is mapped in by `fromLegacy` for
one release, then deprecated. The result is `/theme.css` for the Deck and module frames and
`/v1/theme` for the Capsule and the phone, both rebuilt on `settings.changed`.

**Prompt layers, as hub values.** The person's own prompt text is already a hub value (the sessions
module's prompt, versioned, at account, project and agent level). A module's `teaches.prompt`
layers are listed in the hub with their source, each one on or off; the person turns a layer off
there rather than editing a file.

### 4. Updates

What exists: the box's `vyre update` (box/vyre) refetches `vyre.tgz`, checks it against
`SHA256SUMS`, rebuilds the image and restarts; `vyre box update` runs it from the Mac. `vyre up`
restarts a stale vyred. The gaps: no update on the Mac, no versions (always `0.0.1`, so the
Mac-box comparison is blind), no channels, no backup before an update, no rollback (`src.old` is
deleted at once), the box files and the wrapper never refresh, and no release workflow in
GitHub Actions.

**Releases.** A tag `vX.Y.Z` (or `vX.Y.Z-beta.N`) runs a release workflow that builds `vyre.tgz`,
the box files and `SHA256SUMS`, puts them on a GitHub Release with that version's CHANGELOG
section as the notes, and writes `releases.json` (channel, version, url, sha256, notes url, the
lowest version it can update from). vyre.run mirrors the latest stable, so today's install lines
keep working. Versions start at `0.1.0` with the first tagged release, and the module API stays
at 1 while Vyre is 0.x. npm and a ghcr image come later, when the person says so; `vyre update`
reads `releases.json`, so the source can change without a client change.

Where a client finds releases: the GitHub Releases API for `vyre-ai/vyre`, read once a day at
most. `stable` is the newest release that isn't a prerelease; a `vX.Y.Z-beta.N` tag is a GitHub
prerelease, and `beta` is the newest of either. There is no separate index file to keep in sync.
Each release carries these assets (ci owns the workflow):

- the box files, as `scripts/build-site.sh` makes them: `install-box.sh`, `compose.yml`,
  `compose.build.yml`, `vyre.env.example`, `vyre` (the box wrapper), `Dockerfile`, `dockerignore`,
  `vyre.tgz` and `VERSION`;
- `android-<version>-<sha7>.apk` (unsigned) and `android.json` (its `file` names that asset), from
  mobile's Android build on the same commit, when there is one;
- `release.json`: `{ version, channel, commit, date, min_from, notes }`. `min_from` is the lowest
  version that may update straight to this one. It is `0.1.0` unless a migration needs an
  intermediate release, and then `vyre update` names the release to step through;
- `SHA256SUMS` over every asset above.

Until the repo variable `VYRE_RELEASES` is `go`, every run of the workflow is a dry run: it uploads
the assets as a workflow artifact and publishes nothing.

Integrity: until phase 5, `vyre update` checks every file against `SHA256SUMS` fetched over TLS
from the GitHub Release. The workflow attaches GitHub build provenance attestations from the first
release (no key and no secret); phase 5 makes `vyre update` verify them. Phase 5 adds keyless signing first: GitHub artifact attestations or
sigstore through the release workflow's OIDC identity, verified by `vyre update` with
sigstore-js, so there is no key to guard or leak. A long-lived signing key (minisign) would be a
Vyre-wide identity; it is considered only if keyless doesn't work, and only with the person's OK.

**`vyre update` on the Mac** (new, top-level):

1. Read `releases.json` for the channel (`update.channel`: `stable` or `beta`).
2. Show the changelog from the running version to the target. `--check` stops here.
3. `vyre backup` into `<home>/backups/pre-<version>/` and keep the current tarball in
   `<home>/releases/` (the last two are kept).
4. Install the new tarball after checking its sha256, restart vyred (the existing stale-daemon
   logic in `vyre up`), and wait for `/v1/health` to report the new version.
5. If health fails within the update window (the restart plus the health wait, before the
   update reports success), reinstall the previous tarball and restore the backup. Store
   migrations are forward-only, so the database comes back from the backup, not by undoing
   steps. Once an update has reported healthy, nothing restores the database automatically, so
   no data written after a healthy update is ever lost.

`vyre update --rollback` puts the previous release back by hand and keeps the current database,
with no prompt: the person typed the command (the no-nag rule). `--restore-data` also puts back
the pre-update database, which drops everything written since. Because that loses data, it says
what it would drop and asks for a typed confirm line on a terminal, or `--yes` with `--json`.

The CLI side follows polish-cli's conventions (core/cli/kit.js): `vyre update` installs, then
restarts vyred through the same path `vyre up` uses for a stale build, never a second copy of it.
`--check` prints `{ current, latest, channel }` and exits 0 when current, 1 when an update is
waiting.

**`vyre update` on the box** (box/vyre, extended): the same steps, plus it refreshes the box
files and the wrapper itself from the release, tags the running image `vyre:prev` and keeps
`src.prev` instead of deleting it, and backs up the database before the rebuild.

It also brings the phone app along, through mobile's `releases` module (no import):

1. On the host, the wrapper fetches the release's `android.json` and the APK it names
   (`android-<version>-<sha7>.apk`, unsigned) and checks both against `SHA256SUMS`.
2. It copies them into the container's releases folder (config `releases.android`, default
   `<home>/releases/android/`): the APK first, then `android.json` last and atomically (a temp name,
   then a rename). The current `android.json` is kept as `android.json.prev`.
3. It runs `vyre call releases.sign` in the container. The tool checks the unsigned file against
   the manifest's `sha256` and `size`, signs it with the owner's key from the box's own vault (v2
   and v3, no JDK), and writes `signed-<file>` beside it. It is idempotent and refuses with
   `release_mismatch` or `no_release`, which the update reports without failing the rest.

A rollback puts `android.json.prev` back; the older signed copy is still there, since signed files
are never deleted. A release without an Android build leaves the folder alone. box-deploy no longer
uploads APKs. platform owns these steps; mobile owns `releases.sign`, the routes
(`GET /v1/releases/android`) and the phone's self-update.
`vyre box update` from the Mac runs it and then offers the Mac the same version.

**Config migrations.** `config.json` gets a `configVersion` and ordered steps in `core/config`,
run at start, with the file backed up first. Store migrations stay per module.

**Auto-update.** `update.auto` is `notify` by default: vyred checks once a day (well inside the
60 s rule), emits `update.available`, and Now shows one quiet card. `install` updates at a quiet
hour when no session is running. `off` never checks. Modules added from outside update with
`vyre module update`, pinned in `modules.lock.json`, never silently.

### 5. Third-party modules

```
vyre module new <name> [--kind tool|provider|ui] [--path <dir>]
vyre module add github:user/repo[#ref] | npm:pkg[@range] | ./path
vyre module list | check <path> | test <name> | update [name]
vyre module disable <name> | enable <name> | remove <name>
```

- `new` scaffolds from `templates/module/` (the same files as the template repo): manifest,
  `index.js`, a test using `@vyre/module-sdk/testing`, README, and `jsconfig.json` for
  autocomplete. It goes to `<home>/modules/<name>` unless `--path` is given.
- `add` fetches into a staging folder, validates the manifest and `apiVersion`, and shows a
  capability summary: the tools it calls, the vault items it wants, the hosts it talks to, the
  UI slots it fills, and whether it replaces a first-party module. The person accepts it once;
  that acceptance is recorded as a grant in `modules.lock.json` with the source, version and
  integrity hash. An update that widens the capabilities asks again. `./path` installs as a
  symlink for development and reloads the module when its files change.
- Vault items go through the existing grant flow, so Touch ID appears only where it already does
  (revealing or granting a secret). Plain adding is one confirmation in the terminal, not Touch
  ID.
- Adding, enabling and replacing are person-only tools (`modules.add`, `modules.enable`,
  `modules.replace`). An agent may scaffold with `new` in a project, but it can't make code run
  in the daemon.

**The floor and the Gate still apply.** A module's calls go through the registry as
`module:<name>`: person-only tools are refused, the rules run on its input, `gate.approve` is
refused unless the person named it an approver, and `CALL_AS` stays limited to first-party modules
under `core/`. Outbound sends go through the Gate as drafts.

**Out of process, later.** In-process JavaScript can import `node:fs` or `node:child_process` and
step around ctx. So v1 is honest about it: enforcement covers everything that passes through ctx
(tools, events, vault, settings, store prefixes), and `needs.network` is a declaration, not a
wall. Adding a third-party module is trusted like installing an npm package, and `vyre module
add` says so in one line. Recorded decision: untrusted modules should run out of process. Phase 5
builds a module host: a child process under Node's permission model
(`--permission --allow-fs-read=<module dir>,<data dir>`) that speaks the ctx surface over an RPC
channel to the registry, with network limited by the host. On the box it can go further, into a
separate container. Modules added from the internet then default to the host, and `--trusted`
keeps a module in process.

### 6. Thinning the kernel

The ratchet in test/boundaries.test.js holds 26 frozen edges. Burning them down starts **after
the native-core milestone**, one small branch per step, each merged green:

1. **A `lib/tailnet`**: `core/names/tailscale.js` and `core/link/transport.js` move into a pure
   lib. This removes 7 edges (files, hooks, link, network and onboard into names; names and files
   into link) and the names/link cycle.
2. `lib/credentials` from `core/connectors/auth.js` (google, mcp): 2 edges.
3. `lib/resilience` for the reference client (cli): 1 edge. `lib/transcripts` for recall: 1 edge.
4. The ctx.call edges: cli into names, recall and voice; daemon into names (guests) and
   switchboard; onboard into names.
5. The floor (`core/harness/rules.js`) moves into the kernel as `core/floor`, since the kernel
   runs it on every call.

The boundary test learns that `lib/*` is shared pure code (ci owns the test). Whichever branch
creates `lib/` first (app-design's `lib/theme` in phase 4, or `lib/tailnet` here) adds `"lib"` to
`package.json` `files` in the same commit, and data a lib needs at run time lives beside it
(`lib/theme/tokens.json`), since `docs/design` is not in the package. What stays after
this is the kernel plus surfaces (the CLI's own vault terminal code).

### 7. Docs

- `docs/build/writing-a-module.md` becomes **Build your first module**: in about 15 minutes, a
  module with one tool, one setting, one Now card and a passing test, run with `vyre module new`
  and `vyre module test`, in the sample world (a Northwind Bakery order counter).
- `docs/build/module-api.md`: the v1 reference, generated from the schema and the types, with a
  deprecation table.
- `docs/build/extension-points.md`: the table in section 2, kept current as slots land.
- The template lives in the main repo at `templates/module/`, with a test running `vyre module
  check` and its own tests. A public `vyre-ai/module-template` repo generated from it is an
  outward-facing step: the lead asks the person when phase 3 is near.
- The docs drift found in the inventory gets fixed with the schema: SPEC's `requires` example
  names non-modules, `shows.deck` is documented but unread, `ctx.events.latestId` is undocumented,
  and the entry-file sketch imports a type that doesn't exist.

## Build plan

| Phase | What | Touches shared code? | Waits on |
|---|---|---|---|
| 0 | This ADR, the inventory, `packages/module-sdk` (schema, checker, types), docs drift fixes | no | the lead's OK |
| 1 | `apiVersion` and schema checks in the loader; `ctx.api`, `ctx.log` levels, `ctx.paths.data`, `ctx.settings`; the `settings` manifest key into native-core's registry; `watches.on` and `needs.tools` for home modules; `replaces` and disable; `vyre module new/list/check/disable/enable` | loader only (`core/modules`) | native-core's settings on main |
| 2 | Release workflow, versions from 0.1.0, `releases.json`; `vyre update` on the Mac and the box with backup, rollback, box file refresh, channels, `update.available` | box/vyre, cli | ci, box-deploy, polish-cli (verbs) |
| 3 | `vyre module add/remove/update`, `modules.lock.json` grants, `@vyre/module-sdk/testing`, `templates/module/`, Build your first module | new files | phase 1 |
| 4 | Slots: declarative settings, Now cards, renderers and slash commands; then the sandboxed iframe for custom UI. Hooks, senders, @App adapters, themes and prompt layers | Deck, harness, gate | app-design, pwa, sessions, chat |
| 5 | Out-of-process module host; keyless release signing; kernel thinning steps 1 to 5 | kernel edges | the native-core milestone |

## Decisions (the lead, 27 Sep 2026)

1. Versions start at `0.1.0`; the module API stays at 1 while Vyre is 0.x.
2. No long-lived signing key now. Phase 5 evaluates keyless signing first (attestations or
   sigstore via OIDC, verified with sigstore-js). Until then, SHA256SUMS over TLS from GitHub
   Releases.
3. Third-party UI runs only in a sandboxed iframe on its own origin. First-party UI renders inline.
4. The template is built in the repo (`templates/module/`); the public template repo waits for the
   person's OK near phase 3.
5. Automatic rollback restores the database only when health fails within the update window.
6. One hub (the person, 27 Sep 2026): every setting, session option and design token is a value in
   native-core's settings registry, read live by every surface; its file under the home is the one
   place a person hacks. Theme overrides, theme presets and prompt layers are hub values, not a
   separate path.
7. A module from outside Vyre keeps its settings inside its own rows (found here, confirmed by e2e);
   native-core adopts it before merging.

## Open questions

1. A community module list (a GitHub topic `vyre-module` first, a page on docs.vyre.run later).
2. Decided at 0.1.0: the first real tag is cut after the native-core milestone, when the lead asks
   the person. It needs `package.json` at 0.1.0 and a "## 0.1.0" CHANGELOG section cut from
   Unreleased (the release workflow's guards).
3. Decided at 0.1.0: whether CI holds a Cloudflare token, scoped only to the vyre.run Pages project
   and kept as a GitHub secret, to mirror the latest stable to vyre.run. Until then the mirror is
   a manual box-deploy step. `vyre update` reads GitHub Releases and doesn't depend on it.

## Appendix: inventory, 27 Sep 2026 (main c8fb9aae)

Works for outside authors: tools and ctx.call through the registry and floor
(`core/modules/index.js:344`), events (`:228`), vault needs and grants (`:254`), memory teaching
(`:265`), streams and routes (`:289`, `:310`), `shows.capsule` results and actions
(`local/capsule/native/Sources/Vyred/ModuleProviders.swift`), watchers (`core/watchers/runtime.js`),
colour overrides (`core/config/theme.js`), per-agent instructions (`core/agents/index.js:44`),
MCP servers through the hub.

Hard-wired, needs a repo edit: floor sets (`core/presence/index.js:22,61-84`), Gate sender types
(`core/gate/senders.js:191`), harness brief and enrich (`core/harness/index.js:52-206`), the
session runner (`core/switchboard/runner.js`), @App adapters (`local/apps/adapters/index.js:28`),
Deck routes and rail (`deck/js/app.js:25-66`), settings sections (`deck/views/settings.js:21`),
chat tool cards (`deck/chat/blocks.js:163`), Now cards (`deck/views/now.js`), CLI verbs (a folder
scan, `core/cli/index.js:24`), fonts and spacing, and prompt layers beyond agents and projects.

Loader facts: roots are the repo's `core`, `local`, `modules`, then `<home>/modules`
(`core/daemon/index.js:42`); the first name found wins and a duplicate is marked invalid
(`core/modules/index.js:178`); `config.modules.{enable,disable}` and `roles` exist (`:186`); no
`apiVersion`, no hot reload, and `shows.deck` values are declared but unread.

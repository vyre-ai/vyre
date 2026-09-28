---
title: "ADR 0039: Vyre anywhere"
summary: The server is a role the person chooses, not the OS. Solo, a Mac or Linux box as an always-on server, and a cloud server are one install with the same move-to-server flow; config.role replaces the darwin-means-local guess.
audience: builders, agents
owner: anywhere
status: draft
---

# ADR 0039: Vyre anywhere

Status: proposed, 28 Sep 2026. Supersedes the "server means a Linux box" assumption in SPEC and
in `core/config`'s `defaults()`, which picked `role` from `process.platform` alone.

## Context

User decision, 28 Sep 2026: "Vyre anywhere." Three shapes, one install:

1. **Solo** — one computer (Mac first, then Windows) runs everything. No Tailscale.
2. **Your own always-on computer as the server** — a Mac mini or a Linux box.
3. **A cloud server.**

Today `core/config/index.js` decides `role` at `defaults()` time from the OS: `darwin` gets
`"local"`, anything else gets `"box"`. Eight modules (`releases` at `core/apps`, `computers`,
`glass`, `hooks`, `names`, `network`, `onboard`, `relay`) declare `"roles": ["box"]` in their
manifest and `core/modules/index.js` loads them only when `config.role === "box"`. That made
sense while "box" meant "the Linux container the install script provisions" — there was no
other way to be a server. It stops making sense the moment a Mac can be the server too: a person
running Solo on a MacBook, or a Mac mini as an always-on server, needs those eight modules, and
today's code has no way to give them.

The role also isn't a choice today. It's inferred once, silently, from `process.platform`, and
never revisited. "Move to server" — connect a real box later, or move an existing Solo setup's
projects/memory/vault/sessions onto one — has no owner and no flow; `core/projects/move.js`
exists but only migrates a projects folder inside one box's own volumes (ADR shipped for
box-deploy's homes migration), not "this Mac was solo, now a box is the server and the Mac
becomes a device."

## Decision

### 1. Role is a person's choice, not a platform guess

`config.role` becomes one of three values, replacing `"box"` | `"local"`:

- `"server"` — this machine is the always-on server. Serves the Deck, runs watchers, owns the
  vault, the box-only modules run here.
- `"device"` — this machine is a device of a server elsewhere (another Mac, a Linux box, or a
  cloud VM). The box-only modules stay off; local-only modules (Capsule, voice, screen-mac,
  hands-mac) run here as before.
- `"solo"` — this one machine is both. Every module that needs `"server"` or `"device"` runs;
  nothing needs Tailscale because there is only one machine to reach.

`core/modules/index.js`'s loader keeps its two-bucket manifest vocabulary (`"roles": ["box"]`,
`["local"]`, `["box","local"]`) unchanged — forty-plus manifests across every team's modules
already speak it, and this ADR's job is the smallest change through that contract, not a
repo-wide rename. The loader maps the new config values onto the old buckets:

| config.role | loads `"box"` modules | loads `"local"` modules |
|---|---|---|
| `server` | yes | no |
| `device` | no | yes |
| `solo` | yes | yes |

`computers` and `glass` (already `"roles": ["box"]`) stay additionally gated on Docker being
present, unchanged from today — a Mac server with no Docker still runs `onboard`, `names`,
`network`, `hooks`, `relay`, `releases`, just not agent computers or Glass.

Nothing in this ADR asks any other team to rename a manifest field. "Server" and "device" are
the words the person and the UI use; "box" and "local" stay the words the module loader and
forty manifests use internally. `docs/GLOSSARY.md` (owned by docs, ADR 0038) gets the mapping so
new copy uses the right word without archaeology.

### 2. Migration for existing installs

An existing `config.json` has `role: "box"` or `role: "local"` (or nothing, defaulting by OS).
`core/config/load()` migrates on read:

- `"box"` → `"server"`
- `"local"` → `"device"`
- missing, on a machine with no other device ever paired (no `relay` device, no `names`
  tailnet peer recorded) → `"solo"`, not `"server"` — a fresh single-Mac install that never
  chose anything is Solo, matching what it actually does today (no Tailscale needed, no second
  device exists).
- missing, on a box that already has a paired device or a tailnet peer → `"server"` (it's
  already acting as one).

The migrated value is written back once (`problems` notes it happened), so `load()` is
idempotent and a person who explicitly sets `"box"` or `"local"` by hand still gets migrated
rather than rejected — old values are read-compatible, never round-tripped.

### 3. The Mac as a server: a real service, not a session

A Mac chosen as `"server"` or `"solo"` needs vyred to survive logout, sleep and reboot the way
the box's container does. `vyre server here` (new CLI, `core/onboard` or a small new
`core/anywhere` — see Build plan) does on a Mac what the install script does on Linux:

1. Sets `config.role` to `"server"` (or `"solo"` if no device will ever join — the person is
   asked, matching the capability ladder in `docs/design/anywhere.md`).
2. Installs a `launchd` `LaunchAgent` (`com.vyre.vyred.plist`, `RunAtLoad` + `KeepAlive`) so
   vyred restarts after a crash and after every login, and a caffeinate-backed keep-awake
   (`pmset` assertion, not preventing display sleep — only idle system sleep) so the Mac stays
   reachable without the person's screen staying lit. Neither survives a reboot with FileVault
   requiring a login before disk unlock without the person's own login item, which the command
   also adds if the person agrees (`osascript` System Events login item, not a LaunchDaemon —
   LaunchDaemons can't reach an unencrypted-at-that-point-yet home volume before FileVault
   unlock anyway).
3. Refuses on a Mac already `"device"` of a running server without `--force`, and warns if
   Energy Saver / Battery settings will let the Mac sleep regardless (best-effort detection
   only; this ADR does not open System Settings for the person).

Undo: `vyre server here --undo` removes the LaunchAgent and login item and leaves `config.role`
alone (a person moving off Mac-as-server chooses the new role through the move flow, not this
command).

### 4. Move-to-server is one flow, used twice

The same flow serves onboarding's "I already have a server, connect it" and a later "move my
Solo setup to a server":

1. **Point at a server.** The person names an existing server (its Tailscale name, or pastes a
   setup code an already-running server shows) or picks "make this Mac the server" (step 3
   above) or "spin up a cloud server" (out of scope here — tailnet/launch own the join UI).
2. **federation's move engine** copies what moves: projects, memory (facts, transcripts index),
   vault (re-wrapped to the destination's device key, never the plaintext secrets themselves in
   transit unencrypted), and sessions (the Claude Code sign-in and any in-flight Vyre-owned
   session state) from the source to the destination. The source stays untouched and running
   until the destination confirms every piece landed and re-decrypts.
3. **The source becomes a device.** Once confirmed, the source's `config.role` flips to
   `"device"` (or is left `"solo"` a moment longer if the person is only testing — nothing
   forces the flip until they confirm in the UI). Box-only modules on the source stop on the
   next `vyred` restart; local-only ones keep running.
4. **Nothing is deleted on the source until the person says so.** The moved copy on the source
   sits under `~/.vyre/moved-<date>/` (mirroring `core/projects/move.js`'s `MOVED_RECORD`
   pattern) until an explicit `vyre server forget` or the next full move.

Failure and undo:

- A move that fails partway (network drop, destination out of disk) leaves the source as
  `"server"` still, fully working — the flip in step 3 only happens after the destination
  confirms, so a failed move is a no-op from the person's side, just a retry.
- `vyre server forget` cannot run until the destination has been reachable and current for at
  least 24 hours (avoids the person orphaning their only copy right after a shaky first move).
- The Deck's Settings > Server panel (launch owns the UI, this ADR owns what it calls) shows the
  move's live progress, and a red state if the source and destination ever disagree on which one
  is authoritative — never silently.

### 5. Where this plugs in

- **Onboarding** (launch): the "how will Vyre run" step becomes the role choice from section 1,
  not a Tailscale prompt. "I have a server, connect it" reuses the move flow, pointed at step 1.
- **Settings** (launch, native-core): a Server panel — today's role, a "Move to server" or
  "Move off this server" action, and (on a Mac server) the `launchd`/keep-awake status from
  section 3.
- **Windows** (windows team): Solo on Windows needs an equivalent to section 3 (a Windows
  service instead of `launchd`) and its own module-loading story where `"local"`-only modules
  assume macOS today (`local/screen-mac`, `local/hands-mac`) — out of scope for this ADR beyond
  naming the seam: `core/modules/index.js`'s role mapping doesn't care what OS `"device"` or
  `"solo"` runs on, only the `local/*` modules do.

## Build plan

1. `core/config`: the three-value role, the migration in `load()`, `core/modules/index.js`'s
   mapping table, tests. (anywhere)
2. The eight modules' manifests stay `"roles": ["box"]` unchanged; verify each one actually
   starts clean on macOS (some assume a Linux path or a container network today — audit before
   claiming "runs on macOS"). (anywhere)
3. `vyre server here` / `--undo`, the `launchd` plist, keep-awake. (anywhere)
4. The move engine. (federation, this ADR names the contract in section 4)
5. Tailscale/relay wiring on join. (tailnet)
6. Onboarding and Settings UI. (launch)
7. Windows Solo. (windows)

## Open questions

- Does `"solo"` ever need `network.tailscale` on (a Solo person who later wants their phone to
  reach the same Mac without a full move)? Leaning yes, tailnet's call.
- `releases` (Android APK signing) needs the owner's signing key in the vault; on a Mac server
  with no Docker, does APK CI still reach it over the tailnet the same way? Needs a check against
  `core/apps/releases.js`'s assumptions, not just the manifest gate.

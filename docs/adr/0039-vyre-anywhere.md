---
title: "ADR 0039: Vyre anywhere"
summary: The server is a role the person chooses, not the OS. Solo, a Mac or Linux box as an always-on server, and a cloud server are one install with the same move-to-server flow; config.machine replaces the darwin-means-local guess.
audience: builders, agents
owner: anywhere
status: draft
---

# ADR 0039: Vyre anywhere

Status: proposed, 28 Sep 2026. Supersedes the "server means a Linux box" assumption in SPEC and
in `core/config`'s `defaults()`, which picked `role` from `process.platform` alone.

## Context

User decision, 28 Sep 2026: "Vyre anywhere." Three shapes, one install:

1. **Solo**: one computer (Mac first, then Windows) runs everything. No Tailscale.
2. **Your own always-on computer as the server**: a Mac mini or a Linux box.
3. **A cloud server.**

Today `core/config/index.js` decides `role` at `defaults()` time from the OS: `darwin` gets
`"local"`, anything else gets `"box"`. Eight modules (`releases` at `core/apps`, `computers`,
`glass`, `hooks`, `names`, `network`, `onboard`, `relay`) declare `"roles": ["box"]` in their
manifest and `core/modules/index.js` loads them only when `config.role === "box"`. That made
sense while "box" meant "the Linux container the install script provisions": there was no
other way to be a server. It stops making sense the moment a Mac can be the server too: a person
running Solo on a MacBook, or a Mac mini as an always-on server, needs those eight modules, and
today's code has no way to give them.

The role also isn't a choice today. It's inferred once, silently, from `process.platform`, and
never revisited. "Move to server": connect a real box later, or move an existing Solo setup's
projects/memory/vault/sessions onto one: has no owner and no flow; `core/projects/move.js`
exists but only migrates a projects folder inside one box's own volumes (ADR shipped for
box-deploy's homes migration), not "this Mac was solo, now a box is the server and the Mac
becomes a device."

## Decision

### 1. The choice is a new field, `config.machine`, not a rewrite of `config.role`

A first pass tried replacing `config.role`'s two values with three (`"solo"|"server"|"device"`).
That breaks on contact: about fifteen files outside this ADR's ownership: `core/planner`,
`core/term`, `core/projects`, `core/statusline`, `core/link`, `core/files` (and `drop.js`,
`drive.js`), `core/vault/watch.js`, `core/sessions/config.js`, `core/modules/federate.js`, and
several `core/cli/commands/*` (`link`, `assistant`, `up`, `phone`, `doctor`): read
`ctx.config.role === "box"` or `"local"` directly, not through a contract, because `core/config`
is the kernel and every part is allowed to import it. Renaming the value space silently breaks
every one of them; rewriting all fifteen unreviewed, in one pass, owned by other teams, is
exactly the repo-wide change this ADR is supposed to avoid.

Instead: `config.role` keeps its old two values and its old OS-guessed default, untouched.
`config.machine` is a new, additive field: the person's actual choice:

- `"server"`: this machine is the always-on server. Serves the Deck, runs watchers, owns the
  vault, the box-only modules run here.
- `"device"`: this machine is a device of a server elsewhere (another Mac, a Linux box, or a
  cloud VM). The box-only modules stay off; local-only modules (Capsule, voice, screen-mac,
  hands-mac) run here as before.
- `"solo"`: this one machine is both, but is a server to no one until the person says so. It
  runs the full local core and none of the eight box-only modules; nothing needs Tailscale
  because there is no second machine yet. **Fixed 28 Sep after reviewer's HOLD on 80fd866e:** a
  first pass made solo both `isServer` and `isDevice`, which put the tailnet listener, public
  webhooks, the relay and the owner-claim flow on every existing Mac by default, with no choice
  made. `isServer("solo")` is now `false`; only `"server"` is a server. Solo becomes one only by
  running `vyre server here` or pairing a second device (section 5).

`defaults()` computes `machine` the same way `role` always was (`darwin` → `"solo"`, else →
`"server"`), so a fresh install's behavior doesn't change until the person actually chooses
otherwise (onboarding, `vyre server here`, or pairing a second device). An old config.json with
an explicit `role` but no `machine` migrates once: `role: "box"` implies `machine: "server"`
(someone who set that by hand meant a real server); `role: "local"` implies `machine: "solo"`.

`core/modules/index.js`'s loader keeps its two-bucket manifest vocabulary (`"roles": ["box"]`,
`["local"]`, `["box","local"]`) unchanged: forty-plus manifests across every team's modules
already speak it: and now reads `config.machine`, not `config.role`, to decide which buckets
are active (`roleBuckets()`):

| config.machine | loads `"box"` modules | loads `"local"` modules |
|---|---|---|
| `server` | yes | yes on darwin, no on Linux (team-lead, 28 Sep: a Mac chosen as the server is still, often, someone's own desk -- Capsule, voice and the rest of the local core stay; a Linux box never had them anyway) |
| `device` | no | yes |
| `solo` | no | yes |

Two new kernel helpers, `config.isServer(machine)` and `config.isDevice(machine)`, also accept
the legacy `role` strings `"box"`/`"local"` as aliases, so a caller that hasn't moved to
`machine` yet (a test, or one of the fifteen files above, if it later needs the third state)
gets the right answer either way. `core/daemon/index.js` now builds the module registry and
`Presence` with `cfg.machine`; the three places that gated real behavior on "is this the server"
rather than a form-following-function `role` value: `core/presence/index.js`,
`core/presence/module.js`, `core/onboard/index.js`: were moved from `role === "box"` to
`isServer(machine)` because their behavior (restricting code-based passkey enrollment to the
owner's tailnet device; the "is this the box" branch in onboard's session catalogue) is exactly
the server/not-server distinction ADR 0039 exists to make explicit, not an OS artifact.

The other fifteen files' `role`-based branches (file roots, term roots, statusline wording,
vault sleep/lock detection, link's box-vs-Mac protocol, CLI command framing) stay exactly as
they are. Most of them encode a real, per-consumer decision about what "solo" should look like
that this ADR does not make unilaterally for every owner: e.g. should a Solo Mac's `core/term`
default to `/work`-style roots or the home directory? That is a question for `core/term`'s
owner, informed by this ADR, not a string swap. Each such file keeps working today and gets its
own `machine`-aware pass, owner by owner, tracked under "Next" in team/archive/work-journals/anywhere.md: this
ADR unblocks that work without forcing it into one unreviewed commit.

`computers` and `glass` (already `"roles": ["box"]`) stay additionally gated on Docker being
present, unchanged from today: a Mac server with no Docker still runs `onboard`, `names`,
`network`, `hooks`, `relay`, `releases`, just not agent computers or Glass.

Nothing in this ADR asks any other team to rename a manifest field. "Server" and "device" are
the words the person and the UI use; "box" and "local" stay the words the module loader and
forty manifests use internally. `docs/GLOSSARY.md` (owned by docs, ADR 0038) gets the mapping so
new copy uses the right word without archaeology.

### 2. Migration for existing installs

`config.machine` is new, so there's nothing to migrate away from: only a value to infer for an
existing `config.json` that has no `machine` key yet, per section 1: `defaults()` gives it the
same OS guess `role` always used (`darwin` → `"solo"`, else → `"server"`), unless the person
already made an explicit choice by hand (`role: "box"` or `role: "local"` in the file, with no
`machine`), in which case that choice wins: `"box"` → `"server"`, `"local"` → `"solo"`: over
the OS guess, since setting `role` by hand said more than the platform does. Nothing is written
back to disk by this inference; `load()` computes it fresh every time, same as it always has for
`role`, and only `core/config/save()` (onboarding, `vyre server here`, the move flow) persists a
real choice.

### 3. The Mac as a server: a real service, not a session

**Superseded in its mechanics by ADR 0040 (drafted 28 Sep with e2e), kept here for the
capability it still names.** The section below assumed vyred itself (the person-side daemon,
sharing the person's uid) could be made to survive logout, sleep and reboot directly. ADR 0040's
trusted-root split changes who runs what: `vyre-core`, a root-owned process the person's own uid
cannot write to, is what must survive logout/reboot and hold anything privileged; person-side
vyred stays a thin, forgeable client. `vyre server here`'s actual install mechanics (the admin
password, the LaunchDaemon, the signed-update story) now live in ADR 0040. What stays true here:
a Mac chosen as `"server"` or `"solo"` still needs *something* always-on and reachable, machine
still flips to `"server"`, and Solo's own path is unaffected until it becomes a server.

A Mac chosen as `"server"` or `"solo"` needs something on it to survive logout, sleep and reboot
the way the box's container does. `vyre server here` (new CLI) does on a Mac what the install
script does on Linux, built out fully in ADR 0040:

1. Sets `config.machine` to `"server"` (or `"solo"` if no device will ever join: the person is
   asked, matching the capability ladder in `docs/design/anywhere.md`).
2. Installs a `launchd` `LaunchAgent` (`com.vyre.vyred.plist`, `RunAtLoad` + `KeepAlive`) so
   vyred restarts after a crash and after every login, and a caffeinate-backed keep-awake
   (`pmset` assertion, not preventing display sleep: only idle system sleep) so the Mac stays
   reachable without the person's screen staying lit. Neither survives a reboot with FileVault
   requiring a login before disk unlock without the person's own login item, which the command
   also adds if the person agrees. This is a LaunchAgent, not a LaunchDaemon: a LaunchDaemon
   can't reach an unencrypted-at-that-point-yet home volume before FileVault unlock anyway.
3. Refuses on a Mac already `"device"` of a running server without `--force`, and warns if
   Energy Saver / Battery settings will let the Mac sleep regardless (best-effort detection
   only; this ADR does not open System Settings for the person).

Undo: `vyre server here --undo` removes the LaunchAgent and login item and leaves `config.machine`
alone (a person moving off Mac-as-server chooses the new machine through the move flow, not this
command).

### 4. Move-to-server is one flow, used twice

The same flow serves onboarding's "I already have a server, connect it" and a later "move my
Solo setup to a server":

1. **Point at a server.** The person names an existing server (its Tailscale name, or pastes a
   setup code an already-running server shows) or picks "make this Mac the server" (step 3
   above) or "spin up a cloud server" (out of scope here: tailnet/launch own the join UI).
2. **federation's move engine** copies what moves: projects, memory (facts, transcripts index),
   vault (re-wrapped to the destination's device key, never the plaintext secrets themselves in
   transit unencrypted), and sessions (the Claude Code sign-in and any in-flight Vyre-owned
   session state) from the source to the destination. The source stays untouched and running
   until the destination confirms every piece landed and re-decrypts.
3. **The source becomes a device.** Once confirmed, the source's `config.machine` flips to
   `"device"` (or is left `"solo"` a moment longer if the person is only testing: nothing
   forces the flip until they confirm in the UI). Box-only modules on the source stop on the
   next `vyred` restart; local-only ones keep running.
4. **Nothing is ever deleted on the source automatically** (user rule, 28 Sep: nothing that came
   from a device is deleted without the person's explicit, previewed confirmation). The moved
   copy on the source sits under `~/.vyre/moved-<date>/` (mirroring `core/projects/move.js`'s
   `MOVED_RECORD` pattern) indefinitely. Settings > Server offers "Free up space on this
   laptop", previewing exactly what would go (counts, by piece: projects, memory, vault,
   sessions) before the person confirms; there is no automatic or timed cleanup.

Failure and undo:

- A move that fails partway (network drop, destination out of disk) leaves the source as
  `"server"` still, fully working: the flip in step 3 only happens after the destination
  confirms, so a failed move is a no-op from the person's side, just a retry.
- "Free up space on this laptop" is available as soon as the destination is confirmed current,
  but never runs itself: the person previews and confirms every time, no matter how long it's
  been.
- The Deck's Settings > Server panel (launch owns the UI, this ADR owns what it calls) shows the
  move's live progress, and a red state if the source and destination ever disagree on which one
  is authoritative: never silently.

### 5. Solo plus a phone needs no move

Pairing a second device to a Solo machine (Tailscale, or the relay's QR pairing) is the capability
ladder's rung 2, not a move: nothing relocates, because the Solo machine's own data is already
where it should end up. On the first device to successfully pair, `config.machine` on that
one machine flips from `"solo"` to `"server"` (still the same files, same vault, same
`vyred`); the new device is simply `"device"`. Tailscale or the relay turns on right then, not
before: a Solo person who never pairs anything never sees either. tailnet's `onboard.join` tool
(agreed 28 Sep, see team/archive/work-journals/anywhere.md) is exactly this trigger: its `verify` step, once a
device is confirmed reachable, is what flips the source's `machine`. `federation`'s move engine
(section 4) is not called: there is nothing to copy.

### 6. Where this plugs in

- **Onboarding** (launch): the "how will Vyre run" step becomes the role choice from section 1
  (three cards: Solo, another computer, a cloud server), not a Tailscale prompt. "I have a
  server, connect it" reuses the move flow, pointed at step 1. Solo needs no call at all until a
  device later joins (section 5).
- **Settings** (launch, native-core): a Server panel: today's role, "Move to server"/"Move off
  this server" (section 4), "Free up space on this laptop" (section 4's cleanup, always
  previewed, never automatic), and (on a Mac server) the `launchd`/keep-awake status from
  section 3.
- **Windows** (windows team): Solo on Windows needs an equivalent to section 3 (a Windows
  service instead of `launchd`) and its own module-loading story where `"local"`-only modules
  assume macOS today (`local/screen-mac`, `local/hands-mac`): out of scope for this ADR beyond
  naming the seam: `core/modules/index.js`'s `roleBuckets()` doesn't care what OS `"device"` or
  `"solo"` runs on, only the `local/*` modules do.

## Build plan

1. `core/config`: `config.machine`, the migration in `load()`, `core/modules/index.js`'s
   `roleBuckets()` mapping, tests -- shipped, sha 80fd866e. (anywhere)
2. The eight modules' manifests stay `"roles": ["box"]` unchanged; verify each one actually
   starts clean on macOS (some assume a Linux path or a container network today: audit before
   claiming "runs on macOS"). (anywhere)
3. `vyre server here` / `--undo`, the `launchd` plist, keep-awake. (anywhere)
4. The move engine. (federation, this ADR names the contract in section 4)
5. Tailscale/relay wiring on join. (tailnet)
6. Onboarding and Settings UI. (launch)
7. Windows Solo. (windows)

## Open questions

- Resolved 28 Sep (team-lead): Solo plus a phone is section 5, not a move: Tailscale/relay turn
  on only once a device actually joins, never before.
- `releases` (Android APK signing) needs the owner's signing key in the vault; on a Mac server
  with no Docker, does APK CI still reach it over the tailnet the same way? Needs a check against
  `core/apps/releases.js`'s assumptions, not just the manifest gate.

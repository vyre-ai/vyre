---
title: Boundaries
summary: Which parts of Vyre may import which, the frozen exceptions test/boundaries.test.js allows, and what each one should become.
audience: builders
owner: ci
status: stable
---

# Boundaries

Each part of Vyre is independently modular. A part talks to another part only through the
registry (`ctx.call`, tools) and events. It never imports another part's files. A part can be
switched off without breaking the rest.

- **The kernel** is `core/config`, `core/store`, `core/events`, `core/modules`, `core/presence`
  and `core/daemon`. Any part may import it.
- **A part** is `core/<name>` (a folder, or a single file such as `core/quiet.js`),
  `local/<name>` or `modules/<name>`.
- **A lib** is `lib/<name>`: shared pure code with no feature state (ADR 0033). Any part may
  import a lib. A lib imports only the kernel and other libs, never a feature, and no lib edge
  can be frozen.

`test/boundaries.test.js` scans every runtime `.js`, `.mjs` and `.cjs` file under `core/`,
`local/`, `modules/` and `lib/` for relative imports (static, dynamic and `require`). Tests,
`testing/` folders and fixtures are out of scope, since a test may reach into what it tests. The
test fails on:

- an import into another part that is not in its allowlist, or a new file behind a frozen edge;
- an allowlist entry that nothing imports any more (the list only shrinks);
- an allowlist edge missing from this page.

A new exception needs the lead's OK.

## The frozen exceptions

Frozen from main on 27 September 2026: 26 edges, 24 now (connectors moved its shared credential,
mail-message and on_behalf helpers into `lib/connectors` on 2026-09-28, which removed
`core/google -> core/connectors` and `core/mcp -> core/connectors` entirely rather than freezing
their wider imports). "Becomes" says where each remaining one should go:

- **ctx.call**: call a tool through the registry instead.
- **lib**: the imported file is a pure helper; move it to `lib/<name>`.
- **surface**: the CLI is a surface, and keeps its command-side helpers.

| Edge | Files | Why | Becomes |
|---|---|---|---|
| `core/cli -> core/names` | backup.js, system.js | `vyre backup` and `vyre up` write the box backup and the systemd unit in-process | ctx.call |
| `core/cli -> core/recall` | embed.js, progress.js | `vyre status` and `vyre doctor` read index progress and the embedder's state directly | ctx.call |
| `core/cli -> core/resilience` | backoff.js, node.js, stream.js | the reference client every surface uses, a pure library | lib |
| `core/cli -> core/vault` | backup.js, cli-io.js, refs.js | `vyre vault`'s terminal side: no-echo prompts, `vault://` refs, the sealed backup format | surface |
| `core/cli -> local/voice` | talk.js | `vyre voice`, push-to-talk from a terminal until the native Lumen has voice | ctx.call |
| `core/daemon -> core/harness` | rules.js | the kernel runs the security floor on every call's input; the floor belongs in the kernel | lib |
| `core/daemon -> core/names` | guests.js | the router asks whether a tailnet caller is a guest before the registry | ctx.call |
| `core/daemon -> core/runner` | homesandbox.js, sandbox.js, lent-home.js | the daemon composes the runner's home sandbox for the Switchboard (core/sessions cannot import core/runner) | lib |
| `core/daemon -> core/spawner` | client.js, confine.js | a session in the packaged box is confined by its own uid, and the daemon composes the self-test that proves it before every start; it asks the root spawner, which is not a module | lib |
| `core/daemon -> core/switchboard` | sessions.js | the router resolves which Claude Code session a call comes from | ctx.call |
| `core/daemon -> core/wink` | node/peer-wire.js | the daemon composes the home's peer door for a paired device's relay stream (core/daemon/peer-door.js) | lib |
| `core/files -> core/link` | transport.js | Mac to box file transfer over the tailnet transport | lib |
| `core/files -> core/names` | tailscale.js | runs the tailscale CLI (Taildrive) | lib |
| `core/hooks -> core/names` | tailscale.js | runs the tailscale CLI | lib |
| `core/link -> core/names` | tailscale.js | finds the box on the tailnet | lib |
| `core/names -> core/link` | transport.js | names and link import each other; the transport belongs in a lib both use | lib |
| `core/network -> core/names` | guests.js, identity.js, tailscale.js | the listeners identify tailnet peers (ADR 0002) | lib |
| `core/onboard -> core/names` | service.js, tailscale.js | onboarding reserves the name and starts the tailnet listener in-process | ctx.call |
| `core/recall -> core/transcripts` | index.js | transcripts is the one reader of Claude Code's files | lib |
| `core/watchers -> core/spawner` | client.js | the box's watcher wall is the root spawner's; loaded only when a spawner socket exists | lib |
| `core/sessions -> core/spawner` | client.js | sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0 | ctx.call |
| `core/sessions -> core/switchboard` | runner.js | sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0 | ctx.call |
| `core/sessions -> core/transcripts` | sanitize.js | sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0 | ctx.call |
| `core/switchboard -> core/harness` | rules.js | sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0 | ctx.call |
| `core/switchboard -> core/sessions` | config.js, providers.js, sdk.js, spawn.js | sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0 | ctx.call |
| `core/switchboard -> core/transcripts` | sanitize.js | keeps credentials out of what it builds from transcripts | lib |
| `core/term -> core/files` | safety.js | the path gate every file path passes through | ctx.call |
| `core/vyre-core -> core/vault` | vault.js | vyre-core hosts the vault's store and crypto in its own process and db (ADR 0040 phase 2) | host |
| `core/vault -> core/link` | transport.js | the vault relay between the Mac and the box | lib |
| `core/vault -> core/names` | identity.js, tailscale.js | who is on the other end of a vault relay, and the tailscale CLI | lib |
| `local/capsule -> core/cli` | commands/capsule-native.js | where the native Lumen app is built, shared with `vyre capsule` | lib |
| `local/hands-mac -> local/screen-mac` | floor.js | the floor for Vyre's hands and eyes on the Mac (SPEC section 11) | lib |
| `local/sideview -> local/screen-mac` | floor.js, runner.js | drives the sight helper and its floor directly | ctx.call |

## What the list says

Two files carry most of the rest. `core/names/tailscale.js` (6 edges) and
`core/link/transport.js` (3) are shared plumbing, not features: the first move is a small tailnet
lib beside the kernel that both names and link use, which also ends the `names` and `link` cycle.
The ctx.call cases (8) are places where a part reaches into another's state and should ask its
tools instead. `lib/connectors` (auth.js, message.js, behalf.js) is the same move already done for
the connectors' own shared helpers.

## First cleanup: a tailnet lib

Scheduled after the native-core milestone. `core/names/tailscale.js` and
`core/link/transport.js` move into one small tailnet lib beside the kernel, with no feature state.
That removes about 10 edges from the list above and ends the `names` and `link` cycle.

# ADR 0021 · The box reads the paired Mac through the link

Status: accepted, 27 Sep 2026 · Workstream: federation · Amends ADR 0002 (the link) and carries
out ADR 0008 step 3

## Context

ADR 0008 step 3 says the Mac's sessions stay on the Mac and "the box reaches them through the
link". Nothing built that. The link ran one way only: the Mac calls the box's tools
(`ctx.remote`, `link.call`) and follows its events. The Mac has no listener, so the box had no way
to ask it anything, and a new box showed "0 sessions" to a person whose whole history is on the Mac.

## Decision

1. **A reverse channel over the Mac's own connection.** While paired, the Mac holds one request to
   the box's `link.serve { key }`. The box answers with the next question for that Mac, or `null`
   after 60 s. The Mac runs the question and answers with `link.reply { key, id, result }`, then
   asks again. Both tools check the pairing key and the Mac's pinned node, as `link.hello` does.
   No port opens on the Mac, so there is no firewall prompt and nothing new to reach from the
   tailnet. When a call to the box fails the loop stops, and the next call that reaches the box
   (the minute's heartbeat at the latest) starts it again, so an absent box costs nothing extra.
2. **An allowlist at both ends.** Only `projects.catalog`, `projects.list`, `recall.search`,
   `recall.sessions`, `recall.thread` and `threads.list` cross (`core/link/allow.js`). The box
   refuses anything else before queueing it, and the Mac refuses it again before running. The Mac
   runs them as `module:link`. `link.macs.call` is internal (modules only), and `link.macs` lists
   the paired Macs with `online`, for surfaces.
3. **Federation through each module's contract.** The six read tools on the box take
   `machines: "all"|"local"` and merge the Macs' rows, labelled `source` ("box" or "mac") and
   `machine`, with `sources` saying which machines answered. They federate only for the person
   (the Deck, the terminal, the Capsule, the owner over the tailnet) or a module that passes
   `machines: "all"`; agents, MCP and guests get the box's rows alone. On a Mac nothing federates,
   so the Mac never asks the box back. There is no `link.federate` tool: each module owns its merge.
4. **No transcript on the box.** Only `recall.thread` carries turns, and only when a surface opens
   a session the box does not have. Nothing a Mac answers is written to the box's store.
5. **Offline is an answer, not a wait.** A Mac that is not polling answers `mac_offline` at once,
   and the box returns its own rows. The Deck shows an offline chip read from `link.macs`, never by
   asking the Mac.

## Known limits (accepted for v1)

- The Mac answers one question at a time, so a busy Mac can delay a read by up to the link's 5 s
  timeout. The box's own rows never wait on it.
- A Mac that drops off while holding its request looks online for up to the 60 s hold. A read in
  that window answers `timeout`, not `mac_offline`.
- Mac threads are read-only on the box in this version. Sending to one through the same channel
  is the next step.

## Consequences

- A paired Mac keeps one held request open to the box: one request a minute while idle.
- The box's reads can take up to 5 s longer when a Mac is slow, never longer.
- Onboarding's history step counts the Mac's sessions, held for 30 s and keyed on the Macs'
  online state, so its 2 s poll asks the Mac at most twice a minute.

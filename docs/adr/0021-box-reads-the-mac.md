---
title: ADR 0021: The box reads the paired Mac through the link
summary: How the box reads the paired Mac's sessions through the link, and the limits of the first version.
audience: builders
owner: docs
status: stable
---

# ADR 0021: The box reads the paired Mac through the link

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
- Sending to a Mac thread is the one write (below). Answering its permission questions, taking
  or releasing its keyboard, starting or stopping it from the box are not in this version.

## Sending to a Mac session

Added 27 Sep 2026, so the person can message the Mac's Claude Code sessions from the Deck and the
phone.

1. **The rule.** `threads.send` on the box, for a thread the box does not have (not running,
   not recorded, no transcript it could adopt), goes to the paired Macs when the caller is the
   person: the Deck, the terminal, the Capsule, or the owner over the tailnet (`wantsMacs` in
   `core/modules/federate.js`, with no `machines` input, so a module never qualifies). An
   optional `machine` input names one Mac. The Mac's answer comes back unchanged, plus
   `source: "mac"` and `machine`. Agents, MCP, guests and modules get the box's own answer
   (`no thread <id>`), and the Mac never sees their call. A thread the box has is the box's.
2. **One write at both ends.** `WRITE` in `core/link/allow.js` holds only `threads.send`. The box
   queues it only when `link.macs.call` is given `as: "person"`, and the request carries `as` to
   the Mac; the Mac runs a write only when the request says `as: "person"`. Writes wait 15 s,
   since a send that resumes a stopped session headless takes a moment.
3. **The Mac runs it as the person's.** The Mac calls `threads.send` as the caller `link:box`
   (a label only core modules can use, and only the ones the registry's fixed `CALL_AS` map
   gives them; no manifest can grant it), so the switchboard's `queuesFor` treats it
   as a person: a session busy in a terminal gets the words queued and handed over at its next
   Stop, exactly as for the person on the Mac. Its `surface` is `box:<surface>` (`box:deck`), so
   the Mac's lease and inbox rows show the words came from the box.
4. **The events come back.** After a send that did not fail, the Mac follows that thread's
   `thread.queued`, `thread.sent`, `thread.text`, `thread.finished`, `thread.stopped`,
   `thread.contended` and `thread.limit`, and sends them to the box's `link.events` in batches, at
   most every 250 ms while they flow. Events that arrive while the send runs are held and sent
   only if it succeeds. The box takes them only for a thread it sent to in the last 30 minutes,
   only from the Mac it sent to, and re-emits each with `source: "mac"` and `machine` added to
   the payload, the thread id in the envelope and no project (the Mac's slugs are not the box's).
   One that looks like a secret is dropped alone.
5. **The follow ends** at the thread's `thread.finished` or `thread.stopped`, 30 minutes after
   the last send, on unpair, on revoke and when vyred stops. Queued words: a `thread.queued` adds
   its id to the follow's waiting set, and the `thread.sent { queued }` that hands it over removes
   it. A `thread.finished` while any is still waiting is another turn ending, not this answer, so
   the follow goes on. Each send starts or extends the follow. No listener or timer runs while
   nothing is followed. A batch the box does not take is dropped, never retried: the Deck can
   read the thread again with `recall.thread`.
6. **Not forwarded in v1:** `threads.answer` (permission questions are answered on the Mac),
   `threads.lease` and `threads.release` (the box cannot hold a Mac's lease; the send takes the
   Mac's lease for `box:<surface>` as any send does), and every other thread tool.
7. **Offline is an answer.** A Mac that is not polling makes `threads.send` fail at once with
   `mac_offline`, "<name> is offline; your message was not sent". Nothing is queued on either
   machine: the box does not keep words for a Mac that is away.

**Trust.** The Mac trusts its paired box's `as: "person"`, because on the box only the
switchboard's person rule produces it, and `link.macs.call` is internal (modules only). A box
that was taken over could claim it; what it gains is typing into the Mac's sessions as the owner
would from the Deck, the same reach the owner's Deck already has. It still cannot answer a
permission question, run any other write, or read beyond the allowlist, because the Mac checks
those itself.

## Consequences

- A paired Mac keeps one held request open to the box: one request a minute while idle.
- A send to a Mac thread costs the Mac at most four link.events calls a second while its answer
  streams, and nothing once it has finished.
- The box's reads can take up to 5 s longer when a Mac is slow, never longer.
- Onboarding's history step counts the Mac's sessions, held for 30 s and keyed on the Macs'
  online state, so its 2 s poll asks the Mac at most twice a minute.

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
- Sending to a Mac thread and answering its asks are the two writes (below). Taking or releasing
  its keyboard, starting or stopping it from the box are not in this version.

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
4a. **The box never takes a Mac session's keyboard** (decided with capsule-now, 27 Sep 2026).
   While any surface on the Mac holds the lease (a terminal, the Capsule, the Mac's Deck), the
   words are queued, and the answer's `busy` is `"terminal"` or the holder. A free session is
   typed into as before and its lease goes to `box:<surface>`. The Mac's caller `link:box` is a
   caller kind of its own in the switchboard (`fromLink`): it queues, is never an agent, and its
   surface is always `box:<surface>`. The box's note names the Mac: "<name> is busy in your
   terminal on <mac>. I'll hand it your message when this turn ends."
5. **The follow ends** at the thread's `thread.finished` or `thread.stopped`, 30 minutes after
   the last send, on unpair, on revoke and when vyred stops. Queued words: a `thread.queued` adds
   its id to the follow's waiting set, and the `thread.sent { queued }` that hands it over removes
   it. A `thread.finished` while any is still waiting is another turn ending, not this answer, so
   the follow goes on. Each send starts or extends the follow. No listener or timer runs while
   nothing is followed. A batch the box does not take is dropped, never retried: the Deck can
   read the thread again with `recall.thread`.
6. **Not forwarded in v1:** `threads.answer` (answered on the Mac in v1, the Deck saying "Answer
   it on <mac>"; forwarded since v2, below),
   `threads.lease` and `threads.release` (the box cannot hold a Mac's lease; the send takes the
   Mac's lease for `box:<surface>` as any send does), and every other thread tool.
7. **Offline is an answer.** A Mac that is not polling makes `threads.send` fail at once with
   `mac_offline`, "<name> is offline; your message was not sent". Nothing is queued on either
   machine: the box does not keep words for a Mac that is away.

**Trust.** The Mac trusts its paired box's `as: "person"`, because on the box only the
switchboard's person rule produces it, and `link.macs.call` is internal (modules only). A box
that was taken over could claim it; what it gains is typing into the Mac's sessions as the owner
would from the Deck, the same reach the owner's Deck already has. It still cannot run any other
write or read beyond the allowlist, because the Mac checks those itself, and an answer to a
permission question needs the box's signed assertion as well (v2).

## v2: answering a Mac's permission question from the box

Built 27 Sep 2026 (ADR 0030 step 7), so the person answers a Mac session's ask from the Deck and
the phone.

1. **The box's key.** The box keeps an Ed25519 key, made on first need and stored at 0600 in its
   home (`link-assert-key.json`, `core/link/assert.js`). `link.pair.poll` hands the public half to
   the Mac with the pairing key (`box.assertKey`), with the Mac's own node as the box sees it
   (`you.stableId`), and the Mac saves both in its `link.json`. A Mac paired before v2 takes them
   once from `link.hello`, over the channel it already pinned to the box's node (trust on first
   use of that pin). A pinned key is never replaced: a box with a new key means pairing again.
2. **The Mac's asks reach the box.** While paired, the Mac forwards every `ask.raised` and
   `ask.answered` (its decision is `cancelled` when an ask closed unanswered) for all of its
   threads, not only the ones the box sent to: the point is that the phone sees every ask, and
   asks are few. They ride the same `link.events` batches (a listener, no timer). The box
   re-emits them with `source: "mac"`, `machine` (the Mac's name, as listings label rows) and
   `node` (its stableId), the thread in the envelope and no project, and remembers which Mac
   each open ask is on (memory only, at most 500, for a day at most).
3. **The forward.** `threads.answer` on the box, for an ask the box does not have, goes to the
   Mac that raised it, only for the person's own callers (the same rule as `threads.send`:
   `wantsMacs`; an agent, MCP, a guest and a module never forward, and a call traced to a session
   never does). The ask names its Mac; `machine` names one when the box has not seen the ask
   (after a box restart). An ask no Mac raised and no `machine` goes nowhere, and the box answers
   as before (`no ask <id>`). The box signs, for that Mac alone, A = `{ v: 1, tool:
   "threads.answer", mac: <the Mac's stableId>, ask, thread?, decision: <sha256 base64url of the
   canonical JSON of the exact input sent>, caller, device: <the calling device's stableId or
   null>, person: <the person session's id, or null for a socket caller>, presence: <the proof's
   method, or null>, iat, exp: iat + 60 s, nonce: <16 random bytes> }`, and sends it with the
   write, `as: "person"`.
3a. **The person, and gated asks** (the lead's conditions, 27 Sep 2026). An owner device over the
   tailnet or the relay (`tailnet:<login>`, not `tailnet:agent:*`, or `device:<id>`) forwards an
   answer only inside a person session (`meta.person`, ADR 0032); without one the box refuses
   with `person_session_required` and signs and sends nothing. This is defence in depth: the
   registry's own person-session rule is on work/e2e, not yet here. The socket's callers (the
   Deck, the terminal, the Capsule) are the person already. An ask is **gated** when allowing it
   approves a floor tool that needs a fresh proof (`gatedAsk` in core/modules/federate.js): its
   `tool` is a HUMAN_ONLY name, or `mcp__vyre__<name>` or `mcp__plugin_vyre_vyre__<name>` with
   the name spelled as Vyre's MCP server spells it (each character outside `[A-Za-z0-9_-]` as
   `_`), exactly; or the ask says `presence.required: true`. On the box `threads.answer` carries
   a presence rule that asks only for an answer bound for a Mac that is gated, or for an ask the
   box never saw that names a `machine` (it could approve anything, so it fails closed); the
   registry verifies the proof, and the forward refuses with `presence_required` when there is
   none or it is a presence session. Every other answer asks nothing (the no-nag rule). On the
   Mac, the Mac looks up its own ask; for a gated one it refuses an assertion whose `presence` is
   null or `session`, however good its signature. The answer comes back unchanged plus `source: "mac"` and `machine`. It is never
   retried: "no ask" or "cancelled" from the Mac is final, and a retry would need a new nonce.
4. **The Mac's checks.** `threads.answer` is in `WRITE` at both ends. Before it runs as
   `link:box`, the Mac checks the signature against the pinned key, `tool` is `threads.answer`,
   `mac` is its own node, `ask` is the input's, the hash matches the input exactly, now is before
   `exp`, `iat` is at most 60 s ahead, the life is at most 60 s, the nonce is unseen (kept in
   memory until its `exp`, so for the whole window, at most 1000; past that, answers are refused
   rather than a nonce forgotten early), and a gated ask carries a fresh proof (3a). Any failure answers `denied` with the reason, and `threads.answer` never
   runs. The assertion is read for `threads.answer` only: `threads.send` keeps its own rule.
   `threads.answer` lists `link:box` among its callers, and a socket client can no longer claim
   a `link:` label (core/daemon), so only the link reaches it that way.
5. **No follow.** The Mac's `write()` follows the `thread` of its input, and an answer names
   none, so an answer follows nothing. The ask's end reaches the box through (2); what the
   session says next reaches the box only if the box is following that thread for a send.

**Trust.** The key proves the answer came from the paired box, for that ask, that answer and
that Mac, once, within a minute. For most asks it does not prove that a person pressed anything:
on the box, only the switchboard's person rule (the Deck, the terminal, the Capsule, the owner's
devices in a person session) makes the call, as for `threads.send`, and answering takes no
presence proof (ADR 0024, "No nagging"). A gated ask is the exception: the box signs the proof's
method, and the Mac refuses without a fresh one. A box that was taken over could sign answers, the same reach the
owner's Deck on the box already has. A captured assertion is no use on another Mac, another
ask, another answer, a second time or after a minute.

**Known limit (v2, e2e review, LOW 2, accepted for now):** seen nonces are kept in memory only. A
Mac that restarts inside a used assertion's 60 s window forgets it saw that nonce, so a captured
assertion could replay once, on that Mac, for that one ask and answer, before the window ends.
The impact stays small: only the paired box can mint an assertion at all, and it is bound to one
Mac, one ask and the exact answer hash, so a replay can only repeat the same answer to the same
still-open ask, not forge a new one. Persisting the nonce set is the fix if this needs closing
further; not done in v2.

## Consequences

- A paired Mac keeps one held request open to the box: one request a minute while idle.
- A send to a Mac thread costs the Mac at most four link.events calls a second while its answer
  streams, and nothing once it has finished.
- Every ask on a paired Mac costs two small events to the box (raised, then answered or
  cancelled), batched with the rest; an answer from the box is one link request.
- The box's reads can take up to 5 s longer when a Mac is slow, never longer.
- Onboarding's history step counts the Mac's sessions, held for 30 s and keyed on the Macs'
  online state, so its 2 s poll asks the Mac at most twice a minute.

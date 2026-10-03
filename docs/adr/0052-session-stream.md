---
title: "ADR 0052: The session stream"
summary: One typed, resumable stream per session. Every screen reads the same frames with a cursor, resumes from it over a direct connection or the relay, and steering, stopping, terminal commands and tool results travel in it as typed frames and blocks.
audience: builders
owner: chat
status: stable
---

# 0052: The session stream

Status: accepted for 0.3 (chat). Builds on ADR 0029 (resilience) and the module contract (ADR 0047).

## Decision

A session has one stream. The box keeps a gapless, per-session log of **frames**, serves it on a
ticketed WebSocket, and every screen (the app on a phone, the app in a browser, the Deck) reads it
with the same client and folds it into the same rows. The module is `core/stream`; its one tool is
`stream.open`.

```
switchboard events (thread.*, ask.*) + term.command
        | adapter.js (pure: event in, frame specs out)
        v
  per-session log (log.js: ring in memory + table, cursor 1..head, no gaps)
        | serve(): replay after `from`, then live, in one tick
        v
  /v1/streams/stream/session?ticket=...&from=N      (WebSocket; SSE with Last-Event-ID also served)
        | direct on the LAN or tailnet, or carried by the relay channel (same bytes)
        v
  client.js (resumable) -> frames.js (fold) -> rows
```

### Frames and cursors

A frame is a projection of the kernel event envelope: `{ v, id, cur, session, turn, type, time, corr,
data }`. `type` is `session.<kind>`. The kinds are `text-delta`, `text-done`, `tool-started`,
`tool-progress`, `tool-finished`, `term-chunk`, `term-command`, `file-changed`, `ask`,
`ask-answered`, `user-message`, `status`, and two control frames, `reset` and `heartbeat`, which have
cursor 0 and are never logged. `cur` is an integer per session, gapless from 1. A frame is not
hash-chained (deltas are too frequent for the log); `toEnvelope(frame)` lifts one into a real
envelope when it must be logged.

A replay may merge a run of adjacent deltas into one frame that carries `span` and `data.parts`, so
the cursors a frame covers are `cur - span + 1` to `cur`. Live frames are never merged.

### Resume

The client holds one number, `last`, the cursor of the newest frame it delivered. It drops any
frame at or below it, treats a frame that starts after `last + 1` as a gap and asks again from
`last`, and trims a merged frame whose start it already holds. A dropped connection reconnects at
once the first time, then with capped backoff and jitter. Nothing is acked and nothing is
retransmitted: the client only ever asks again from `last`.

Every attempt calls `stream.open {session, from}`, which returns a one-use ticket (15 seconds, bound to the caller) and
the log's `head` and `floor`. A `from` below `floor` is sent a `reset`; the client reads a snapshot
(the app resumes from `floor`, which is the oldest frame the log still holds) and carries on.
Because the ticket is an ordinary tool call and the socket is "a WebSocket on whichever path
answers", resume is the same code over the direct connection and over the relay.

A session whose log is empty (it began before the stream module, or before this vyred) is seeded
from the switchboard's stored events the first time a screen opens it, oldest first, with live
events held back until the seed is in. A screen therefore sees history without a second path.

### Steering and stopping

A message sent while the assistant works is `user-message {state: queued}` and becomes `picked-up`
at the next safe point (between tool calls or turns, never mid-tool). `cancelled` is a queued
message the person took back. The mapping from `thread.queued`, `thread.sent` (via steer),
`thread.steered` and `thread.unqueued` is `lib/queue-state.js`, one reading shared by the adapter,
the Deck and the tests. A stop emits `status {stopping: true}` before the process closes. A queued
or steered message is never lost by a stop or a restart. The composer never disables.

`threads.edit-retry`, `threads.retry` and `threads.branch` are person-only tools with an
Idempotency-Key; they go through the app's outbox like every write.

### Terminal in the session

`term.open {session}` opens the shell in the session's folder. A line the person types in that
terminal becomes event `term.command` (redacted, never output, never what was typed at a password
prompt), and the adapter lifts it to a `term-command` frame in the owning session's log, so the
assistant and every screen see what the person ran. The terminal's own bytes stay on the terminal's
socket with byte offsets (core/term), which makes terminal resume exact.

### Blocks

A tool result is a **block**, never raw JSON: `terminal`, `diff`, `files`, `record`, `task`,
`draft`, `flow-change`, `answer`, `screen` or `text`. An unknown tool degrades to a short `text`
block. A record block carries a sealed field only as its typed placeholder (class and presence,
never a value or a reference), and the app drops the rest at the door.

### Group chats (0.3, task G)

Every chat is a group chat; a one-to-one is a group of two. The frame stays one shape and gains,
additively (old frames stay valid):

- Envelope fields on any frame: `author` ("person:<id>", "assistant:<id>" or "model:<id>"), `acts_for`
  ("person:<id>", the asker; only on an assistant or model frame; the chain is [asker, assistant]) and
  `message` (the message the frame belongs to). `toEnvelope` makes the author the actor and `acts_for`
  the first hop of the chain.
- Logged kinds: `participant-joined`, `participant-left`, `reaction` { message, emoji, on },
  `pin` { message, on }, `mention` { message, who[] }, `fanout` { group, message, members: [{ who, message }] },
  `fanout-keep` { group, keep }, `text-cut` { message, note }. A thread reply is a field, `parent`, on
  `user-message` and `text-delta`, not a kind.
- Ephemeral kinds (cursor 0, never logged, never replayed, delivered as they come, they never move the
  client's `last`): `presence` { who, state: typing|doing, doing? } (one per author every 3 s, presence.js) and
  `read-marker` { upto } (per person, synced to that person's devices only, stored per person not per session,
  readmarks.js; the transport that fans it to a person's other sessions' connections is not wired yet).
- Who answers (routing.js, pure): mentioned assistants; the assigned one; else the default assistant, only when
  no person is talking to a person (previous speaker another person, or a person is mentioned: nobody answers).
- Per viewer (viewer.js, pure): `render(frame, viewer)` replaces fields the viewer cannot read in record, draft
  and answer blocks with typed placeholders (`{ sealed, present, valid_format, can_reveal }` or `{ hidden: "role",
  kind, present }`) without mutating the shared frame. `assertAskerCanRead(frame, asker)` throws when a reply
  holds a value or ref the asker could not read; `log.append(..., { asker })` calls it where a reply is built.
- Concurrent streams: the cursor is per session; each message is its own row (`a:<message>`); the log merges only
  adjacent deltas of the same message and author. Door holdback: the client treats the last 40 characters of a
  streaming reply as provisional until `text-done`; `text-cut` drops them and shows the note.

## Authority (the reviewer's gate, 3 Oct 2026)

- **Who may open a session.** `stream.open` decides before it makes a ticket, a log or a set entry. A chat's readers are
  its participants: an assistant acting for a person reads exactly what that person reads, and an owner or admin has no read
  grant to a chat they are not in. A thread session is resolved with `threads.get` as the caller (`ctx.call` with `as`, which
  `core/modules` allows the stream and term modules only for a person's or an assistant's own label); a refusal, denied or
  not_found, is the answer. A group session is read by the people in its log. Which path runs: in a 0.2 daemon, only those two.
  Where the kernel is wired and the call carries a session token, the kernel's `authorize` for `session.read` on
  `vyre://<space>/session/<id>` is asked too, and a deny refuses; `unknown_action` (the action is not registered in the Space
  yet) does not decide, so the participant rule still does. Unknown ids are refused before any log exists.
- **The ticket** stores the caller, the device key and the viewer; the upgrade must come from the same caller (and device, where
  the router names one), once, within 15 seconds.
- **Per viewer, on the server.** The viewer is part of the connection. `serve` draws every frame, replayed or live, WebSocket or
  SSE, through `forViewer` before `conn.send`: sealed and hidden fields are placeholders, and a record the viewer is not cleared
  for (`read_roles`) becomes a `hidden` frame that keeps its cursor and holds nothing. The client draws what arrives and
  decides nothing. `thread.shell` command and output are redacted before they are logged or sent.
- **Terminal.** `term.open {session}` resolves the session as the caller and takes the event's thread only from that record;
  `cwd` must be omitted or the session's own folder; `term.attach` re-checks. A typed command is recorded with its typist
  (`author`, `via`, `surface`). A terminal is a full login shell: `session` only chooses where it starts, and nothing keeps it
  there. A sandbox is the runner's job.
- **Retention.** The stream log keeps assistant text deltas and shell output for 24 hours (`stream.retainHours`). After that the
  frame stays, with its cursor, empty and marked `expired`. A group chat's words (text with an author) stay: the log is that
  chat's record. User messages, tool results and asks are not touched by this.
- **Edit and retry** check that the send will be accepted before they rewind, record the author on the message, and allow
  editing only one's own (the owner's own surface, with no verified peer, may edit any).

## Numbers (testbox, Node 22, loopback)

Emit to client over a real WebSocket, 3000 frames: p50 0.34 ms, p95 0.77 ms, p99 1.85 ms, max
9.28 ms (target: first token within 300 ms of emit). Kill to first resumed frame, 30 kills: p50
6.08 ms, p95 9.95 ms, max 11.36 ms (target: 1 second). In the app, paint of the first characters of a
reply: p95 61.7 ms; every delta: p95 125.1 ms (headless Chromium, software raster).

## What was deliberately not built

- A second stream per device, or per-provider frame shapes. One shape; adapters do the mapping.
- A client-side ack or retransmit protocol. The cursor is the only state.
- Hash-chained frames. The log is a resume buffer, not the record; the record is the event log.
- Polling. Frames are sent the moment an event lands; nothing runs faster than 60 seconds while idle.
- Terminal output in the session log. Only what the person typed is recorded.
- A history of unlimited length in the stream. The log is bounded (frames and bytes); older history
  is the transcript's job, and a client behind the floor is reset.
- The terminal over the relay. The terminal page runs in an iframe or a WebView and opens its own
  socket on the box's origin, so it needs the direct path; over the relay the chat says so.
- Frames for usage, limits or model changes. Those are header facts read from the session record.

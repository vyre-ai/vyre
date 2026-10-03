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

Every attempt calls `stream.open {session, from}`, which returns a one-use ticket (30 seconds) and
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

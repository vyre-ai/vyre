---
title: ADR 0003: How Glass streams an agent's screen, and who may type into it
summary: How an agent's screen streams live to the Deck over the tailnet, and how one person at a time takes the keyboard and hands it back.
audience: builders
owner: docs
status: stable
---

# ADR 0003: How Glass streams an agent's screen, and who may type into it

Status: accepted, 26 Sep 2026 · Workstream: computers · Spec: sections 7.9, 9 (Glass) and 11 (floor rules 3 and 4)

## The problem

An agent works in its own container: a desktop, Chrome and a terminal. The user wants to watch
that screen live from the Deck, on a laptop or a phone, and sometimes take the keyboard, type,
and hand it back. Three things have to be true:

1. **Live enough to follow.** A person watching should see a page load and a form fill as it
   happens, on a phone over the tailnet, without the box burning a core per viewer.
2. **One keyboard at a time** (floor rule 4). While the user types, the agent's hands stop, and
   every other viewer is read-only. A viewer that is only watching must not be able to type,
   whatever its browser sends.
3. **Nothing reaches the container except through vyred.** The container's display port, its
   Chrome debugging port and its helper are on an internal Docker network. The browser never
   holds a credential for any of them.

## Options

**A. RFB (VNC) over a WebSocket, relayed by vyred.** The container runs TigerVNC's `Xvnc`, which
is the X server and the VNC server in one process. vyred opens a WebSocket for the Deck and a TCP
connection to `Xvnc`, does the VNC authentication itself, and relays bytes. The Deck draws with
noVNC, vendored as files.

**B. WebRTC.** The container encodes the screen as H.264 or VP8 (GStreamer, or a Selkies-style
stack) and the browser plays it as video, with input over a data channel. vyred does signalling.

**C. Screenshots over the event stream.** CDP `Page.startScreencast` or periodic PNGs.

## Decision

**A, RFB over a WebSocket, with vyred as the only relay and the input gate.**

- **Cost.** `Xvnc` only encodes regions that changed, and a desktop where an agent fills a form
  changes little. Tight and ZRLE encodings keep a mostly static 1440 x 900 screen in the tens of
  kilobytes a second. WebRTC wins on full-motion video, which an agent's screen almost never is,
  and it costs a video encoder running per container whether anything moves or not.
- **Moving parts.** A needs one process in the container and about two hundred lines in vyred.
  B needs GStreamer, a codec, ICE, and a data channel protocol for input, in the image and in
  vyred. On a tailnet the NAT traversal WebRTC is good at buys nothing: every device already
  reaches the box directly.
- **Gating input.** RFB client messages are few and have fixed shapes, so vyred can read the
  client-to-server stream and drop `KeyEvent`, `PointerEvent` button presses and
  `ClientCutText` from any viewer that does not hold the keyboard. With WebRTC input rides a data
  channel that vyred would have to terminate anyway. With C there is no input at all.
- **C is kept for agents, not people.** An agent looks at its screen through `hands-chrome` and
  `hands-desktop` (a screenshot, the accessibility tree), never through Glass.

If full-motion video ever matters (an agent watching a video call, say), B can be added as a
second transport behind the same ticket and lease. Nothing in the Deck's contract names RFB.

## How it works

```
Deck (noVNC) --wss--> vyred /v1/streams/computers/glass?ticket=T --tcp--> Xvnc :5900 in the container
                        |  1. ticket -> {agent, surface}, one use, 30 s
                        |  2. VNC auth with the container's own password (the browser never has it)
                        |  3. the browser is offered security type None
                        |  4. client->server: input dropped unless this surface has the keyboard
```

1. **Ticket.** The Deck calls `computers.watch {agent, surface}` like any tool, so the Rules see
   it. It returns a one-time ticket that lives 30 seconds, bound to that agent and surface. The
   WebSocket upgrade must present it; a used or expired ticket gets a 403 before any byte of RFB.
2. **Handshake.** vyred speaks RFB 3.8 to `Xvnc` as a client (VNC authentication with the
   per-computer password from the computers table), and RFB 3.8 to the browser as a server
   offering security type 1, None. It passes `ServerInit` through unchanged, so the browser
   learns the real size and pixel format.
3. **Relay.** Server-to-client bytes are passed through untouched. Client-to-server bytes are
   parsed message by message (`SetPixelFormat`, `SetEncodings`, `FramebufferUpdateRequest`,
   `KeyEvent`, `PointerEvent`, `ClientCutText`); an unknown message type closes the connection,
   because a stream that cannot be parsed cannot be gated.
4. **The gate.** A viewer may send input only while it is the take-over surface for that
   computer. Otherwise `KeyEvent`, `PointerEvent` and `ClientCutText` are dropped, pointer moves
   included, since a moved cursor can change what the agent's next click hovers. The check reads an in-memory record kept current by `lease.changed` events, so it
   costs nothing per keystroke.
5. **Viewers keep the screen.** An open Glass connection counts as needing to look: the
   computer stays checked out and unfrozen while anyone watches.
6. **Latency.** The Deck shows "38 ms from your box" from a WebSocket ping every five seconds,
   measured end to end through vyred.

## Take-over and the lease

The switchboard's lease is the one keyboard. Take-over is a record in `core/computers` of which
surface took the computer, plus `threads.lease` on the thread that is using the computer, so
typing into that thread moves to the same surface and the others go read-only (floor rule 4 for
the thread and the screen at once).

- `computers.takeover {agent, surface}`: records the take-over, takes the thread's lease, and
  emits `computer.taken-over`. From then on the agent's `hands-chrome` and `hands-desktop` input
  actions are refused with who has the keyboard; its reads and screenshots still work.
- The take-over holds while that surface keeps the lease alive (Glass renews every 30 seconds;
  the lease expires after 90). Closing the laptop lid ends it by expiry, as the switchboard
  intends. Moving the lease to another human surface (the phone) keeps the agent paused.
- `computers.giveback {agent, surface}` releases the lease, ends the record, and emits
  `computer.handed-back`. The agent's hands work again on its next call.
- Typing into the agent's thread from the Deck does not pause its hands. Only take-over does:
  otherwise chatting with an agent would stop its work.

## Consequences

- noVNC is vendored under `deck/glass/vendor/novnc/` with its licence (MPL 2.0, file-level
  copyleft, compatible with shipping inside an Apache 2.0 project as separate files).
- vyred's HTTP server gains a WebSocket upgrade path, `/v1/streams/<module>/...`, which a module
  registers with `ctx.upgrade(name, handler)`. This is the one shared-core change.
- The container's VNC password and helper token are generated by vyred and stored in the
  computers table. They never appear in a tool result, an event or a log. They are not user
  credentials, so they do not go in the Vault; losing the table means recreating containers.
- Anyone who can call `computers.watch` can watch. The Rules decide who that is, as for every
  tool.

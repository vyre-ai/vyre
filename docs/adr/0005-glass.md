---
title: ADR 0005: Glass: a remote computer you can watch, take over, sign in on and browse
summary: Glass shows a remote computer live and lets a person watch an agent, take over, sign in with the Vault and browse, from the Deck, the Capsule or the phone.
audience: builders
owner: docs
status: stable
---

# ADR 0005: Glass: a remote computer you can watch, take over, sign in on and browse

Status: accepted, 26 Sep 2026 · Workstream: glass · Spec: sections 5, 7.9, 9 and 11 (floor rules
4, 5 and 8) · Builds on: ADR 0003 (the stream), ADR 0004 (presence), ADR 0010 (vault autofill)

## The problem

Glass shows a remote computer live and lets a person act on it. Four jobs:

1. **Watch** an agent work in its own computer (a container on the box with a desktop, Chrome
   and a terminal), from the Deck on a laptop, from the Capsule on the Mac, and on the phone.
2. **Take over**: the person types and clicks, then hands back. One keyboard at a time
   (floor rule 4).
3. **Sign in** to a site in the agent's Chrome, so the agent can use the session later without
   ever seeing the password.
4. **Browse files** on the agent's computer and on the box: look, download, upload, move.

Everything is reachable only over the user's tailnet, like the rest of the Deck.

## What already exists

The computers workstream (ADR 0003) owns the machine: the container image, the pool and freeze,
`computers.watch` (a one-time ticket for `/v1/streams/computers/glass`), the RFB relay in vyred
that gates input by the keyboard holder, `computers.takeover` and `computers.giveback` on top of
`threads.lease`, and the agent's hands (`hands-chrome` over CDP, `hands-desktop` over AT-SPI and
`computerd`). Link is building a read-only `files` module (search, stat, preview, fetch on the box
and the Mac). Security has built presence proofs (ADR 0004).

Glass must not rebuild any of that. The question is what is left, and who owns it.

## Decisions

### 1. The stream stays RFB over a WebSocket (ADR 0003 holds)

We re-weighed WebRTC, Xpra, Guacamole and CDP screencast. RFB wins for an agent's screen, which
changes a little at a time: Xvnc encodes only changed regions, sends nothing when nothing moves,
and vyred can parse and gate its few input messages. WebRTC's strengths (full-motion video,
NAT traversal) buy little on a tailnet, and it costs an encoder per container. It stays the
possible second transport behind the same ticket and lease.

- The Deck vendors **noVNC 1.7.0** (MPL 2.0, as separate files) under `deck/glass/vendor/novnc/`.
- `resizeSession` off, `scaleViewport` on. Quality and compression by device: laptop 6 / 2,
  phone on Wi-Fi 5 / 4, phone on a slow link (`navigator.connection.effectiveType` 3g or worse,
  or Save-Data) 2 / 6. Never compression above 6: zlib cost on the box climbs past it.
- **A hidden tab disconnects.** noVNC has no pause, and with continuous updates on it stops
  asking for frames, so throttling does not work. On `visibilitychange` to hidden the Deck
  closes the socket and keeps the last frame, dimmed. Visible again, it gets a fresh ticket.
  Closing drops the viewer, so the computer can freeze. This keeps a background Deck at zero
  timers (principle 8).
- **Reconnect** after an unclean close with a fresh ticket, backing off 1, 2, 4 up to 30 seconds,
  only while visible. Close codes tell the Deck whether to retry: 4001 not running, 4003 bad
  ticket (do not retry), 4008 protocol.

Relay and image fixes found in review, sent to computers (they own the files):

| Where | Fix |
|---|---|
| relay | Backpressure: pause the Xvnc socket when the WebSocket write buffer is full, resume on drain. Without it a slow phone makes vyred buffer without limit. |
| relay | vyred pings every open socket every 30 s and closes after two missed pongs. A half-open cellular socket otherwise holds the viewer, and the container never freezes. Browsers cannot send pings from script, so ADR 0003's "ping every five seconds" moves to the server. |
| relay | Send a WebSocket close frame with a code before destroying the socket. |
| relay | Always drop `SetDesktopSize` and `xvp`, even from the keyboard holder. |
| relay | Cap viewers at 4 per computer; each is its own encoder in Xvnc. |
| image | `-SendCutText=0 -SendPrimary=0`. Today whatever the agent copies, a Vault value included, reaches every watcher's browser (floor rule 8). |
| image | `-AcceptSetDesktopSize=0 -MaxCutText=262144 -FrameRate=24`. |

### 2. Take-over needs a person, and the open socket keeps it alive

Take-over pauses the agent's hands. That is a human-only action: a model that could take over
could stop any agent, and one that could hand back could end a person's take-over mid-password.

- `glass.take` and `glass.release` declare `presence` (ADR 0004). The Deck and the phone prove
  with a passkey (Touch ID, Face ID); the Capsule signs its own proof after a click. Glass calls
  `computers.takeover` and `computers.giveback` as `module:glass`. We ask security to put
  `computers.takeover` and `computers.giveback` on the floor's human-only list, so a direct
  call from a model is refused too.
- Changed 27 Sep 2026 (ADR 0004 addendum): none of the four asks for a proof now, private
  sign-in included. They are `PERSON_ONLY`: an agent, a guest and Claude's sessions are still
  refused, and the owner takes and hands back with one click.
- **No client timers.** ADR 0003 has Glass renew the lease every 30 seconds, which breaks the
  Deck's one-minute rule for a background tab. Instead the relay renews the take-over and the
  thread lease on each pong and each forwarded input. A hidden tab disconnects (decision 1), so a
  hidden tab ends a take-over by lease expiry, 90 seconds later. An idle take-over (no input for
  5 minutes) hands back on its own.
- **Moving the keyboard** from laptop to phone is a new take from the phone, with a fresh proof.
- **Input** (in the Deck, in `deck/glass/input.js` over noVNC's own handlers):
  - keysyms from `KeyboardEvent.key`, not scancodes, so AZERTY and QWERTZ type what they say;
    noVNC's QEMU extended key events are turned off;
  - dead keys and IME through `compositionend` and `beforeinput`, sent as Unicode keysyms;
  - on a Mac, Cmd+letter is sent as Ctrl+letter (the container is Linux); Option is Alt;
  - paste is typed as keysyms, capped at 4 KB and paced; `ClientCutText` stays gated;
  - the wheel is summed and sent as one button 4/5 (6/7 horizontal) click per 50 px, at most
    20 a second, so a trackpad does not flood;
  - on the phone: tap is a left click, long press (500 ms) a right click, two fingers scroll,
    pinch zooms the local view with a CSS transform, and a keyboard button focuses a hidden
    input read through `beforeinput` (soft keyboards report keyCode 229).
- **Hand-back** ends in one of four ways: the button (Ctrl+Enter on the board), idle, the tab
  hidden past lease expiry, or the lease expiring. The agent's thread gets a note: who had the
  keyboard, for how long, why it ended, the page before and after. Never what was typed.
- **Other viewers** see "You have control from phone · 2:14" or "Someone has control" from the
  `computer.taken-over` event; their input is already dropped by the relay.

### 3. Signing in: a private take-over shields the agent's eyes as well as its hands

A take-over stops the agent's input. Signing in needs more: the agent must not read what the
person types by any route. The routes are the DOM (a snapshot reads field values), the network
(CDP `Network` sees the POST body), injected script (`Runtime.addBinding` can keylog), the
accessibility tree, screenshots, and the X clipboard. Pixels are the least of it: password fields
are masked.

`glass.take {private: true}` is a **shielded** take-over. It is labelled "Sign in privately" in
the Deck. While it holds:

- the agent's hands refuse **reads** as well as input: snapshot, screenshot, tree, apps;
- hands-chrome drops its CDP connection to that computer, so nothing already attached can see
  the page;
- computerd refuses its `/tree`, `/screenshot`, `/act` and `/input` routes with 423;
- the relay sends server clipboard text only to the holder;
- the event stream carries `computer.shielded {agent}` and later `computer.unshielded {agent,
  origin}`, with the page's origin only, never a path or query.

After hand-back the agent reconnects and sees whatever page is open, signed in. It never gets a
record of the shielded period.

The shield is enforced in computers (the hands, computerd and the relay are theirs), and Glass
asks for it through a new `computers.shield {agent, on}` tool that only modules may call. Two
holes in the current code come first, because they make any take-over unsafe for a password:

1. **Chrome's debugging port is unauthenticated** on the internal network (socat on 9223). A
   Bash command on the box might reach it and record keys. Fix: Chrome on
   `--remote-debugging-pipe`, and computerd exposes an authenticated CDP proxy that refuses new
   sessions while shielded and always refuses `Runtime.addBinding` and
   `Page.addScriptToEvaluateOnNewDocument` from the agent's side.
2. **Anyone can hand back.** `computers.giveback` checks only the surface name, which is public.
   Fix: presence (decision 2).

**Sessions persist per agent** in its Chrome profile on its own home volume, so a sign-in lasts
across freezes and container recreation. The entrypoint removes stale `Singleton*` locks before
Chrome starts. Chrome's own password saving is off by policy: the Vault is the only store. With
no keyring in a container, Chrome keeps cookies with its "basic" store, which is obfuscation, not
encryption. We say so plainly: anyone holding the volume or a backup of it holds the sessions.
Encrypting the volumes at rest is a box decision we hand to security and box.

**Vault fill into the remote Chrome** comes after the shield. A person picks a login in Glass;
vyred shields the computer, checks the top frame's exact origin against the login's hosts (the
rule in ADR 0010), sends the username and password with CDP `Input.insertText` into
the fields it just checked, checks the origin again, and keeps the shield up through submit. The
value exists only in vyred's memory and one CDP frame. It is a vault route that needs presence,
never a tool an agent can see; the vault owns it (an addendum to ADR 0010). Glass only shows
the button.

### 4. Files: one browser, three targets, bytes on ticketed routes

A **target** is where the files are: `computer:<agent>` (the agent's home, `/home/agent`),
`box` (the folders the user chose, from config), and later `mac` (through link).

- **Roots and the floor** are checked in one place, `core/glass/guard.js`, before any read or
  write: paths are relative to a root, `..`, NUL and absolute input are refused, symlinks resolve
  inside the root or not at all, and secret places are denied at any depth and hidden from
  listings (`.vyre`, `.claude`, `.ssh`, `.gnupg`, `.aws`, `.env*`, `*.pem`, `*.key`, `id_*`,
  `.netrc`, `.git-credentials`, `.docker/config.json`, Chrome's `Cookies` and `Login Data`).
  Link's `files` module applies the same list; we keep the two in step with a shared test list.
- **JSON tools never carry file bytes.** Listing, stat and text preview are tools. Downloads and
  uploads get a one-time ticket from a tool (so the Rules see the call), and the bytes move on
  `/v1/glass/raw` and `/v1/glass/put` (plain HTTP routes a module adds with `ctx.route`). Raw responses send `nosniff` and
  `Content-Security-Policy: default-src 'none'`, and serve only png, jpeg, gif, webp and pdf
  inline; anything else downloads, so a remote file never runs script in the Deck's origin.
- **Writes are visible** (floor rule 5): `file.uploaded`, `file.moved`, `file.trashed` and
  `file.created` carry target, path, size and who, never content. Delete moves to a trash folder
  in the target; there is no hard delete in v1.
- **On an agent's computer** the bytes come from computerd, which runs as the agent's user and
  applies the same guard inside the container. vyred reaches it through `computers.helper`, a
  module-only tool that thaws the container without taking a screen slot. Glass writes the
  computerd `/fs` routes as a contribution to the computers image.
- **Drag and drop:** dropping files from Finder onto the browser uploads them; dragging a remote
  file out uses `DownloadURL` in Chromium browsers and a Download button elsewhere.

### 5. Ownership, through the module contract

Glass is a module. It owns the person-facing layer: what can be opened, the person's actions on
it, and the file browser. Computers owns the machine. No tool exists twice.

| Piece | Owner |
|---|---|
| Containers, pool, freeze, RFB relay and input gate, `computers.watch`, `takeover`, `giveback`, the shield's enforcement, computerd | computers |
| `glass.*` tools, the file guard and streams, sessions (who is watching from where), the thread note on hand-back | glass (`core/glass/`) |
| Views: watch, take-over, sign-in, files, phone; vendored noVNC | glass (`deck/glass/`) |
| `/glass/:target` route loading the views | deck (already loads `deck/glass/index.js`) |
| "Open Glass" for a thread | capsule, opening the Deck URL in the default browser |
| Presence on take, release and the fill route | security |
| Remote fill route | vault |
| `files.*` on the box and the Mac, box to Mac relay | link |

`core/glass/module.json`:

```json
{
  "name": "glass",
  "version": "0.1.0",
  "roles": ["box"],
  "requires": [],
  "does": { "tools": [
    "glass.targets", "glass.open", "glass.close", "glass.take", "glass.release",
    "glass.files.list", "glass.files.stat", "glass.files.preview", "glass.files.download",
    "glass.files.upload", "glass.files.move", "glass.files.mkdir", "glass.files.trash"
  ] },
  "watches": { "emits": [
    "glass.opened", "glass.closed", "glass.taken", "glass.released",
    "file.uploaded", "file.moved", "file.trashed", "file.created"
  ] },
  "shows": { "deck": ["route:/glass/:target"], "capsule": ["open-glass"], "cli": ["glass"] },
  "needs": {},
  "teaches": {}
}
```

| Tool | Input | Returns |
|---|---|---|
| `glass.targets` | `{}` | `[{target, label, screen, files, state, viewers, takeover}]` |
| `glass.open` | `{target, surface}` | `{session, screen?: {ticket, path, width, height}, roots}`; the screen part comes from `computers.watch` |
| `glass.close` | `{session}` | `{closed}` |
| `glass.take` | `{target, surface, private?}` (presence) | `{target, surface, since, private}` |
| `glass.release` | `{target, surface, note?}` (presence) | `{released, held_ms}` |
| `glass.files.list` | `{target, path?}` | `{root, path, entries: [{name, kind, size, mtime}]}` |
| `glass.files.stat` | `{target, path}` | `{name, kind, size, mtime, mime}` |
| `glass.files.preview` | `{target, path}` | `{kind: "text", text, truncated}` or `{kind: "image"\|"pdf", path}` (a ticketed raw path) |
| `glass.files.download` | `{target, path}` | `{path, name, size}` (a ticketed raw path, one use, 60 s) |
| `glass.files.upload` | `{target, dir, name, size, overwrite?}` | `{path}` (a ticketed put path, one use, 60 s, size-capped) |
| `glass.files.move` | `{target, from, to}` | `{moved}` |
| `glass.files.mkdir` | `{target, path}` | `{created}` |
| `glass.files.trash` | `{target, path}` | `{trashed, to}` |

`glass.open` and `glass.close` keep a small `glass_sessions` table so any surface can say "you
and your phone are watching", and so the Capsule can find the session for a thread. `surface` is
a claim like `deck:<device>` or `phone:<device>`; an agent caller may not name a person's
surface, and the tools refuse it.

**The box has no screen.** It is a headless server; only agent computers run Xvnc. A box
terminal in the browser would be a host shell that skips the Rules, so Glass does not offer one.
The box is a files-only target.

**The Capsule** opens `https://<box>/glass/<agent>` in the default browser: Tailscale identifies
the user there, so there is no second trust path. Its "Open Glass" action appears on a thread
whose agent has a computer.

**The phone** is the same Deck route; below 600 px it lays out as the PhoneGlass board.

## Consequences

- Glass works today for watching, taking over and files on the agent's computer and the box. The
  private sign-in needs the computers shield, and the remote fill needs the vault route; until
  they land the Deck shows "Sign in privately" as unavailable and says why, and a plain take-over
  warns that the agent can still read the page.
- The Deck's CSP already allows same-origin `wss:` and `blob:` images; raw files open from the
  same origin with their own restrictive headers.
- Two lists of denied paths (glass and link) must stay equal. A shared test fixture keeps them so.
- ADR 0003 changes in three places: server pings instead of client pings, lease renewal from the
  relay, and the clipboard off by default.

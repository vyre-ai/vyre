---
title: ADR 0011: Web Push for the moments the user is needed
summary: The Deck uses Web Push so a phone learns when a session asks permission, the Gate holds something, a thread finishes or a lesson is proposed, without the Deck open.
audience: builders
owner: docs
status: stable
---

# ADR 0011: Web Push for the moments the user is needed

Status: accepted, 26 Sep 2026 · Workstream: switchboard (module `push`, `core/push`) · Spec: sections 2, 9

## The problem

The Deck is a web app the user installs on a phone. When a session asks permission, something
waits at the Gate, a watched thread finishes, or Learning proposes a lesson, the user needs to
know without keeping the Deck open. A browser learns about that through Web Push: the page
subscribes with the browser's push service, and a server sends to that service, which wakes the
page's service worker.

That puts a third party in the path: Google's FCM for Chrome and Android, Mozilla's autopush
for Firefox, Apple's service for Safari. Every notification leaves the box and crosses their
servers, and the phone's lock screen shows it to anyone holding the phone.

## Decision

1. **The box sends outbound HTTPS to the push services, and to nothing else.** This is a new
   kind of outbound traffic next to the Gate's. It carries no user content (point 2), so it
   does not go through the Gate. A subscription names its own endpoint URL, and vyred must not
   become a way to POST to any URL a client names. So an endpoint is accepted only on a known
   push service host (`fcm.googleapis.com`, `updates.push.services.mozilla.com`,
   `*.push.apple.com`, `*.notify.windows.com`), over https. `config.push.hosts` adds hosts, and
   `config.push.allow_http` exists for tests.
2. **A notification says that something needs you, and where. It never says what.** The
   payload is `{kind, title, path, tag, at}`:
   - `kind` is `ask`, `draft`, `watch`, `lesson` or `test`;
   - `title` is a fixed sentence per kind;
   - `path` is a Deck path holding only an id.

   It never carries draft content, a tool's input or summary, a recipient, a value or a secret,
   and never a name the user typed. The Deck fetches details after the tap, over the user's own
   authenticated connection to the box. The payload is still encrypted end to end (RFC 8291),
   so the push service cannot read even that.
3. **No dependency.** VAPID (RFC 8292, an ES256 JWT) and aes128gcm payload encryption
   (RFC 8291 over RFC 8188) use node:crypto only. The encryption is tested byte for byte
   against RFC 8291 Appendix A, and against a decryption written separately with WebCrypto, the
   way a browser does it.
4. **The VAPID private key lives in the Vault.** It is made on first use, never at start: a
   vyred nobody subscribes to never touches the Vault for push. It is put as item `push-vapid`,
   granted to module `push` alone. Only the public half (the browser's
   `applicationServerKey`) is kept in push's own table. Losing the Vault means making a new key,
   and every device subscribes again.
5. **Only people's surfaces manage it.** `push.*` tools answer `cli`, `local`, `deck` and
   `capsule`. Claude cannot subscribe a device, change quiet hours or send a test.
6. **Quiet hours and per-kind switches** are settings (`push.settings`). While quiet, nothing is
   sent and nothing is queued: the moment stays in the Deck's Now list. `push.test` ignores
   quiet hours.
7. **Dead subscriptions are dropped.** A 404 or 410 from the service deletes the device, and so
   does a passed `expirationTime`. Other failures are counted per device and kept.

## Amendment, 27 Sep 2026: needs you only, and never while you are at a screen

- A push is for "needs you" only: an ask, a held draft, a watched thread (a notification the
  person asked for) and a planner ring. A proposed lesson is off by default; `push.settings`
  with `kinds: {lesson: true}` turns it back on.
- Surfaces call `push.seen` (`surface`, `visible`) when a screen is shown, when it is hidden,
  and on the first input after a minute of none. It never polls. The box keeps the time of the
  last call in memory only; a restart forgets it, and the next moment then goes at once.
- An ask, a draft or a watch that arrives within 3 minutes of the last `push.seen` is held, by
  its tag, until 3 minutes after that call. One timer runs, and only while something is held.
  When it fires after a newer `push.seen`, it waits again. At most 200 are held; the oldest
  goes first. Quiet hours and the kind switches are checked again when it is sent.
- A held moment answered or resolved on a screen is dropped and never sent: `ask.answered`
  for an ask, and `gate.released`, `gate.rejected`, `gate.revised` or `gate.failed` for a draft.
  A watch has no resolution; it waits for the timer.
- A planner ring (`planner.fired`) always goes at once, and `planner.acked` is unchanged.

## Consequences

- The push services learn that this box sent this device something, when, and roughly how
  big. That is the metadata cost of notifications on today's phones. The content cost is none.
- A box with no outbound HTTPS, or firewalled to the Gate's destinations only, cannot notify.
  The Deck still works, and the user sees the same moments when they open it.
- Apple requires `sub` to be a `mailto:` or `https:` URL. It defaults to `https://vyre.sh`, and
  `config.push.subject` changes it.

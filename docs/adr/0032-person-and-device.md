---
title: "ADR 0032: The person and the device"
summary: Over the network a device of the owner is not the person. Person sessions (passkey, 30 days, pinned to a node) carry the person's actions over HTTP; on the box, Vyre-owned sessions run as a uid that cannot open vyred's socket.
audience: builders, agents
owner: e2e
status: draft
---

# ADR 0032: The person and the device

## Context

Vyre separates what a person does (answering an ask, approving a send, opening a terminal,
revealing a secret) from what a model or an agent does. On the unix socket, vyred asks the
kernel which process connected and refuses a person's action from any process under a `claude`
or a thread it runs (core/daemon/peer.js). Over the tailnet, the names listener asks Tailscale
who a node is, and every node signed in as the owner was treated as the owner's Deck.

The audit of 27 September found three ways a process that is not the person could act as one:

1. Any process on any owner node was the Deck. A Claude Code on the owner's Mac could `curl`
   the box's address and call threads.answer on its own ask, gate.reject, agents.create,
   term.open (a shell on the box), glass.take and computers.takeover, with no proof. The Host,
   JSON-only and Origin checks stop web pages, not scripts.
2. `link.call` on the Mac carried any box tool through the paired link, so the same calls went
   through the Mac's socket as the owner's device.
3. The socket's ancestry check is escaped by an orphan: a model's shell runs
   `nohup sh -c "sleep 1; vyre ..." &`, the shell exits, the child's parent becomes 1, and the
   walk reaches init with no `claude` above it. `setsid` and a daemonized tmux do the same, and
   any marker in the environment is the model's to clear.

Tools that need presence (HUMAN_ONLY) were never reachable this way: a passkey or Touch ID proof
is bound to the exact call, and a script cannot make one.

## Decision

### 1. A device is not the person

A caller the tailnet listener names `tailnet:<login>` is a device of the owner. The registry
refuses it every PERSON_ONLY tool and every tool that needs presence for this input, with
`person_session_required` (HTTP 401), unless the request carries a person session. Only vyred's
router sets that (`meta.person`); no input or header claim does. Two tools are exempt: signing
in (presence.person.start, which takes a passkey) and enrolling the first passkey (which takes
onboarding's one-time code). HUMAN_ONLY tools need the session and their proof.

### 2. The person session (core/presence/person.js)

- Made by a passkey at the box's own address, in the person's browser.
- Pinned to the tailnet node (stableId) it was made on; from any other node it is nothing.
- Lasts 30 days from its last use and 90 days at most. Listed (presence.person.sessions) and
  revocable (presence.person.revoke) in Settings; POST /v1/person/end signs out.
- The Deck and the phone at the box's address get a cookie, `__Host-vyre_person`: HttpOnly,
  Secure, SameSite=Strict, Path=/. No page script reads it and no other site sends it, and the
  existing JSON and Origin checks stay.
- The hosted app at another origin (app.vyre.run), where a cookie would be third-party, goes to
  the box's page /person/signin with a PKCE S256 challenge and where to return. The box checks
  the return address against `network.origins` (default https://app.vyre.run), asks the passkey
  there (the rpId stays the box's), and redirects back with a one-time code bound to that node,
  that challenge and that origin. The app trades code, verifier and the public half of a
  non-extractable ES256 key at POST /v1/person/token for `Vyre <id>.<secret>`, and signs every
  request: `x-vyre-proof: t=<ms> n=<nonce> sig=<b64url>` over
  `METHOD\npath?query\nsha256b64url(body)\nt\nn`, within a minute, each nonce once. Nothing is
  ambient, so there is no CSRF; CORS names the allowed origins exactly, without credentials.
  From another origin, nothing but the token route answers without a session.
- A paired Mac (`vyre link signin`) does the same as a native app: its vyred opens the box's page
  with a one-time loopback address (RFC 8252), trades the code with no Origin, and signs the
  person calls it forwards. Only the person's own callers on the Mac (cli, local, capsule, deck,
  already traced by the socket's ancestry check) carry it through link.call. A model, a module
  or a guest never does, and HUMAN_ONLY tools never ride the link: the box cannot check a
  proof made on the Mac.

### 3. On the box, a model cannot reach the person's socket

Vyre-owned sessions (ADR 0030) run their `claude` child as a second uid, `vyre-agent`, which
cannot open vyred's socket (0600, uid `vyre`). Their Vyre tools come through the SDK's
in-process MCP server, whose caller the driver sets. The work folder is shared by group
(`vyre-work`, setgid directories, umask 002) and the session's transcripts by group read.
Until that lands, every SDK child is spawned under `tini -s`, a subreaper, so its orphans stay
below a pid in `threads.pids` and the ancestry check still sees them.

vyred itself runs without privileges, so it cannot change uid. A small spawner, root in the
container with every capability dropped but SETUID, SETGID and KILL, listens on a socket only
uid `vyre` can open, starts a given command as `vyre-agent` in a fixed environment, and passes
its stdio back. It starts nothing else. The sessions team's driver spawns through it
(spawnClaudeCodeProcess).

### 4. On the Mac, the residual is accepted

A split uid is not practical on a person's Mac. A process of the same user can read what the
person's vyred and browser keep: link.json with the Mac's session, a browser's IndexedDB.
Chrome's cookie store is encrypted with a keychain key, and Safari's is behind TCC, which raises
the bar. What stays true: minting a session always takes the person's passkey; HUMAN_ONLY
always takes a fresh proof; the socket's ancestry check stops the plain case. Cheap hardening
beside it: vyred records the process group and session of every child it spawns and refuses a
person's action from any process in one of them, even after it is reparented, where the OS
shows them.

## Consequences

- Every surface meets 401 `person_session_required` once per device per 30 days. The Deck signs
  in by itself the first time a call needs it (deck/js/api.js); pwa owns the sheet and the
  Settings list.
- Tests that stand in for a signed-in Deck pass `person: { id, kind }` in the call's meta.
- The vault fill listener follows the same idea: a paired extension's Origin is kept, the
  extensions that may pair are listed (`vault.fill.extensions`), and an extension that sends a
  key when it pairs must sign every request, so a copied token is not enough.

## Rejected

- Trusting app.vyre.run's Origin alone: a compromised app would hold the person's power on every
  box it is opened against.
- Related Origin Requests for passkeys at app.vyre.run: Firefox lacks it, and the box's own page
  works everywhere.
- A marker in the environment of Vyre's children: the model's to clear.

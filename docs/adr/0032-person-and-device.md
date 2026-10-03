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

### 2b. Devices over the relay (ADR 0026)

A device paired over the relay is `device:<id>` (id from its Noise static key), and it is a
device like a tailnet node: the same registry rule applies (`ownerDevice`), and a session made for
it is pinned to its device id. It cannot reach the box's sign-in page, so it signs in over the
Noise channel: presence.person.start from a `device:<id>` caller takes only the method `device`,
a proof by the Secure Enclave or Keystore key the relay enrolled for that device at pairing
(relay.device.presence names it; another device's key is refused), and the request-signing key
the app sends. The answer is the token itself, bound to that key; every later request is signed
with `x-vyre-proof` as over the tailnet. A browser paired over the relay (app.vyre.run, no
tailnet) enrolls a passkey (rpId app.vyre.run) at pairing, valid only from that device id, and
signs in with it over the channel the same way: presence.enroll with `device` (the relay module
only), a challenge from that device offering only its passkey, checked against app.vyre.run's
origin, and never offered to anyone else.

### 2c. The native app (vyre://)

The native app returns to `vyre://person/signin` after the box's page. That return is accepted
for PKCE flows only; its code is traded with no Origin, and the trade must be signed by the key it
registers (`x-vyre-proof` over the token request), so an intercepted code and verifier are useless
without the app's hardware key. A web page cannot trade a native code. The phone's
biometric-bound key (vyre.human) rides the native trade (`human`), is enrolled as a device presence
key, and proves HUMAN_ONLY with the same 30-minute presence session as the Mac's Touch ID. The Mac does the same
with a Secure Enclave key (core/link/se) made at `vyre link signin` and enrolled with that
sign-in: link.call signs a human-only tool after Touch ID, for the person's callers only.

### 2d. A device its owner paired opens its person session at pairing

The user's rule is no nagging: Touch ID is for pairing, vault secrets and outbound sends, so a
paired device must not need a second sign-in before it can read its owner's memory. There is one
mechanism, the person session, and the pairing opens it.

- When the owner confirms the pairing of their own phone or computer (the three words, with a
  presence proof), the pairing module asks the presence module for one grant
  (`presence.person.pair-grant`, wink only). The tool trusts none of its arguments: it reads the
  pair record, and writes the grant only if the record says the owner's identity confirmed it,
  the kind is phone or computer, and the key is in secure hardware (or the owner accepted a
  software key at pairing). The confirming key id is the one the presence layer verified in that
  call. A web or setup device, a device paired to a space by someone other than its owner and an
  unconfirmed redeemer never get a grant. A device with a live grant or session is replaced, never
  stacked.
- The grant holds the public key the pairing confirmed and lives 10 minutes. The device's first
  `presence.person.start-paired`, over its own channel, signs `paired-start`, its id, the time and
  a nonce with that key; the grant is consumed in one transaction and becomes a session bound to
  that key. A different key, a second use, another device's channel, a stale or expired grant all
  get the same one refusal. Three wrong tries delete the grant.
- The session slides: 30 days from last use, and it has **no maximum life**. That is safe only
  because it is bound to the device's key and has these ways to end: `presence.person.revoke`
  (at once), removal of the device, removal of its key from the identity list, removal of the
  presence key that confirmed it, a recovery reset and sign-out everywhere (wink calls
  `presence.person.end-paired`), and 30 days unused ("the session has lapsed; sign in again").
- Its secret is replaced at least every 30 days by a rotation the device's key signs
  (`presence.person.rotate`); the old secret stops at once. Last use is written at most hourly and
  shown in the sessions list.
- It unlocks reads and ordinary acts. Everything that needs presence (vault secrets, outbound
  sends and payments, grants) still asks. A device fact alone never means the person: a script on
  the phone is the device too.
- `device:<id>` proves only "a device the relay accepted" until PH-1 (the relay bridges untrusted
  web and setup devices under the same label); the grant row and the key proof carry the trust
  here, and the caller check is a second check.

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
its stdio back as connections. It starts nothing else. The sessions team's driver spawns through
it (spawnClaudeCodeProcess, core/spawner/client.js). Its socket sits in /run/vyre, root:vyre
2750, so it takes vyred's group with no capability to chown, and vyre-agent cannot enter. vyred
runs with umask 002 so the agent can change what it writes in /work; its own files take group
vyre, which the agent is not in. `vyre` in the container drops from root to vyre by itself.
One init (with ADR 0029 R4): tini is PID 1 (no compose `init: true`), the spawner is its child,
the restart loop and vyred run as vyre under the spawner, and each session runs under its own
`tini -s`, a subreaper for that session's tree, never a second PID 1; the spawner adds no init
of its own. scripts/e2e-split/check.sh proves it in a throwaway container, with ci's smoke.

**Known gap (27 Sep 2026): the split is built but off.** `sessions.spawner` is "off" by default,
so Vyre-owned sessions on the box still run as uid vyre, as before the split, and peer.js's
ancestry check (with the process group and session) is what refuses their person-only calls.
Under the split they could not reach vyred's socket, and so would lose the Vyre MCP tools and the
hooks that call vyred, until sessions reach them in process (ADR 0030 phase 3). The split turns on
in the same landing as phase 3. `sessions.spawner: "on"` (or VYRE_SESSIONS_SPAWNER=on) turns it
on before that, for testing.

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

---
title: "ADR 0055: One install line pairs a server"
summary: A server install is one line the creator's identity key signs. The server adopts that person once. An agent issues the line and finishes pairing through the Gate, and never holds the key.
audience: builders
owner: integrator
status: stable
---

# ADR 0055: One install line pairs a server

Status: accepted, 15 Oct 2026 · Workstream: install · Builds on ADR 0051 (the identity chain) and ADR 0050 (the built-in network).

## Context

Adding a server used to mean a code in the terminal, four words to compare, a typed WINK, or a QR. The person had to finish that step by hand. An agent helping with setup could hand over a line and then stop, because the comparison and the key lived only on the person's screen.

The creator's published identity key is the thing that should name the owner. The agent can ask for the line. The agent must not hold the key.

## Decision

**One signed line.** The app, or `wink.install.issue` on the person's computer, mints one code and shows one line.

- Linux: `curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=auto sh`
- A Mac that stays on: `curl -fsSL vyre.run/box/install-mac-server.sh | VYRE_CODE=... VYRE_STORE=auto sh`

The code rides in the environment of `sh`. The installers refuse a `--code` argument and clear `VYRE_CODE` after they read it, so it does not stay in a long-running process list.

**What the code is.** 149 bytes, version 2, base64url without padding (199 characters): expiry (uint32 seconds), a 16-byte nonce, the identity's raw public key (32), the setup secret (16), the setup fingerprint (16), and an Ed25519 signature (64). The signature covers `vyre-pair-install-v1\n` and every field except itself. The person id is derived from the public key (`per_` plus the key id). The code does not carry a name. It expires in 30 minutes (two minutes of clock skew) and is single use. The embedded setup secret and fingerprint are the existing 43-character setup code, so the app can still find the server.

**The server adopts, then the device finishes.** Redeem writes the owner record, sets the pairing target, then calls `spaces.owner.adopt`. A second redeem is refused and the setup page locks. If adopt fails, the owner record is rolled back. After the server is owned, the app (or `wink.install.complete`) enrolls this device. The server auto-accepts that enrollment because the install already named the person.

**The setup page.** When the line is not at hand, vyred serves `http://<the-server>/setup`. The person pastes the code the app shows and chooses Pair. The code is a POST body, never a query string. After pairing, the page stays closed.

**Agents, through one definition.** `wink.install.issue`, `wink.install.status` and `wink.install.complete` are declared once in the wink module, so they are the MCP tool, the HTTP route and the CLI command. `wink.server.install-redeem` is internal: only the relay module on that server may call it.

Issue and complete are person-reach and `outward: true`, and they are open to a proven assistant. A proven assistant is held at the Gate (`held_for_approval`) until the person taps yes. The signing key stays in the identity store on the device. The tool result is the line and the code, never the key. Status is a read of this computer's own record. A hosted key cannot call `wink.*`. An assistant with no thread is refused before the tool runs.

Ask-first is the wrong class here: that path returns a stub and never opens a Gate card, so the agent could not finish. The pair presence moment is not set on these tools, so the presence floor does not take the call before the Gate does.

**Phone pairing is its own path.** Adding a phone still uses that path's own code. This decision is the server install.

**Workstream A.** Redeem trusts the signature and the id derived from the key. A directory check that the key is still the published key for that person id (`spaces.identity.published-key`, by id, not by name) would let a redeem fail closed when the directory disagrees. Until that tool exists, a missing directory does not invent a different person.

## Consequences

- The live Create space flow shows the line and the code. The server installs, adopts the person, and the app finishes pairing.
- An older 43-character setup code is still accepted by the installer and still prints its word screen, so a line from an earlier release keeps working.
- Plain HTTP on the setup page is acceptable: the code is single use, short lived, and signed. The page is not on the public TLS door.

## Proof

`test/install-pair.test.js` mints a code, adopts the signer, refuses a second use and an expired code, and locks the setup page. The installer's own tests cover the line with and without a code.

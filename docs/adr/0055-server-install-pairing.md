---
title: "ADR 0055: One install line pairs a server"
summary: A server install is one line the creator's published identity key signs. The server adopts that person once. An agent issues the line and finishes pairing through the Gate. The person's own app runs the line at once.
audience: builders
owner: integrator
status: stable
---

# ADR 0055: One install line pairs a server

Status: accepted, 16 Oct 2026 · Workstream: install · Builds on ADR 0054 (the master password and the space vault), ADR 0051 (the identity chain) and ADR 0050 (the built-in network).

## Context

Adding a server used to mean a code in the terminal, four words to compare, a typed WINK, or a QR. The person had to finish that step by hand. An agent helping with setup could hand over a line and then stop, because the comparison and the key lived only on the person's screen.

The creator's published identity key is the thing that should name the owner. ADR 0054 names that person by the chain id the master record stores. The agent can ask for the line. The agent must not hold the key. The person's own app already holds the key, so its own issue runs at once.

## Decision

**One signed line.** The app, or `spaces.pair.install` (the Create step) and `wink.install.issue` (the same mint, for an agent), shows one line. Linux and a Mac that stays on use that same line.

- `curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=auto sh`

On a Mac, `i.sh` hands the line to the Mac server installer. The Mac asks for its password once so Vyre starts when the Mac does, with nobody signed in.

The code rides in the environment of `sh`. The installers refuse a `--code` argument and clear `VYRE_CODE` after they read it, so it does not stay in a long-running process list.

**What the code is.** 179 bytes, version 2, base64url without padding (239 characters): expiry (uint32 seconds), a 16-byte nonce, the device's raw public key (32), the setup secret (16), the setup fingerprint (16), the person id (30 bytes, `per_` and 26 characters), and an Ed25519 signature (64). The signature covers `vyre-pair-install-v1\n` and every field except itself. The person id is the identity chain's id from ADR 0054, the id `spaces.identity.self` and `identity.create` return. It is not the device key's id. The code does not carry a name. It expires in 30 minutes (two minutes of clock skew) and is single use. The embedded setup secret and fingerprint are the existing 43-character setup code, so the app can still find the server.

**The published key.** Redeem asks the directory for that person id (`ii/` already maps the chain id to the name, and `GET /v1/ids/resolve?id=` returns the chain). The client re-verifies the chain. The key in the code must be a current full device key on that list. A passkey, and a key the web or the relay holds, does not count. A directory that cannot be reached, a missing id, or a key that is not on the list leaves the server unowned. Nothing is written before that check.

**The server adopts, then the device finishes.** Redeem writes the owner record, sets the pairing target, then calls `spaces.owner.adopt`. A second redeem is refused and the setup page locks. If adopt fails, the owner record is rolled back. After the server is owned, the app (or `wink.install.complete`) enrolls this device. The server auto-accepts that enrollment because the install already named the person.

**The setup page.** When the line is not at hand, vyred serves `http://<the-server>/setup`. The person pastes the code the app shows and chooses Pair. The code is a POST body, never a query string. After pairing, the page stays closed.

**Agents, through one definition.** `wink.install.issue` is the mint. `spaces.pair.install` is the Create step's name, declared on the spaces module, and it calls that mint, so each name is the MCP tool, the HTTP route and the CLI command. The Create step calls `spaces.pair.install` with `kind` (`linux` or `mac`) and reads `command`. An agent calls `wink.install.issue`, `wink.install.status` and `wink.install.complete`. `wink.server.install-redeem` is internal: only the relay module on that server may call it.

Issue and complete are person-reach and `outward: true`, and they are open to a proven assistant. The person's own call runs now and returns the line. A proven assistant is held at the Gate (`held_for_approval`) until the person taps yes. The signing key stays in the identity store on the device. The tool result is the line and the code, never the key. Status is a read of this computer's own record. A hosted key cannot call `wink.*` or `spaces.pair.*`. An assistant with no thread is refused before the tool runs.

Ask-first is the wrong class here: that path returns a stub and never opens a Gate card, so the agent could not finish. The pair presence moment is not set on these tools, so the presence floor does not take the call before the Gate does.

**Phone pairing keeps its own words.** Adding a phone still asks the person to match the words. The published-key check is the same one every other path uses: `spaces.identity.confirm-key`, which calls `assertPublishedKey`. The install line, the setup page, the app, MCP (`spaces.pair.install` and `wink.install.issue`), a phone, a Mac server and Windows (`wink.server.adopt`) all go through that check. `spaces.owner.adopt` calls it again after the pairing record matches, and before the kernel changes owner.

## Consequences

- The live Create space flow shows the line and the code. The server installs, adopts the person, and the app finishes pairing.
- An older 43-character setup code is still accepted by the installer and still prints its word screen, so a line from an earlier release keeps working.
- Plain HTTP on the setup page is acceptable: the code is single use, short lived, and signed. The page is not on the public TLS door.

## Proof

`test/install-pair.test.js` mints a code for a chain person id, adopts that person when the published key matches, refuses a mismatch, an unreachable directory, a second use and an expired code, and locks the setup page. The person's own call is not held. An agent's issue and complete are. The installer's own tests cover the line with and without a code.

---
title: Presence
summary: How Vyre tells a person from a model before a human-only action, which tools need it, and how each surface proves it.
audience: users, builders, agents
owner: docs
status: stable
---

# Presence

Some actions are yours alone: approving what the Gate holds, answering a permission question, releasing a vault value, accepting a lesson, pairing a new Mac. Claude Code runs as your Unix user, so anything it runs can reach vyred's socket and claim to be the CLI. A caller label proves nothing. Presence is the proof that a person is at a device, checked by vyred itself, before one of those tools runs. The design is [ADR 0004](../adr/0004-presence.md).

## What a presence tool does

When a tool needs presence, `vyred` refuses the call unless it carries a valid proof, whoever the caller claims to be:

```json
{ "error": { "code": "presence_required", "message": "...", "methods": ["touchid", "tty"] } }
```

The HTTP status is 403. A proof is bound to one tool and one input (the SHA-256 of the input's canonical JSON), is used once, and expires after 2 minutes. A proof for "approve item A" cannot approve item B.

Before you prove anything, every method shows you the tool's summary: for the Gate, where the message is going and the start of its final words.

## Which tools need it

The floor keeps a fixed list in `core/presence/index.js` (`HUMAN_ONLY`). A module can add a tool to it with `presence: true`, or ask only for some inputs with a `when` function on the tool's presence setting, but it cannot take one away.

- Sending: `gate.approve`, for a send, a payment or a deletion (every Gate kind today; a kind added later asks only if the Gate lists it).
- Vault: `vault.put`, `vault.approve`, `vault.unlock`, `vault.offboard`, `vault.inject`, `vault.totp`, `vault.backup`, `vault.restore`, `vault.delete`, `vault.device.code`, `vault.device.unlock`, `vault.unlock-passphrase`, `vault.reveal`, `vault.copy`, `vault.resolve`, `vault.render`, `vault.session.open`, `vault.kit`.
- Learning: `learn.skill-install`.
- Machines: `link.pair.approve`.
- Presence itself: `presence.enroll`, `presence.remove`, `presence.code`, `presence.session.open`.
- Who else reaches this box: `files.drive.share`, `files.drive.unshare`, `network.guests.add`, `network.guests.remove`, `network.guests.enable`, `hooks.enable`, `hooks.open`, `hooks.close`, `computers.tailnet.set`, `computers.egress.set`.

Your own actions on your own screens ask for no proof (`PERSON_ONLY`): answering Claude's questions and permission asks (`threads.answer`), changing or discarding a held draft (`gate.revise`, `gate.reject`, which send nothing), opening a terminal (`term.open`, `term.attach`), making and changing agents (`agents.create`, `agents.update`), accepting, retiring and relaxing your lessons (`learn.accept`, `learn.retire`, `learn.relax`), taking an agent's computer and handing it back (`computers.takeover`, `computers.giveback`, `glass.take`, `glass.release`), and making one of the box's VyreDrive shares (built on Tailscale's Taildrive) read-only or read-write (`files.drive.access`). Only a person's surface can call them: agents and guests are refused, Claude's sessions cannot name them in a shell command, and vyred refuses a call to one from any process running under a Claude session.

Your assistant may still change an agent's plain fields (name, instructions, model, effort, description) through Vyre's tools. See [Agents](../using/agents.md).

`GET /v1/tools` and `vyre tools` mark these with `presence: true`. [Tools](../reference/tools.md) marks them "needs a person present".

## How each surface proves it

| Method | Where | What you do | Why a model cannot |
|---|---|---|---|
| `touchid` | the Mac | vyred shows the macOS authentication dialog (Touch ID, Watch or password) with the summary as its reason | it cannot press the sensor or type into the system dialog |
| `tty` | a terminal on the Mac | vyred writes the summary and a 6-character code straight to your login terminal; you type the code back | the Bash tool's shell has no controlling terminal, and a `script` or tmux pty is not a login terminal |
| `capsule` | the Capsule | you click; the Capsule signs the call with a key only it can read from the keychain | it cannot read a keychain item whose ACL names only the Capsule |
| `passkey` | the Deck | your device's passkey, with biometric verification | it cannot make a platform passkey assertion |
| `code` | enrolling a passkey | type a one-time code from `presence.code` into the Deck | only `presence.enroll` accepts it |
| `session` | the Deck | a short session opened with a strong proof | only `vault.reveal`, `vault.copy` and `vault.totp` accept it |

The CLI handles `presence_required` itself: Touch ID on a Mac that has it, the terminal code otherwise. It first needs a controlling terminal, so a process without one (the Bash tool) cannot even make a Touch ID dialog appear.

```
vyre call gate.approve '{"id":"h_12"}'   # asks for Touch ID, or prints where to type the code
vyre call --tty gate.approve '{"id":"h_12"}'   # the terminal code, even where Touch ID exists
```

## Enroll your keys

```
vyre presence              # the keys enrolled on this machine
vyre presence code         # a one-time code to enroll a passkey in the Deck
vyre presence remove <id>
```

- The Capsule enrolls its key at first run, with Touch ID.
- On a box, the first passkey comes from onboarding: `onboard.finish` hands you a Deck link carrying a code. A code enrolls a passkey on a box only when the call comes from `tailnet:<owner>`, which is reachable only from another of your devices. The box never takes a terminal code: there, the Deck's passkey is the only proof.

> [!WHY] Why does the box refuse a terminal code?
> A model on your Mac can often `ssh -t` to the box, since the Mac usually holds your SSH key, and get a real terminal there. Inside the box's container, `vyre` reaches vyred through `docker compose exec`, whose terminal no login record lists, so vyred cannot tell your terminal from Claude's. A passkey needs a person at a device.

## Sessions in the Deck

Revealing or copying several vault items one after another would mean a passkey per click. `presence.session.open` (which itself needs Touch ID, a Capsule signature or a passkey) returns a secret that lasts 30 minutes from the proof, used or not, bound to the tailnet node that opened it. A Gate approval can open one too: a send with `x-vyre-presence-keep: 1` and a strong proof gets a session back, so the next sends on that device ask for nothing. It covers revealing, copying, one-time codes, approving and granting vault items, for an item that does not ask every time.

A session serves the Deck and the Capsule. The CLI gets the same 30 minutes its own way, with no secret on disk: after one Touch ID (or a Capsule or passkey proof) from a login terminal, vyred remembers that terminal, and that terminal's reveals, copies, one-time codes, approvals and grants ask nothing until 30 minutes from the proof. vyred names the terminal from the kernel's word on which process connected and which terminal it runs in, never from anything the caller sends. A process under a Claude session, a process with no controlling terminal (the Bash tool, anything detached), and a `script`, tmux or expect pty that `who` does not list never ride it, and a terminal code proves its one call without opening a window. The window lives in vyred's memory, so a restart asks again. A Claude session's MCP tools and an agent are refused, and never asked.

Your own memory and lessons ask nothing: `vyre memory correct`, `merge` and `split`, and `vyre learn accept`, `retire` and `relax`. Their callers lists keep models and agents out.

## What a tool sees

A tool that ran after a proof gets `presence: { method, keyId }` in its second argument. The proof itself never reaches the tool. Events `presence.proved` and `presence.refused` carry the tool, the method and the caller, never a code or a key.

## Who is exempt

- **Module callers** (`module:<name>`). Only the loader makes these, and modules are code you installed. A module that turns an outside event into a presence tool must prove the person itself.
- **A registry built without a verifier.** Only unit tests build one. vyred always builds one.

A tailnet caller is not exempt. `tailnet:<login>` proves the device and the login, not that you are there, and Claude Code on your Mac shares that login.

## What it will not defend

Code running as you can rewrite Vyre itself: edit `core/presence`, restart vyred, or write into `vyre.db`. The Harness floor denies the direct forms of this (reading Vyre's internals, raw socket clients, forged `x-vyre-caller` or `x-vyre-presence` headers, human-only `vyre` commands), but a filter over shell text can always be dodged. The line Vyre holds: a model using Vyre's interfaces (the socket, the CLI, the MCP server) cannot complete a human-only action without a person proving presence after seeing the summary.

On the box, Claude's sessions run as the same uid as vyred and can read `~/.vyre`. Running sessions as a separate uid is not built yet.

## Next

- [The security floor](floor.md): the nine rules presence serves.
- [Tools and events](../build/tools-and-events.md): declaring `presence` on your own tool.
- [The tailnet](tailnet.md): why a tailnet identity is not a person.

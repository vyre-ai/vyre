---
title: Presence
summary: How Vyre tells a person from a model, the three moments that need your yes, and how each surface gives it.
audience: users, builders, agents
owner: docs
status: stable
---

# Presence

Some actions are yours alone. Claude Code runs as your Unix user, so anything it runs can reach vyred's socket and claim to be the CLI. A caller label proves nothing, so Vyre asks two questions in one place (`lib/one-yes.js`): is this call **you** (a verified person surface, never a model, an agent, a module or a guest), and for three moments, is there a fresh **yes** from one of your real devices.

## The three moments

A yes is asked for exactly these, and for nothing else:

- **Pairing, or widening reach.** Adding a device, changing the keys that can give a yes, and what widens what an agent, a module or an outsider can do: `presence.enroll`, `presence.remove`, `presence.code`, `link.pair.approve`, `relay.devices.trust`, `wink.approve`, `spaces.members.set-role`, `projects.access.grant`, `computers.egress.set`, `hooks.enable`, `learn.skill-install`, `appmods.install`, `pluginagent.grant` and the others listed in `MOMENT_OPS.pair` in `lib/one-yes.js`.
- **A vault secret.** Showing, copying or computing a code for one; grants and passes; destroying shared secrets; a bulk import: `vault.reveal`, `vault.copy`, `vault.totp`, `vault.grant`, `vault.approve`, `vault.offboard`, `vault.restore`, `vault.import` and the others in `MOMENT_OPS.vault`.
- **An outward send, post or pay.** A tool marked `outward: true` in its `module.json`, and `gate.approve`. A model's call to one is held as a card until you say yes.

Every other tool that used to ask for a proof (about ninety of them) now needs only that the call is you: a signed-in person session or one of your own surfaces. No proof, no header. Your own actions on your own screens, such as answering Claude's questions, ask nothing (`PERSON_ONLY`).

## What a refusal says

A moment tool called without a yes answers 403:

```json
{ "error": { "code": "presence_required", "message": "...", "moment": "vault",
             "request": { "op": "vault.reveal", "fields": { "name": "mail-token" } },
             "sign": { "op": "...", "space": "spc_...", "fields": {} } } }
```

`request` is exactly what must be approved: the tool and the plain fields of its input (a call with a long or nested input, such as an import, is bound by a digest of the whole input, so one yes covers exactly that call). `sign` is the bytes a device key signs for a direct yes.

## How you give the yes

| Form | Where | What happens |
|---|---|---|
| A card | every client | `approvals.ask { moment, request }` makes a card; your phone shows it and signs it; the client calls again with `x-vyre-approval: <id>`. A card is single use and bound to the exact call and the asking device. |
| Touch ID or a terminal code | the Mac or a computer of your own | `approvals.local-yes { id }` shows the system dialog (or writes a code to your login terminal that you type back). The CLI, the Capsule and the Deck do this first. A server with no screen of its own leaves the card for your phone. |
| A signed yes | a device holding a key enrolled with the sealing process | the device signs `sign` and sends it as `x-vyre-yes`. Single use. A software key counts only on a development build. |

A yes for `vault.reveal`, `vault.copy` or `vault.totp` may ask to be **reused for five minutes** by that device. During the window the same device calls those three tools with no proof; nothing else is covered, no agent ever is, and a restart ends it. There are no 30-minute sessions and no terminal window any more.

## Still the old way

- **Signing in.** `presence.person.start` takes its passkey or device-key proof in `x-vyre-presence`: it authenticates you, it is not an act.
- **Enrolling the first key** with a one-time code or grant (`presence.enroll`).
- **A 0.3.0 client's `x-vyre-presence` header** is checked at the server's edge and turned into a card that goes through the same yes check; each method is logged once as deprecated and the adapter goes in 0.3.2.

## Enroll your keys

```
vyre presence              # the keys enrolled on this machine
vyre presence code         # a one-time code to enroll a passkey in the Vyre app
vyre presence remove <id>
```

On a box, the box never takes a terminal code: there, the card goes to your phone.

> [!WHY] Why does the box refuse a terminal code?
> A model on your Mac can often `ssh -t` to the box, since the Mac usually holds your SSH key, and get a real terminal there. Inside the box's container, `vyre` reaches vyred through `docker compose exec`, whose terminal no login record lists, so vyred cannot tell your terminal from Claude's. A passkey or a card on your phone is the only yes there.

## What a tool sees

A tool that ran after a yes gets `presence: { method, keyId }` in its second argument (`approval`, `yes`, `reuse` or `person`). The yes itself never reaches the tool. Events `presence.proved` and `presence.refused` carry the tool, the method and the caller, never a code or a key.

## Who is exempt

- **Module callers** (`module:<name>`). Only the loader makes these, and modules are code you installed. A module that turns an outside event into a moment must have the person's yes itself.
- **A registry built without a verifier.** Only unit tests build one. vyred always builds one.

A device caller is not exempt for a moment. `device:<id>` proves which device sent the call, not that you are there, and Claude Code on your Mac is on the same device.

## What it will not defend

Code running as you can rewrite Vyre itself: edit `core/presence`, restart vyred, or write into `vyre.db`. The Harness floor denies the direct forms of this (reading Vyre's internals, raw socket clients, forged `x-vyre-caller` or `x-vyre-yes` headers, human-only `vyre` commands), but a filter over shell text can be dodged by a determined enough command.

On a Docker box, the sessions Vyre runs itself (the assistant, agents, chat) run as a separate user, `vyre-agent`, which cannot open vyred's socket or read `~/.vyre`. A Claude Code you start by hand in the container, and any session on a Mac or on a box without Docker, still runs as the same user as vyred.

## Next

- [The security floor](floor.md): the nine rules presence serves.
- [Tools and events](../build/tools-and-events.md): marking your own tool `outward`.
- [Your private network](network.md): why a device identity is not a person.

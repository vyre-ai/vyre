---
title: Run a space's work on your own computer
summary: A member can run a space's AI sessions on their own Mac, Linux or Windows computer instead of the space's server, in a sandbox, inside an encrypted workspace that opens only while the space leases its key, with credentials fetched at the moment of use.
audience: users
owner: sessions
status: draft
---

# Run a space's work on your own computer

Juniper Studio's server is small, and ten people running sessions at once will not fit on it. So a member can run
their own sessions on their own computer. The space stays the source of truth.

## Two yeses, once

Juniper's admin turns on "Members can run our work on their own computers, and through it use the credentials that work needs". The runner holds those credentials in memory while a session runs, so a member who is determined can use them through the runner; they cannot read them, and each credential works only for the methods and paths the space listed. You accept "Use this computer for
Juniper Studio" on your device page, with your limits: only when plugged in, only when awake, a CPU and a memory
ceiling. Either side can take theirs back in one tap. Without both, nothing starts here.

## What runs where

A session picks its place on its own: this computer when it is allowed, awake and has room, else the space's
server, else it waits and says why. The chat shows where it runs ("On Office Mac" or "On the server") and, when it
moved, one line with the reason: "Moved to the server: lid closed."

Your computer tells the space's server it is there every few seconds. If it goes quiet for twenty seconds (the lid
closed, the network dropped, the computer slept), the server takes the session and carries on from the last whole
turn. A computer that was only asleep and wakes later finds it no longer has the session: it stops it and writes
nothing, so no turn is ever run twice. When the lid opens or the computer is plugged in again, the chat offers
"Bring back to this Mac?"; nothing moves back unless you say so.

"Move to the server" in the chat hands a session over after its current turn. Pin a session to the server to keep it
running when you close the laptop. Settings, This computer, holds one switch for letting sessions run here, "only
while plugged in", a processor limit and a memory limit; past a limit a session moves to the server. "Pause all"
freezes everything running on this computer without losing anything.

## What protects the space

- The session runs in a sandbox (macOS seatbelt, Linux bubblewrap). It sees its workspace and the tools it was
  granted, and its network reaches only the AI provider and the space.
- Everything it reads and writes lives in one encrypted workspace. Its key is leased from the space for an hour,
  renewed while your access holds, and kept in memory only. When the lease ends the workspace locks. When you are
  removed from the space it is deleted the next time this computer reaches the space.
- Credentials are fetched from the space's vault at the moment of use and put into the outgoing request, only for the
  methods and paths the space listed. Anything that changes something outside is held for approval. No `.env` file
  exists, and the session and the model never see the secret.
- The runner's own bookkeeping sits outside the folder the session can see. If the runner is killed, a watchdog closes
  the workspace; "locked" is only said once the workspace is really closed. A laptop that slept needs a fresh lease.
- The transcript and files stream to the space as they change, and every turn is a checkpoint, so a session
  continues on another computer or on the server from its last turn.

## Limits

File names are encrypted but file sizes, counts and times are not hidden by this encryption. If this computer uses swap or hibernation, the contents of an unlocked workspace can be written to disk outside it; Vyre tells you once and you can turn swap off or encrypt it. On Linux, only file permissions (owner-only folders) protect an unlocked workspace from other users on the same computer.

A session reaches the internet only if the space allows it; if it does, its traffic leaves from this computer's connection, never to this computer's own network (private and local addresses are refused).

## Your network limit

When you lend a computer you choose how far its sessions may reach: only the AI provider (`provider`), or the provider and the internet the space allows (`internet`). The space can never give a session more than you allowed; the limit you and the space each set, the tighter one wins.

- The limit is yours and it only tightens by itself. If you stop lending a computer and lend it again without saying a limit, it keeps the limit it had. You cannot widen it by leaving it out.
- To widen it, say so: lend again and confirm the looser limit. That is your own act, so it asks for nothing more. An assistant that tries to lend your computer with a looser limit waits for your one yes first.
- Lending is the only yes it takes. After you turn "Run on this computer" on, your computer gets its key without asking you again, only while both sides still allow it: stop lending, or have the space take the computer away, and the next request is refused. Your computer says its own limit with each request, and the server only ever uses the tighter of that and what you allowed. The space's timeline shows each time your computer borrows its key.


You can read what your session can read. This protects against loss, theft and access after removal, not against
a member copying data on purpose. A computer that was open at the moment of removal can read until its lease ends
(at most an hour). Phones and tablets do not run sessions.

## Linux note

On Linux, Vyre encrypts the workspace with the kernel's own file encryption when the disk is ext4 (about as fast as a plain folder). Setup turns that on once with administrator rights (`tune2fs -O encrypt <device>`). On other disk formats it uses a slower method and says so.


Ubuntu 24.04 blocks the user namespaces bubblewrap needs. Install a profile that allows `userns` for
`/usr/bin/bwrap` (an AppArmor profile named bwrap-vyre), plus `bubblewrap`, `gocryptfs` and `fuse3`. Vyre shows the
reason on the device page when one is missing.

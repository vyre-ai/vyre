---
title: Run a space's work on your own computer
summary: A member can run a space's AI sessions on their own Mac, Linux or Windows computer instead of the space's server, in a sandbox, inside an encrypted workspace that opens only while the space leases its key, with credentials fetched at the moment of use.
audience: users
owner: sessions
status: draft
---

# Run a space's work on your own computer

Harlow Legal's server is small, and ten people running sessions at once will not fit on it. So a member can run
their own sessions on their own computer. The space stays the source of truth.

## Two yeses, once

Harlow's admin turns on "Members can run our work on their own computers". You accept "Use this computer for
Harlow Legal" on your device page, with your limits: only when plugged in, only when awake, a CPU and a memory
ceiling. Either side can take theirs back in one tap. Without both, nothing starts here.

## What runs where

A session picks its place on its own: this computer when it is allowed, awake and has room, else the space's
server, else it waits and says why. A line on the session says "Running on this Mac", with "Move to server".
Pin a session to the server to keep it running when you close the laptop.

## What protects the space

- The session runs in a sandbox (macOS seatbelt, Linux bubblewrap). It sees its workspace and the tools it was
  granted, and its network reaches only the AI provider and the space.
- Everything it reads and writes lives in one encrypted workspace. Its key is leased from the space for an hour,
  renewed while your access holds, and kept in memory only. When the lease ends the workspace locks. When you are
  removed from the space it is deleted the next time this computer reaches the space.
- Credentials are fetched from the space's vault at the moment of use and put into the outgoing request. No `.env`
  file exists, and the session and the model never see the secret.
- The transcript and files stream to the space as they change, and every turn is a checkpoint, so a session
  continues on another computer or on the server from its last turn.

## Limits

You can read what your session can read. This protects against loss, theft and access after removal, not against
a member copying data on purpose. A computer that was open at the moment of removal can read until its lease ends
(at most an hour). Phones and tablets do not run sessions.

## Linux note

Ubuntu 24.04 blocks the user namespaces bubblewrap needs. Install a profile that allows `userns` for
`/usr/bin/bwrap` (an AppArmor profile named bwrap-vyre), plus `bubblewrap`, `gocryptfs` and `fuse3`. Vyre shows the
reason on the device page when one is missing.

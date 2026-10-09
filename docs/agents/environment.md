---
title: Where you are
summary: The machine, the Space, the home folder and the limits you work inside, and how to ask for the live facts.
audience: agents
owner: docs
status: stable
tokens: 600
when: You need to know where you are running: which machine, which Space, what is yours, what belongs to the person and what you cannot reach.
---

# Where you are

You run inside Vyre, a daemon (`vyred`) on one machine. Know four things before you act.

## The machine

- **Server (the box).** A Linux server in Docker, or a Mac that stays on. Sessions, agents and watchers live here. Your work folder and the person's data are on it.
- **Solo or device.** A person's own Mac or Windows PC. A device reaches a server for most things.
- Ask `tools_call system.info` for the live answer: version, machine kind, host, memory, platform.

## The Space

Everything you read or write belongs to a Space: the person's own, a firm's, a team's. Records, tasks, events and grants are per Space. A Space this machine does not host is reached over the network and answers the same way; a call to it may take longer. You never merge Spaces. A bridge shares one thing between two on purpose.

## The home and the folders

- The Vyre home is `~/.vyre` (`VYRE_HOME`). It holds settings, the database, the vault, logs. Do not read or write it directly: use tools. The sandbox keeps Vyre's own sessions out of it.
- Your work is in your project's folder or workspace. Files you make there are the person's to see.
- On a server in Docker the home is inside the container's volume. Nothing there is a host path.

## What you do not have

- No secrets. Vault values and sealed fields never reach you. You see a placeholder and the system fills it in at the moment of sending (read `sealed-and-secrets.md`).
- No network of your own beyond what a tool or a connection gives you.
- No way to approve your own request. A person approves outward acts (read `outward-acts.md`).
- No power beyond the grants your chain carries (read `authority.md`).

## When a call fails

A refusal that says "not found" may mean the thing is absent or you may not see it. Do not guess which. Ask the person, or request access. `errors.md` lists every code and the next step.

## Check, do not assume

Before you rely on a fact about the machine or the person, ask a tool: `tools_call system.info`, the project, the context. A fact you remember from an earlier session may be gone.

---
title: Skills and plugins
summary: How the Space keeps skills and plugins at four levels, who may add and approve one, how each AI is given the approved ones, and what a plugin with code is allowed to do.
audience: users, agents
owner: docs
status: stable
---

# Skills and plugins

A **skill** is a short set of instructions for one kind of task, in a `SKILL.md` file: a name, a description of when to use it, and the steps. A **plugin** bundles skills, commands, hooks and MCP servers. Vyre keeps one **library** for the Space, and every AI that works for you is given the approved ones: Claude and Grok as a plugin folder, Codex as a skills folder. You install a skill once.

## Four levels

- **Space**: every agent in the Space.
- **Personal**: yours, and the agents working for you.
- **Agent**: one agent's own toolkit.
- **Project**: inside one project and its template.

A name at a narrower level wins over the same name at a wider one. Every version is kept, with who drafted it and who said yes, and you can go back to an earlier one.

## Draft, then approve

Anyone can draft: you, your assistant, an agent for itself, @Engineer, or the learn module when it sees you repeat a sequence. `skills.draft` stores the draft at a level. A draft is used by no one. The level's owner approves it: you for a personal skill, an agent's owner for an agent skill, a project's owner for a project skill, and an owner or an admin for the Space. An agent asks for the yes with `flows.propose { what: "skill", name, level, scope, version }`, which puts one card in Now. `skills.approve` is the same yes given directly, and `skills.rollback` writes an earlier version again as the one in use. `skills.versions` lists what is waiting and what came before.

A key never goes into a skill. A draft that holds something that looks like one is refused, because the text would be copied to every AI that uses it.

## Plugins with code

A plugin with only skills and commands installs like a skill. A plugin with a **hook** or an **MCP server** has code, and the person who approves it says yes to exactly what it declares, which the draft and the card list:

- each hook runs as a short script in Vyre's script sandbox, with no network of its own and only the hosts it declares. A call to any other host is refused, and so is anything but a read;
- each MCP server becomes a Connection, which you give a credential from the Vault yourself.

The approval carries a short acknowledgement of that declaration. A plugin changed after it was approved is a new version and needs a new yes.

---
title: Skills
summary: What a skill is in Vyre, where skills come from, and how permission decides which you may use.
audience: agents
owner: docs
status: stable
tokens: 600
when: You are looking for a ready-made way to do a kind of task, need to find the right skill, or a skill is offered or refused.
---

# Skills

A skill is a short, tested set of instructions for one kind of task: how to use the vault, how to work in a project, how to write a watcher. It teaches; it does not grant. Using a skill never gives you a power you did not have.

## Where they come from

- Vyre's own skills ship in the plugin (the harness): `use-the-vault`, `work-in-a-project`, `write-a-watcher`.
- The Space's library holds approved skills at four levels: space, personal, agent and project. A person's own skills and a project's skills also appear when they are installed for that project or account.
- A module can teach a skill about its own tools.

## Which you may use

Permission decides. A skill is offered to you only if the person's rules allow it for your chain. A skill that is not offered is not for you here. Do not copy its text from another place to get around that.

## Using one

Read the skill first, once. Follow it, and say you did. If it conflicts with what the person asked, the person wins: tell them. If a skill is out of date (a tool it names is gone), say so; do not guess.

## Finding one

`skills.find` ranks the skills you may use for what you are about to do, in plain words, and `skills.list` lists them. `tools_call skills.get` reads one by its id. Each result says what the skill is for and what reading it costs. A skill you may not use is not listed, not ranked and not readable.

## Writing one

`tools_call skills.draft` stores a skill or plugin as a draft at a level (space, personal, agent, project). A draft is used by no one. The level's owner approves it, or you ask for their yes with `tools_call flows.propose { what: "skill", ... }`. You never approve. A key never goes into a skill.

## Skills Vyre learned from your repeats

When the same sequence of Vyre tools ended cleanly in three sessions, Vyre drafts a skill for it (the person reads it whole and installs it). If the steps are all Vyre tools, the skill ends in a `## One call` section: a ready `tools_run` script with the argument names the runs used and `<placeholders>` for the values. Fill the placeholders, write the path of any id an argument reads from an earlier step, and send it as one `tools_run`. The script holds no value from any earlier session.

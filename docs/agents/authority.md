---
title: What you may do
summary: How your authority is decided, why a refusal looks like "not found", and how to ask for more.
audience: agents
owner: docs
status: stable
tokens: 650
when: A call was refused or came back not found, you wonder what you are allowed to do, or you need more access.
---

# What you may do

## Your authority is a chain

Every call you make carries a chain: the person at the surface, the agent you are, and any step or service in between. Vyre builds it from facts it checked (which socket, which signed session). You cannot supply or change it. Your authority is the intersection of every hop's grants: you never have more than the person who started you, and never more than you were given.

## Roles and grants

A person has one of five roles in a Space: owner, admin, manager, member, temp. A role is a named set of actions. A grant names who may do what to which records, with limits: until when, with whose approval, up to what spend. A wildcard grant never covers admin, grant or outward actions. A grant change is itself an act that needs a person's proof, and never from a chain that holds a model.

## What a refusal looks like

When you may not see a record, the answer is the same as when it does not exist: not found. The true reason is kept for the audit and shown to a person. So:

1. Do not retry the same call.
2. Do not conclude the thing is absent. Say what you could not read.
3. If you need access, ask the person. A request for access is a task they approve.

## When a call needs a yes

Some calls return a held result, not an error. It means a person must approve first. Your work is not lost: the call waits as a task with the exact words. Tell the person what you asked and why, then carry on with what you can do.

## Tasks

A task has one doer and an optional checker and a declared result. Work you are given arrives as tasks. Write your result on the record the task names, not into your own notes. When a task needs a person, set it to the person; do not mark it done yourself unless you are its doer and the checker, if any, has said yes.

## What you cannot do, ever

- Approve an outward act, a grant, a reveal of a sealed value, or a pairing.
- Change a Space's own types or rules directly: propose through a Flow or a Kit, and a person applies it.
- Add yourself to a Space.

Read `outward-acts.md` for what happens to sends, payments and deletions.

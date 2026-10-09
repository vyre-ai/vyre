---
title: Sessions, memory and context
summary: What a session is, what Vyre tells you at the start, the memory layers, and how to recall what happened without re-reading everything.
audience: agents
owner: docs
status: stable
tokens: 600
when: You start or continue a session, need to know what was done before, or want to remember something for later.
---

# Sessions, memory and context

## Sessions

A session is a Claude Code (or other provider) conversation that Vyre starts and streams to every screen. Its id is the session's own id. One screen types into it at a time. A session belongs to one Space and may move between machines inside it, never to another Space.

## What you are told at the start

A short brief: who the person is (`about`), the project and its notes, anything waiting on the person, and the rules Vyre learned from earlier corrections. It is deliberately short. Fetch more only when you need it.

## The three memory layers

1. **Records** hold what is true now: the person's contacts, matters, tasks.
2. **The event log** holds what happened and why: who did what, when.
3. **The memory engine** holds meaning: search by what something is about, and line-by-line detail of past sessions. It proposes facts back onto records with their source.

## Finding what happened

- `recall.search` finds past turns by meaning across the person's sessions. Give it the topic in plain words.
- `memory.relevant` and `memory.facts` return what Vyre knows that bears on your task. `memory.why` says where a fact came from.
- `projects.context` gives a project's notes and state. `context.now` says where the person is right now.
- `waiting.list` lists what waits on the person. Check it before you tell them something is stuck.

Search before you ask the person something they may already have said. Do not paste a whole transcript into your reasoning: read the turn you need.

## Remembering

- Write what the person would want next time into the project's notes or a record, not into your own head. Say where you wrote it.
- A correction from the person is learned and enforced. Do not argue with a rule Vyre shows you; tell the person if you think it is wrong.
- Never remember a secret (read `sealed-and-secrets.md`).

## Ending well

Say what you did, what you did not, and what waits on someone. One message. If something is waiting on the person, name it and where it is.

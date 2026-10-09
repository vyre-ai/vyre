---
title: Sessions, memory and context
summary: What a session is, what Vyre tells you at the start, the memory layers, and how to recall what happened without re-reading everything.
audience: agents
owner: docs
status: stable
tokens: 800
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
- `tools_call memory.relevant` and `tools_call memory.facts` return what Vyre knows that bears on your task. `tools_call memory.why` says where a fact came from.
- `tools_call projects.context` gives a project's notes and state. `context.now` says where the person is right now.
- `waiting.list` lists what waits on the person. Check it before you tell them something is stuck.

Search before you ask the person something they may already have said. Do not paste a whole transcript into your reasoning: read the turn you need.

## When your window is rolled over

Vyre ends a long session between turns, before its window fills, and starts a fresh one whose first message is a block of data, not instructions. Besides the person's decisions, the plan and the last turns word for word, it points to what Recall and memory hold. (A fuller seed with a line per tool call and a ledger of the ids those calls returned exists but is off until a run shows it helps; do not expect it.) Read a thing back (`memory_turn`, `memory_search`) before you rely on it.

## Remembering

- Write what the person would want next time into the project's notes or a record, not into your own head. Say where you wrote it.
- A correction from the person is learned and enforced. Do not argue with a rule Vyre shows you; tell the person if you think it is wrong.
- Never remember a secret (read `sealed-and-secrets.md`).

## Ending well

Say what you did, what you did not, and what waits on someone. One message. If something is waiting on the person, name it and where it is.

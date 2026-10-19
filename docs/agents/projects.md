---
title: Working inside a project
summary: What a project is, where its files, threads and memory are, and how to stay inside it.
audience: agents
owner: docs
status: stable
tokens: 400
when: Your session is in a project, a person names a client or a project, or you are unsure which project a piece of work belongs to.
---

# Working inside a project

A project is one record. Its session records, Drive folder, repository, memory and client hang off it or point at it. `work.situation` names the one you are in.

## Stay in scope

- Use the current project's files, threads and memory. Information from one client's project never goes into another client's work, even when it would help.
- When you cannot tell which project a request belongs to, ask.
- The person picks sessions into projects. Do not move or remove a pick yourself.

## Where things are

- Files you make for the person go in `$VYRE_ARTIFACTS_DIR`, at the top level. Vyre keeps what is saved there in the project's Drive folder. Do not put secrets there.
- Find files with `files.search` and read one with `files.preview`.
- Earlier work: `recall.search` searches past sessions by what was said. Use it before asking the person to repeat something.
- Facts about people, addresses and domains are in memory. When you rely on one, say where it came from and check anything that may have changed.

The skill `work-in-a-project` walks through finding the project, its brief, its threads and its memory.

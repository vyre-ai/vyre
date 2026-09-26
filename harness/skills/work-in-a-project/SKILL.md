---
name: work-in-a-project
description: Use when the user refers to a project, client, past session or earlier decision ("the Harlow site", "what did we decide", "last time", "pick up where we left off"), or when starting work in a folder that belongs to a Vyre project. Finds the right project, its threads and its memory before answering.
---

# Work in a project

In Vyre a **project** is a home folder, the other folders it owns, the threads (Claude Code
sessions) picked into it, its people and its watchers. A session can belong to several projects.
The user picks sessions into projects by hand; never move or remove a pick yourself.

## Find context before you guess

1. **Which project:** `projects_of` with the current folder. If it returns nothing and the user
   named a client or project, check `projects_list`.
2. **The brief:** `projects_context` returns what the project is, its people, folders and
   threads. It was probably added at the start of this session already; don't fetch it twice.
3. **Past work:** `recall_search` searches every past session by what was said. Use it before
   asking the user to repeat something. Pass the project's folders to keep results inside it.
   `recall_thread` reads a whole earlier thread.
4. **Facts:** `memory_facts` for people, addresses, domains and links. Memory comes with its
   source; when you rely on a fact, say where it came from ("from the Harlow site rebuild
   thread, 3 weeks ago") and check anything that may have changed since.

## Keep projects apart

Use only the current project's threads and memory. Information from one client's project never
goes into another client's work, even when it would help. When unsure which project a request
belongs to, ask.

## When the user wants to change the project

- Add or remove threads: `projects_add-threads`, `projects_remove-threads`, only on request.
- New project: suggest `vyre new`, which lets them search the catalogue and pick sessions.

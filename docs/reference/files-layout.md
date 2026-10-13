---
title: Files layout
summary: Where everything lives under a Space's files root, and the one module that says so.
audience: builders
owner: platform
status: stable
---

# Files layout

Files hold nothing unstructured. Everything has its own place, and `lib/files/layout.js` is the only code that builds those places. A writer asks it for a folder and never spells a path by hand.

```
<files root>/
  Projects/<project record id>/
    files/                      the project's own files
    chat/<chat id>/             a chat's folder
    made/<chat id>/             what a chat made
  agents/<agent id>/
    instructions/
    context/
    memory/
    work/
  objects/<object>/<record id>/ a record's attachments
  templates/<template id>/
  flows/<flow id>/              only for a flow that keeps files
  space/                        the Space's own documents
```

## Rules

- A folder is named by an id that never changes. A rename changes the display name in the record and moves nothing.
- `Projects` keeps its capital letter and its record id. Every existing project, its access guard and its seal already use that folder, so it is the canonical one. The other roots are new.
- An object is named by its slug (lowercase letters, digits, hyphens). Every other segment is an id of letters, digits, `_` and `-`, at most 64 characters. A segment with a slash, a dot at the start or a space is refused.
- `whereIs(path)` reads a path back into what it is (project, agent, record, template, flow, space) or answers null.

## Old places

Nothing moves. A writer that used a different place keeps reading it and writes new files to the canonical one. Today:

- The agent page keeps an agent's context under `agents/<uid>/context` and its instructions in `agents/<uid>/CLAUDE.md`. Reading `CLAUDE.md` stays; new instruction files go to `agents/<uid>/instructions/`.
- `work.start-project` writes the project's Drive folder with `projectDir`, the same path as before.

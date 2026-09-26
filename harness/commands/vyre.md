---
description: Vyre status, the current project, or a search of past sessions
argument-hint: "[status | project | recall <query>]"
---

The user ran `/vyre $ARGUMENTS`.

- No arguments or `status`: call the `system_info` tool and `projects_of` with the current folder,
  then say in two lines what this machine runs and which project this folder is in.
- `project`: call `projects_context` for the current folder's project and show it as is. If the
  folder is in no project, say so and mention `vyre new`.
- `recall <query>`: call `recall_search` with the query. Show up to eight hits, one line each:
  the thread's name, how long ago, and the matching words. Offer to open a thread with `recall_thread`.

If a tool is missing, Vyre's daemon or that module is not running: say `vyre up` starts it.

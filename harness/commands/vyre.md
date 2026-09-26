---
description: Vyre status, the current project, a search of past sessions, or a lesson to remember
argument-hint: "[status | project | recall <query> | remember <text> | lessons]"
---

The user ran `/vyre $ARGUMENTS`.

- No arguments or `status`: call the `system_info` tool and `projects_of` with the current folder,
  then say in two lines what this machine runs and which project this folder is in.
- `project`: call `projects_context` for the current folder's project and show it as is. If the
  folder is in no project, say so and mention `vyre new`.
- `recall <query>`: call `recall_search` with the query. Show up to eight hits, one line each:
  the thread's name, how long ago, and the matching words. Offer to open a thread with `recall_thread`.
- `remember <text>`: call `learn_add` with `{"text": "<text>"}`. Say in one line the lesson it
  made and whether it is checked (a check means hooks enforce it) or a reminder.
- `lessons`: call `learn_lessons` and show each lesson on one line: its id, rule, level and its
  applied, caught and broken counts. Retiring or changing one is the user's call: point them at
  `vyre learn retire <id>` rather than calling `learn_retire` yourself.

If a tool is missing, Vyre's daemon or that module is not running: say `vyre up` starts it.

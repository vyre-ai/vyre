---
description: Vyre status, ask an agent, type into a session, search past sessions, the current project, or a lesson to remember
argument-hint: "[status | ask <agent> <text> | send <session> <text> | recall <query> | project | remember <text> | lessons | statusline]"
---

The user ran `/vyre $ARGUMENTS`.

- No arguments or `status`: call `system_info`, `projects_of` with the current folder, and
  `agents_list`, then say in at most three lines what this machine runs, which project this
  folder is in, and what the assistant and each agent is doing. If `gate_held` or `threads_asks`
  has anything, add one line: how many things need the user, and that the Deck or the Capsule
  answers them.
- `ask <agent> <text>`: call `agents_ask` with `{"agent": "<agent>", "text": "<text>"}` and show
  the reply as the agent wrote it, under its name. If it came back with a permission question
  instead, show the question and say the user answers it in the Deck, the Capsule or
  `vyre threads`. With no text, ask what to say. With no agent, call `agents_list` and show the
  names.
- `send <session> <text>`: `<session>` is a thread id, its first 8 characters, or its name. Call
  `threads_list` to find it (say so and stop if none or several match), then `threads_send` with
  `{"thread": "<full id>", "text": "<text>"}`. Say in one line that it was typed into that
  session; the reply streams there, not here.
- `recall <query>`: call `recall_search` with the query. Show up to eight hits, one line each:
  the thread's name, how long ago, and the matching words. Offer to open a thread with `recall_thread`.
- `project`: call `projects_context` for the current folder's project and show it as is. If the
  folder is in no project, say so and mention `vyre new`.
- `remember <text>`: call `learn_add` with `{"text": "<text>"}`. Say in one line the lesson it
  made and whether it is checked (a check means hooks enforce it) or a reminder.
- `lessons`: call `learn_lessons` and show each lesson on one line: its id, rule, level and its
  applied, caught and broken counts. Accepting, retiring or loosening one is the user's call, and
  you cannot do it: a proposed lesson is kept when the user answers a plain yes, and dropped on a
  plain no. For the rest, point them at `vyre learn accept|retire|level <id>` in their own terminal.
  Never call `learn_accept`, `learn_retire` or `learn_relax`.
- `statusline`: a plugin cannot set Claude Code's status line, so tell the user to run
  `vyre statusline install` in their own terminal. It asks first, and if they already have a
  status line it changes nothing unless they add `--chain`, which keeps theirs and adds Vyre's
  line under it. Do not run it for them and do not edit their settings.json.

If the `vyre` MCP server has no tools at all, Vyre is not running here: its instructions say
whether it is not installed (`npm install -g vyre && vyre up`) or only stopped (`vyre up` starts
it). Say that in one line and stop. If just one tool is missing, that module is not running.

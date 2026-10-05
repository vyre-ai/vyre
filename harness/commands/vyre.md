---
description: Vyre status, todos and reminders, your agenda, what to remember, ask an agent, type into a session, search past sessions, or the current project
argument-hint: "[status | todo <text> | remind <when> <text> | agenda | remember <fact> | ask <agent> <text> | send <session> <text> | recall <query> | project | lesson <rule> | lessons | statusline]"
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
- `todo <text>`: call `planner_add` with `{"text": "<text>", "kind": "todo"}`. With no text, call
  `planner_list` with `{"kind": "todo"}` (the open ones) and show one title a line. Say in one line what was added.
- `remind <when> <text>`: call `planner_add` with `{"text": "remind me <when> <text>"}`, the user's
  words as they typed them ("remind me 6pm call Harlow Legal", "remind me in 20 minutes check the
  oven"); the planner reads the time itself. Say in one line what it will say and when, from the
  `title`, `date` and `wall` it returned (the planner's local time). If it comes back with an
  error because there is no time, ask for one.
  Never say a reminder is set unless `planner_add` returned it.
- `agenda`: call `planner_agenda` with `{}` (today). Show its `entries` first, one line each with
  the local time of `at` in its `tz`, then the `todos` (due by then, overdue ones too). Nothing on: say so in one line.
  `agenda tomorrow` (or another day) passes `{"from": "YYYY-MM-DD"}` for that day.
- `remember <fact>`: a fact about the user or their work, for every future session. Call
  `memory_remember` with `{"text": "<fact>"}` and say in one line that it is remembered. If
  `memory_remember` is not offered, or refuses (a session scoped to some projects cannot teach
  personal facts), say so in one line and offer to make it a lesson with `/vyre lesson` instead.
- `lesson <rule>`: call `learn_add` with `{"text": "<rule>"}`. From a session it makes a
  PROPOSED lesson, not an active one: say in one line the rule it proposed and whether it would be
  checked (hooks enforce it) or a reminder, and that it takes effect only when the user accepts
  it with `vyre learn accept <id>` in their own terminal. Never say it is in force.
- `lessons`: call `learn_lessons` and show each lesson on one line: its id, rule, level and its
  applied, caught and broken counts. Accepting, retiring or loosening one is the user's call, and
  you cannot do it: a plain yes typed here does not keep a lesson. The user keeps or drops one with a tap in the Vyre app, or with
  `vyre learn accept|retire <id>` in their own terminal. For the rest, point them at `vyre learn accept|retire|level <id>` in their own terminal.
  Never call `learn_accept`, `learn_retire` or `learn_relax`.
- `statusline`: a plugin cannot set Claude Code's status line, so tell the user to run
  `vyre statusline install` in their own terminal. It asks first, and if they already have a
  status line it changes nothing unless they add `--chain`, which keeps theirs and adds Vyre's
  line under it. Do not run it for them and do not edit their settings.json.

If `planner_add`, `planner_list` or `planner_agenda` is not offered, the planner is not running on this machine
yet: say so in one line and do not pretend to set anything.

If the `vyre` MCP server has no tools at all, Vyre is not running here: its instructions say
whether it is not installed (https://vyre.run/start) or only stopped (`vyre up` starts
it). Say that in one line and stop. If just one tool is missing, that module is not running.

---
title: Projects and threads
summary: How Vyre groups your Claude Code sessions into projects, what a new thread in a project is told, and how to pick, resume and start threads from each surface.
audience: users, agents
owner: docs
status: stable
---

# Projects and threads

A **thread** is a Claude Code session. A **project** is a home folder, the other folders it owns,
the threads in it, its people and its watchers. Vyre uses projects to decide what a thread is
told when it starts (the project's **brief**) and which memory it may draw on. Nothing from one
project's threads or memory reaches another project's brief, so two clients' work stays apart.

A thread belongs to a project in one of two ways:

- **Picked**: you put it there. A pick is written into the project's marker file and only a
  person removes it. One thread can be picked into several projects, for example a weekly
  planning session that covers Harlow Legal and Northwind Bakery.
- **By folder**: it ran in one of the project's folders. This is worked out on every read, so
  adding a folder to a project brings that folder's sessions with it.

Vyre never sorts threads into projects on its own. You make every project by hand.

## Where a project lives

A project is declared by one file, `<home>/.vyre/project.json`. The file is the truth; Vyre's
database only caches it, so you can move the folder, edit the file by hand or commit it to the
project's own repository.

```json
{
  "name": "Harlow Legal",
  "org": "Harlow Legal",
  "workspaces": ["../harlow-site"],
  "threads": ["<claude session id>"],
  "people": [{ "name": "Dana Reyes", "email": "dana@harlowlegal.com" }],
  "watchers": ["harlow-invoices"]
}
```

Paths are relative to the home folder. New projects are made in `projectsDir` (default
`~/Vyre/projects`), and Vyre also looks for markers under `roots`. Sessions come from the folders
in `transcripts` (default `~/.claude/projects` and `~/.claude/projects-archive`). See
[configuration](../reference/config.md).

## Make a project

From the terminal, `vyre new` walks you through it: a name, a home folder, and the sessions to
pick from the catalogue of every session on this machine.

```
vyre new "Harlow Legal"
```

Every step has a flag, so a script or an agent can do the same without prompts:

```
vyre new "Harlow Legal" --home ~/work/harlow --workspace ~/work/harlow-site \
  --person "Dana Reyes <dana@harlowlegal.com>" --org "Harlow Legal" --no-pick
```

In the Deck, open **Projects** (`/projects`) and choose **New project**. Claude can call
`projects.create`.

## Find a session and pick it into a project

The **catalogue** lists every session on this machine with its `/rename` name, first message,
folder, last activity and the projects it is in. It is searchable by what was said.

```
vyre threads harlow invoice        # search sessions by what was said
vyre threads --project harlow-legal
vyre pick harlow-legal 3f2a9c1e    # pick one or more threads into a project
vyre unpick harlow-legal 3f2a9c1e  # remove a pick
```

`vyre unpick` removes only picks. A thread that ran in the project's folders stays in the project
by folder, and the command says so.

In the Deck, a session in no project opens at `/threads/<thread>` with **Add to a project**. The
tools behind these are `projects.catalog`, `projects.add-threads` and `projects.remove-threads`.

## See a project and its brief

```
vyre projects                 # every project, newest activity first
vyre open harlow-legal        # what its threads are told, and its threads
vyre context harlow-legal     # only the brief
```

The brief is short on purpose: what the project is, its people, what its other threads have been
doing, and headlines from the project's memory. A thread asks for more when it needs it. The
Harness's SessionStart hook prints the brief into every thread that starts in a project folder;
`vyre resume` and `vyre start` pass it to Claude Code with `--append-system-prompt`. The tool is
`projects.context`.

In the Deck, `/projects/<slug>` is the project board: threads and the brief on the left, the open
thread in the centre, and the files it touched on the right, with tabs for the brief, files and
memory.

## Resume a thread or start a new one

```
vyre resume 3f2a9c1e          # opens it in Claude Code, in the folder it ran in, with the brief
vyre start                    # a new thread in this folder's project
vyre start --project harlow-legal "Draft the engagement letter"
```

`vyre resume` runs `claude --resume` in the folder the thread ran in, because Claude Code finds a
transcript by that folder. Your terminal belongs to Claude Code until it exits.

## The `vyre` home

`vyre` with no arguments, from any folder, opens the home: every project with its thread count
and last activity, **New session without a project**, and your agents. Pick a project to see its
sessions, newest first, and resume one or start a new one. Inside a project's folder that project
is preselected, not opened. It is an arrow-key list with type-to-filter in a terminal, a plain
list when piped, and works the same over SSH. See [agents](agents.md) for the agents half.

## Headless threads

vyred can also run a thread itself, headless, so it outlives every window. Any surface can watch
it, and one surface at a time holds its keyboard.

```
vyre threads start --project harlow-legal "Summarise this week's invoices"
vyre threads send 3f2a9c1e "Now draft a reply to Dana"
vyre threads watch 3f2a9c1e
vyre threads answer <ask> allow   # answer a permission question
vyre threads stop 3f2a9c1e
```

A permission question from a headless thread goes to wherever you are: the terminal, the Deck,
the Capsule or your phone. Only a person answers it (`threads.answer`); a model never approves a
permission. The tools are `threads.start`, `threads.send`, `threads.lease`, `threads.release`,
`threads.asks`, `threads.answer` and `threads.stop`.

## Which surface does what

| Task | Terminal | Deck | Capsule | Chat | Claude |
| --- | --- | --- | --- | --- | --- |
| List projects | `vyre projects`, `vyre` | `/projects` | `@` a project | `/chat` | `projects.list` |
| Make a project | `vyre new` | New project | | | `projects.create` |
| Pick threads | `vyre pick`, `vyre unpick` | Add to a project | | | `projects.add-threads` |
| Search sessions | `vyre threads <words>` | the search box in the header | `@` a thread | | `projects.catalog`, `recall.search` |
| Read the brief | `vyre context` | Brief tab | | | `projects.context` |
| Resume or start | `vyre resume`, `vyre start` | open a thread | `@` a thread, then Enter | `/chat/<project>/<thread>` | `threads.start` |

Inside a Claude Code session, `/vyre project` shows the current folder's brief.

## What it will not do

- Sort sessions into projects by topic. Projects and picks are yours.
- Remove a pick on its own. Only `vyre unpick` or `projects.remove-threads` does.
- Put one project's threads or memory into another project's brief.

## Next

- [Memory](memory.md): search what was said, and the facts each project remembers.
- [Watchers](watchers.md): file things from outside into a project.
- [Chat](chat.md) and the [Deck](deck.md).
- Every tool: [projects](../reference/tools.md#projects) and
  [threads](../reference/tools.md#threads). Every command: [CLI reference](../reference/cli.md).

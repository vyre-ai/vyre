---
title: Memory
summary: Search everything said in every past session, see the facts Vyre remembers about people, organisations and projects, trace each fact to the turn it came from, and correct it.
audience: users, agents
owner: docs
status: stable
---

# Memory

Vyre remembers in two parts. **Recall** is search over every turn of every Claude Code session on
this machine: full-text plus local embeddings, so it finds a turn by its words or by what it
meant. **Memory** is a graph of facts the curator reads out of those turns: people, organisations,
addresses, domains, repositories, titles, clients and deadlines. Every fact points at the turn it
came from, and no model runs to produce it. Recall owns finding passages; Memory owns facts,
people and links.

## The gold marking

Anything Vyre shows you in **gold** (the Recall colour) came from memory or the search index, not
from a model's words: a matched quote in search results, a fact, a fact's source thread, your own
correction. When text is gold you can ask where it came from, and Vyre can show you the turn.
Vyre holds itself to one rule here: anything it tells you, it can show the source of. The gold appears in the
terminal (`vyre recall`, `vyre memory`, `vyre why`), in the Vyre app's Memory screen, in
Chat next to a thread, and in Lumen when memory answers.

## Search past sessions

```
vyre recall stripe webhook retries
vyre recall "the engagement letter for Dana" --here    # only sessions started in this folder
vyre recall invoice --user --limit 20                  # only what you said (--assistant: only Claude)
vyre recall invoice --keyword                          # full-text only, no embeddings
```

Each hit shows the session's name, its full id, how long ago, who said it and the folder, with
the matching words in gold:

```output
  Harlow billing export
    3f9c2a10-7d4e-4b1a-9c55-0e2f8a6b1d77 · 2d ago · user · /work/harlow-legal
    the «stripe webhook» retries three times, then marks the invoice as failed

  resume one with: claude --resume <id>  ·  vyre call recall.thread '{"session":"<id>"}'
```

Resume a hit with `claude --resume <id>`, or `vyre resume <thread>` to open it with its project's
brief.

In the Vyre app, **Search** (Command-K on a Mac, Control-K elsewhere) runs the same search:

### Keep the index up to date

Vyre indexes on its own: a session a moment after each Claude Code turn ends, and every folder
every 5 minutes (`recall.every` in `config.json`; 0 turns the timer off). `vyre index` indexes
new and changed sessions now.

With no query, `vyre recall` says how much is indexed and whether search can rank by meaning:

```output
  412 sessions · 18230 turns indexed
  vectors: on (Xenova/all-MiniLM-L6-v2) · 18230 embedded, 0 to go
  vyre recall <query> to search
```

> [!WHY] Why does the first search after an install only match words?
> Search by meaning needs a small embedding model. Vyre downloads it once (23 MB) into
> `~/.vyre/models` and embeds your sessions in the background. Until that finishes, recall
> searches full text only, and `vyre status` says "downloading the search model".

> [!SNAG] vyre recall says nothing matches
> On a new install the first pass takes a while: `vyre recall` with no query says "indexing now"
> while it runs. Run `vyre index` to index now. See [troubleshooting](../get-started/troubleshooting.md).

Elsewhere:

- **Vyre app**: **Search** looks through every session; a hit opens the chat.
- **Lumen**: press Control twice and ask; when memory can answer, the answer shows in gold with
  its sources.
- **Claude**: `/vyre recall <query>` inside a session, or the `recall.search` and `recall.thread`
  tools. An agent's search is held to its own projects' folders.

### Search your Mac's sessions from the box

On a box with a paired Mac, your own searches (`vyre recall` on the box)
also ask the Mac, and its hits come back in the same list. Opening one reads its turns from the Mac. The box does not index or store
the Mac's sessions, and an offline Mac only means its hits are missing. Agents and MCP clients
search the box's own sessions only. The decision is [ADR 0021](../adr/0021-box-reads-the-mac.md).

Memory's facts come from the sessions indexed on the machine itself, so the box's graph holds no
facts from the Mac's sessions.

## See what memory holds

```
vyre memory                          # counts, and the most recent facts
vyre memory "Harlow Legal"           # everything about one thing
vyre memory "Dana Reyes" --project harlow-legal
vyre why '<fact id>'                 # the turns a fact came from
```

Each fact prints on two lines, then the commands for it:

```output
  · Dana Reyes works at Harlow Legal
      3 weeks ago · confidence 0.9 · Harlow intake #14
      vyre why '<fact id>' · vyre memory correct '<fact id>' wrong|ended|replace|confirm
```

Each fact shows its age, a confidence and its source (`session #turn`). Facts fade at read time:
one not said for months is marked `stale` with "last said 7 months ago", and your own or confirmed
facts do not fade. A fact two projects disagree about is marked "two projects disagree".

In the Vyre app, **Memory** (`/u/memory`) lists facts grouped by **People**, **Projects** or
**Spaces**. Each row shows its source and when it was learned. Open the **More about this fact**
menu and choose **Where this came from** to see its source turns.

> [!SNAG] The app says "Memory did not load".
> The Memory screen could not read the graph from Vyre. Choose **Try again**. If it keeps failing,
> check that Vyre runs (`vyre status`) and that the memory module started (`vyre modules`).

## See what Vyre has learned about a site

When Vyre for Chrome learns how a website works, the Vyre app lists it under **Memory**, on the
**Sites** tab. Open a site to see what Vyre kept: the flows that worked, the controls it knows how
to find, the site's own API calls and its notes. Each row has **Wrong?**, which forgets just that
item. **Forget** on a site removes everything Vyre learned about it. Neither asks first, because
each can be undone for 24 hours: the line says "Forgot ... Undo", and **Recently forgotten** at
the bottom lists what can still be brought back, on any device.

## How projects keep memory apart

Memory is kept in **rooms**: one per project, and `unfiled` for sessions in no project. A room's
facts come only from its own sessions and what its watchers taught. A project's brief and a
session in that project draw only on that room, so nothing from one client's project reaches
another's. The main graph, across every room, is visible only to you on your own surfaces (the
terminal, the Vyre app, Lumen), to the assistant, and to an agent granted every project.
`--project <slug>` reads one room; `--project unfiled` reads the room of no project.

A [teammate's](teammates.md) notes are not part of this graph. They are a text file the teammate keeps for
itself, shown in the project's **Team** tab. Its sessions are ordinary sessions in the project, so
search finds them and they feed the project's room like any other.

## Correct a fact

You are the only one who can change memory: correcting, merging and splitting are open to your
own surfaces (the CLI, the Vyre app, Lumen) and ask nothing more. A session's tools and an
agent never write memory: they are refused.

```
vyre memory correct '<fact id>' wrong                  # never true
vyre memory correct '<fact id>' ended --at 2026-08-01  # stopped being true
vyre memory correct '<fact id>' replace Northwind Bakery
vyre memory correct '<fact id>' confirm                # sure; it no longer fades
vyre memory correct 'Dana Reyes|works_at|Harlow Legal' add   # a fact memory missed
vyre memory merge "D. Reyes" "Dana Reyes"              # two nodes are one
vyre memory split "Dana Reyes" --project harlow-legal  # that project's Dana is someone else
vyre memory corrections
vyre memory uncorrect <id>
```

Each fact line in `vyre memory` prints the exact `vyre why` and `vyre memory correct` commands for
it. In the Vyre app, open a fact's **More about this fact** menu and choose **Edit** to change it in
place; **Undo** takes a forgotten fact back.

A correction also teaches [learning](learning.md): a rule you keep correcting shows in
`vyre learn signals`.

## Steer what memory offers

```
vyre memory pin "Harlow Legal"      # ranks first wherever it is relevant
vyre memory mute "Old Vendor Inc"   # never offered
vyre memory mute "Old Vendor Inc" --off
```

Pin and mute are `memory.pin` and `memory.mute`. While you type a prompt, Vyre's Claude Code plugin
asks `memory.relevant` for the few facts worth adding, and adds nothing when nothing in the prompt
is known.

## Which surface does what

| Task | Terminal | Vyre app | Lumen | Claude |
| --- | --- | --- | --- | --- |
| Search sessions | `vyre recall` | Search | ask | `/vyre recall`, `recall.search` |
| Read one session | `vyre resume` | open the chat | | `recall.thread` |
| See facts | `vyre memory` | Memory | memory answers | `memory.facts` |
| Where a fact came from | `vyre why` | Where this came from | | `memory.why` |
| Correct, merge, split | `vyre memory correct`, `merge`, `split` | Edit | | never |
| Pin or mute | `vyre memory pin`, `mute` | | | `memory.pin`, `memory.mute` |

## What it will not do

- Run a model to make a fact. Extraction is code, and every fact has a source turn.
- Let a session or Claude change memory. Only you correct, merge or split.
- Carry facts from one project's room into another project's brief.
- Close a fact because nobody mentioned it. Only newer evidence, a passed deadline or you close
  one.

## Next

- [Learning](learning.md): how corrections become lessons.
- [Projects and threads](projects-and-threads.md): what a project's brief draws from memory.
- Design: [ADR 0007](../adr/0007-intelligence.md).
- Every tool: [recall](../reference/tools.md#recall), [memory](../reference/tools.md#memory).
  Every command: [`vyre recall`](../reference/cli.md#vyre-recall),
  [`vyre memory`](../reference/cli.md#vyre-memory), [`vyre why`](../reference/cli.md#vyre-why).

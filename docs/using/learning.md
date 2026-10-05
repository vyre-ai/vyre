---
title: Learning
summary: How Vyre turns your corrections into lessons, enforces them with hooks so Claude cannot forget them, raises a lesson's level when it is broken again, and what only you can loosen.
audience: users, agents
owner: docs
status: stable
---

# Learning

Vyre learns from how you correct it, and enforces what it learned. A lesson that only sits in
memory is advice. A Vyre lesson with a check is code that hooks in Vyre's Claude Code plugin run before a tool
call and before a turn ends, so a model cannot forget it. Learning works in four steps: it hears
**signals**, turns them into **lessons** you accept, **enforces** them, and **escalates** a
lesson that keeps being broken.

Anything that makes Vyre stricter is free. Anything that makes it looser needs you, from your
own terminal, Vyre app or Lumen.

## Signals: what Vyre hears

Each signal keeps the turn it came from, and a short fingerprint so repeats can be counted. It
never keeps whole content.

- Corrections in your prompts: "no", "don't", "always", "I told you", "never push to main".
- Drafts you edited or rejected at the Gate before approving.
- Tool calls you denied, and commands you declined in Claude Code's own prompt.
- Files you reverted after Claude changed them.
- Commands that failed and were then fixed, and test runs Claude did not repeat after a fix.
- Facts you corrected in [memory](memory.md).
- What you tell it directly: `/vyre remember <text>` in a session, or `vyre learn add <text>`.

```
vyre learn signals     # what Learning heard, as counts by kind; never the text
```

`signals` also lists corrections you said again, memory corrections by the rule that made the
fact, and jobs waiting for a model.

## Lessons: accept, edit, retire

A signal becomes a **proposed** lesson: a rule, where it holds (everywhere, one project or one
agent), an optional check, and a level. Code turns common shapes into checks: a banned character
or phrase, a tool or command that is forbidden, files that must not be touched, "run X after
changing Y". What no pattern fits can be distilled by a small model, off the hot path, on your own
quota: one job at a time, never while one of your threads is working. The result is still only a
proposal.

> [!SNAG] `vyre learn signals` shows jobs "waiting for a model"
> Distilling needs Vyre's own session runner, which runs Claude Code for Vyre. Without it the jobs wait.
> Write the lesson yourself instead: `vyre learn add "<what Claude should always or never do>"`.

Nothing becomes a lesson unseen. When Claude proposes one in a thread, answer with a plain yes to
keep it ("yes, keep lesson 7") or no to drop it. You can also answer from any surface:

```
vyre learn                     # active lessons with their counts, then proposed ones
vyre learn show 7
vyre learn accept 7
vyre learn retire 7            # retire an active lesson, or decline a proposed one
vyre learn add "never write em dashes in docs"
```

Accepting and retiring are yours: they ask nothing more. Claude and agents are refused, and
the plugin stops Claude's shell from running them. A proposed lesson looks like this in
`vyre learn`:

```output
  proposed
  ? 7 never push to main [ask]
      checks tool · applied 0 · caught 0 · broken 0
      vyre learn accept 7 · vyre learn retire 7
```

- **Vyre app**: **Memory**, then the **Lessons** tab (`/u/memory`), in four groups:
  Proposed, Active, Retired, and Proposed skills. Relax, and a skill's Install and Dismiss, ask you to prove you are there.
- **Lumen**: a proposed lesson shows as a row to accept or decline.
- **Claude**: `/vyre lessons` lists them. Claude can add a lesson (`learn.add`) and tighten one
  (`learn.edit`), and never accepts, retires or loosens one.

## Enforcement

A lesson with a check becomes code:

- **Before a tool runs**, the Rules hook asks `learn.check` with stage `tool`. A lesson at `ask`
  holds the call for you; at `block` it denies it. Either way Claude is told which lesson it met.
- **Before a turn ends**, the Stop hook runs the output checks: banned characters, required steps
  such as "update the changelog" or "test before commit". When one fails, the turn goes back to
  Claude with the lesson named, so Claude fixes it first. It goes back at most twice; after that
  the turn ends and the lesson counts as broken.
- A lesson **without** a check is a reminder: it is added to the brief and to the prompt whenever
  its `when` matches, every time.

Lessons keep working when Vyre is down: the hooks fall back to a snapshot of your accepted
lessons, and what happened offline is counted when Vyre starts again.

## Escalation

Every lesson counts how often it applied, was caught and was broken. A lesson broken again moves
up one level:

| Level | What it does |
| --- | --- |
| `remind` | repeated to Claude; never holds anything |
| `ask` | a tool call waits for you |
| `block` | a tool call is denied |

A lesson you pinned, or one at the cap you set, does not move. Nothing weakens on its own: a
lesson that has caught nothing, been broken and been repeated in no turn of the last 60 days, across at least 200 turns in its scope, goes dormant (out of the brief, its check still running), and an `ask`
lesson you allowed every time proposes a demotion for you to decide.

```
vyre learn stats                       # working, not working, or still measuring
vyre learn level 7 block               # raising is free
vyre learn level 7 remind              # lowering is yours alone
vyre learn scope 7 all                 # widening to everywhere is free
vyre learn scope 7 project harlow-legal   # narrowing is yours alone
vyre learn relax 7 max ask             # cap it; also: pin, paths, when, scope
```

`vyre learn stats` compares how often you repeated a correction before the lesson with how often
it has escaped since.

## Skills from what you repeat

When you run the same procedure in three sessions without correcting it, Learning drafts a skill:
instructions every future session follows. You see the whole file before it is installed.

```
vyre learn skills
vyre learn skills show 3
vyre learn skills install 3 --project   # or --account, --agent kit; --private keeps it out of the repo
vyre learn skills dismiss 3
```

Installing and retiring a skill need presence.

## Which surface does what

| Task | Terminal | Vyre app | Lumen | Claude |
| --- | --- | --- | --- | --- |
| List lessons | `vyre learn` | Memory, Lessons tab | | `/vyre lessons`, `learn.lessons` |
| Add a lesson | `vyre learn add` | | | `/vyre remember`, `learn.add` |
| Accept or decline | `vyre learn accept`, `retire` | Accept, Retire | the lesson row | a plain yes or no in the thread |
| Tighten | `vyre learn level` (up), `scope <id> all` | Edit | | `learn.edit` |
| Loosen | `vyre learn level` (down), `scope` (narrower), `relax` | Relax | | never |
| Skills | `vyre learn skills` | Proposed skills | | `learn.skills` (read only) |

## What it will not do

- Make a lesson you did not see and accept.
- Let Claude retire, loosen or accept a lesson. Those are `learn.retire`, `learn.relax` and
  `learn.accept`, open only to your own surfaces.
- Weaken a lesson on its own.
- Let a command edit its way around the hooks: writes to the lessons snapshot, the database, the
  plugin's hooks or the Claude Code settings that load them are asked every time.

## Next

- [Memory](memory.md): corrections to facts are signals too.
- [Presence](../concepts/presence.md): how you prove you are there.
- Design: [ADR 0007](../adr/0007-intelligence.md).
- Every tool: [learn](../reference/tools.md#learn). Every command:
  [`vyre learn`](../reference/cli.md#vyre-learn).

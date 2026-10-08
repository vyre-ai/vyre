---
title: Teammates
summary: A teammate is a named role in one project, like design or backend, with its own notes. How to add one, ask it, give it a charter and standing duties, let an integrator merge worktree work, retire it, and what it costs.
audience: users, agents
owner: docs
status: draft
---

# Teammates

A teammate is a role in one project, like `design`, `backend` or `qa`. It has a name
(`design-juniper-legal` for the `design` role in Juniper Studio), a short brief on what work goes to it,
and its own notes, which are the memory it keeps between jobs. It belongs to that project: it works on
the project's folder and is not shared with another project. You can have a teammate stay on a long
piece of work, where a one-off helper would forget everything when it finished.

## Add a teammate

You add one from the Vyre app or the terminal.

- **Vyre app**: open the project's page, choose the **Team** tab, then **Add a teammate**. Give a role
  (one lowercase word, like `design`) and, if you like, a line on what work goes to it. Typing
  `@design` and a message in a project's chat also makes the role if it does not exist yet, when
  teammates are on for that project.
- **Terminal**: `vyre team add design --brief "visual design and UI copy"`, from inside the project's
  folder or with `--project <slug>`. `--isolation worktree|folder|none` picks where it works (see
  [Worktrees and the integrator](#worktrees-and-the-integrator)). A person's add defaults to the
  project's own folder.

A model can add a teammate only when your own words asked for it, and only once. If you tell your
assistant "add a design teammate", it may make exactly that role in that project. A plain request
counts for 15 minutes and one use. It cannot choose the tools or the models, which stay at the
defaults, it cannot choose `none` for where it works, and it is not allowed a role it was not asked
for. A teammate itself can never add or retire another teammate.

If the role was retired before, adding it again brings back the same teammate with its notes and
history.

## Ask a teammate

Any session in the project, and you, can send a teammate work. Work goes into the teammate's own
queue and the teammate does one request at a time, in order.

```sh
vyre team                               # this project's teammates, their state and queue
vyre team ask design "Make the intake form calmer"
vyre team ask design "Fix the footer" --urgent     # jumps this teammate's own queue only
vyre team ask design "Summarise what you changed" --wait   # waits up to 30 seconds for the result
vyre team ask backend "Review the migration" --model codex   # runs this request on Codex (or grok, or provider/model)
vyre team status <request>              # one request's state and result
vyre team cancel <request>              # cancel a queued request
vyre team notes design-juniper-legal     # read its notes
```

In a project's chat in the Vyre app, `@design make the intake form calmer` sends the same request without
using up the current session's turn. In a Claude Code session, the agent calls `team.ask`; the result
comes back later as a message in that session. A teammate can ask another teammate, down to three
teammates deep, and never in a loop.

When a teammate finishes a request it closes it with its result. Vyre refuses to close a request
whose notes did not change since it started, unless the teammate says why nothing needed writing down.
A request that ends without a result is recorded as failed, so one silent teammate never blocks the
queue.

The **Team** tab shows each teammate's state (Idle, Working, Waiting), what it is doing now, its
last result and how many requests wait. **Steer new work to teammates** on that tab turns off the
nudge that points a project's sessions at teammates; the teammates you already have keep working.

## Notes and the charter

A teammate's **notes** are plain text it writes for itself. You can read them, and edit them with
**Edit notes** in the Team tab. A teammate's session starts fresh from time to time, and its notes
and its last few results carry over when it does.

A **charter** says what the teammate is for and how it works, in plain words, up to 8,000 characters.
It adds to Vyre's own rules and never replaces them. In the Team tab, open a teammate and choose
**Edit** to write one, or **Draft it from the project** to have a model write one from the brief, the project and the
notes. A draft is saved at once as a new version you can read and edit. Every version is kept and an
older one can be made current again. A new charter starts the teammate's next request on a fresh
session so it applies. Only you write a charter; a teammate cannot change its own.

**Who fills it** in the same place sets whether the project's helper or one of your own agents does
the role. Notes, charter and history stay with the role.

## Standing duties

A duty is something a teammate does by itself when a trigger fires, written in plain words: an
event ("when a session finishes"), a schedule (`daily 07:00`) or a connection's push. A duty is a
[watcher](watchers.md#standing-duties-are-watchers-too) the teammate owns. It lives in the same
project, runs on the same runtime, inside the same wall (it cannot reach the network or your files),
and shows the same card before it runs.

- **A model's proposed duty stays off.** A duty that a teammate, an agent or a session creates is a
  proposal with no watcher. It does not run until you turn it on, from its card in the **Team** tab,
  or until a model turns it on because your own words asked for exactly that duty. A duty you create
  yourself starts at once.
- **Enable and pause.** The button on a duty in the Team tab switches it on or off, and **Run now**
  fires an enabled duty once. A duty can be set to only look and tell you, or to make changes; one that
  makes changes still holds anything outward you did not ask for.
- **What a firing does.** It files an item, and the teammate reads what its duties filed with its
  next request. A firing does not start the teammate by itself.

## Worktrees and the integrator

If the project's home is a git repository, a teammate can work in its own git worktree on its own
branch, so two teammates never edit the same files. Choose it with `--isolation worktree`. A model that
adds a teammate gets this by default.

The first teammate in a project with a worktree brings an `integrator` teammate along. When a worktree
teammate finishes a request that left new commits, Vyre queues a merge for the integrator. The
integrator merges that branch into the project's own branch, fixes a conflict in its own worktree,
and, when the project has a test command, runs it itself. Vyre does not run it. The integrator reports the
exit code, and only when no conflict is left and the tests passed does Vyre move the project's branch
forward. If
the project is not a git repository, a worktree teammate falls back to the shared project folder and
says so.

You cannot add a role named `integrator` yourself, and only you or your assistant can retire it.

## Retire a teammate

In the Team tab, open the teammate and choose **Retire**, then confirm. It stops taking requests, its
queued requests are cancelled and its duties go off. Its notes and history stay readable, and adding
the same role again brings it back. A request that is running blocks retiring until it ends. A
worktree teammate's worktree folder stays on disk.

A model can retire a teammate only when your own words asked for it, once, the same way it adds one.

## What it costs

A teammate's work is an ordinary Vyre session, so it uses the plan on your own accounts the way your
other sessions do, and each running request counts against the project's limit on concurrent sessions.
A teammate that is not working costs nothing: it has no process and no timer. A request does take
turns on your plan, so a busy project with several teammates uses it faster than one session.

## What it will not do

- Add, retire or rewrite another teammate or its charter, when it is a teammate itself.
- Turn on a duty it proposed, or run a duty that is off.
- Work on a project other than its own.
- Wake itself when a duty fires.

## Next

- [Projects and threads](projects-and-threads.md): where a teammate lives.
- [Watchers](watchers.md): how duties run.
- Every command: [`vyre team`](../reference/cli.md#vyre-team).

# projects

Branch: work/projects · Worktree: ../vyre-projects · Milestone: M1

## Scope

Owns `core/projects/`, `core/cli/commands/projects.js` (and any other command files it needs
for home/open/new/resume/context/threads).

A project is a home folder, the other folders it owns, the threads in it, its people and its
watchers, declared by `<home>/.vyre/project.json` (spec section 7.2). The marker is the source
of truth; the DB caches it. Projects are made BY HAND: the user picks sessions from the
catalogue. A session can be in many projects. A session belongs because it was picked, or
because it ran in one of the project's folders. Nothing automatic removes a pick.

- **catalogue**: every session from `recall_sessions` (read directly; see
  `core/recall/schema.js`), with /rename name (the identifier), first message, folder, last
  activity, human or not. Searchable by name, title and folder, AND by what was said, through
  `ctx.call("recall.search", ...)`. When Recall is not running (`no_such_tool`) fall back to
  title search and say so. Subagents fold into their parent.
- **brief**: what Claude should know when a thread starts in a project: what it is, its people,
  its other threads (by name), its folders, and memory facts from `ctx.call("memory.facts",
  {project_cwds})`, skipped quietly if Memory is not running. Capped near 600 tokens
  (2,400 chars); from that project only; never another project's data.

## Tools (module `projects`)

`projects.list`, `projects.create {name, home, workspaces?, threads?, people?}`,
`projects.add-threads {project, threads}`, `projects.remove-threads`, `projects.catalog {q?, limit?, human?}`,
`projects.of {cwd}` (which project a folder is in), `projects.threads {project}`,
`projects.context {project}` (the brief text).

## Events

`project.created`, `project.changed`, `thread.picked`, `thread.unpicked`.

## CLI

Port `the prototype's bin/vyre` (the prototype CLI): `vyre` alone in a folder that is in a project
opens that project (its threads, newest first, and what to do next); elsewhere it lists
projects. `vyre new` creates a project interactively by searching the catalogue and picking
sessions (show name, first message, folder, age, and "said" hits). `vyre open <project>`,
`vyre resume <thread>` (execs `claude --resume <id>` in the right folder, with
`--append-system-prompt` carrying the brief), `vyre context`, `vyre threads`, `vyre projects`.
Every command also works non-interactively (flags / piped stdin) so tests can drive it.
Start vyred if needed with `ensureUp()` from `core/cli/daemonctl.js`.

## Port from

`the prototype's bin/projects.cjs`, `brief.cjs`, `vyre`; tests `the prototype's bin/test/t-projects.cjs`,
`t-brief.cjs`. Do NOT port `sorter.cjs` (auto-sorting was dropped; projects are hand-made).

## Done when

- Against `seedRecall()`: create "Harlow Legal" with home `~/Work/harlow-site`, pick the intake
  session and the weekly-planning hub session; the hub session is ALSO pickable into a
  "Northwind" project; the subagent folds under its parent; the brief for Harlow names Dana and
  never mentions Northwind.
- `vyre new` and `vyre resume` are exercised in a test (resume with a fake `claude` on PATH).

## Done
## Doing
## Next
## Needs from others
## Changed contracts

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
- `core/projects/` module (markers, catalogue, brief, 8 tools, 4 events) with 14 unit tests
  against `seedRecall()` (385e2dd, 008d72e).
- `core/cli/commands/projects.js`: home, projects, new, open, threads, resume, start, context,
  pick, unpick; 4 end-to-end tests with a fake `claude` on PATH (cb1a531).
- Every done-when item passes: Harlow Legal plus the intake and hub picks, the hub also in
  Northwind, the subagent folded, the Harlow brief names Dana and never mentions Northwind.

## Doing
- Nothing.

## Next
- Test `vyre resume` against real Claude Code once before merge (spec section 14). It has only
  run against the fake so far.
- Once Recall merges, check that `recall.search` returns `[{session, ...}]` as its brief says,
  and that the catalogue's "said" counts look right on a real index.

## Needs from others
- recall: `recall.search {q, limit}` returning an array (or `{hits}`) of `{session}`. A
  subagent's session id is folded to its parent here.
- memory: `memory.facts {project_cwds, limit}` returning an array (or `{facts}`) of objects with
  `text` (or `fact`, `summary`, `label`) and an optional numeric `confidence`. The memory
  session has been told.
- main: macOS caps unix socket paths at 104 bytes. A long `VYRE_HOME` (the scratchpad path, for
  one) makes vyred fail with `listen EINVAL`. Worth a clear error in `core/daemon`.

## Changed contracts
- The marker keeps picks under `threads` (spec 7.2) and adds optional `org`, `people`,
  `watchers` (names). Workspaces are stored relative to the home. Subagent ids are folded to the
  parent id before they are stored.
- `projects.create {name, home?, org?, workspaces?, threads?, people?, watchers?}`. `home`
  defaults to `<projectsDir>/<slug>`. It refuses a slug that is already taken and a folder that
  already has a marker.
- `projects.catalog {q?, limit?=50, human?}` returns `{total, search: "none"|"said"|"titles",
  note?, sessions: [{id, name, title, label, cwd, started, last, turns, human, agents,
  projects, titled?, said?}]}`.
- `projects.threads {project, limit?}` returns those rows plus `how: ["picked"|"folder"]`,
  newest first. Picks the index has not seen get `missing: true`.
- `projects.context {project?, cwd?, session?}` returns `{project, candidates, text}`. It
  resolves in this order: the named project, the project that owns cwd, then the one project
  the session was picked into. If the session was picked into several, `text` is `""` and
  `candidates` lists them. The session itself is left out of "other threads".
- `projects.of {cwd}` returns `{slug, name, home, folders}` or null, matching subfolders.
  `folders` is the home plus workspaces, absolute and real paths. This is the shape the Harness
  on main uses.
- Every Claude Code launch (`vyre resume`, `vyre start`) adds `--plugin-dir <REPO>/harness` when
  `harness/.claude-plugin/plugin.json` exists (`VYRE_HARNESS_DIR` overrides it, for tests). In
  that case the brief is NOT passed as `--append-system-prompt`; the SessionStart hook adds it.
  Without the plugin, the flag carries the brief as before. `projects.list` returns
  `{projects: [...], problems: [{home, error}]}`.
- `projects.remove-threads` returns `{removed, stillByFolder}`, because folder membership
  cannot be removed.
- Events carry `{project, thread}` with `where.project` and `where.thread` set:
  `project.created {project, name, home, threads}` and `project.changed {project, fields}`.

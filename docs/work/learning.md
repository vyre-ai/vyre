# learning

Branch: work/learning · Worktree: ../vyre-learning · Milestone: M6 · Wave 1

## Scope

Owns `core/learn/`, `core/cli/commands/learn.js`. May add the Stop-hook check to
`harness/hooks/hook.js` and `core/harness/` (the `stop` piece), as the smallest change.

Spec section 7.11: Vyre learns from corrections and ENFORCES what it learned. The user asked for
self-learning that is hard to get around. A lesson only in memory is advice; these are checked.

- **Signals** (each keeps its `(session, seq)`): corrections in prompts, read from the Enrich
  call (`harness.enrich` sees every prompt; add a `learn.signal` call there); denied tool calls
  (`tool.held` and Claude Code denials); reverted changes (`harness_files` + git); drafts edited
  before approval (from the Gate, later: `draft.edited`); `/vyre remember <text>`.
- **Lessons**: `{ id, scope: "all"|{project}|{agent}, when, rule, check?, level: "remind"|"ask"|"block", source, applied, broken }`.
  Turning a free-text correction into a rule may use a model, off the hot path, on the user's own
  quota (a headless `claude -p` through the switchboard when it exists; until then queue it and
  let the user write the rule). Nothing becomes a lesson without the user seeing it.
- **Checks**, as code:
  - `tool` checks run in `harness.rules` (PreToolUse): deny or ask, quoting the lesson.
  - `output` checks run at Stop: read the turn's final assistant text and the files it
    changed (`harness.touched`); a failing check makes the Stop hook return
    `{"decision":"block","reason":"<lesson>"}` so Claude continues and fixes it. Guard against
    loops: at most two blocks per turn, then let it end and record `lesson.broken`.
  - Built-in check kinds to start: forbidden text (a regex, e.g. a banned character), required
    file touched when others were (e.g. CHANGELOG.md when code changed), command run before
    another (e.g. tests before `git commit`).
  - Lessons without a check are added to the brief and to Enrich whenever `when` matches.
- **Escalation**: broken again moves remind to ask to block. The Deck and `vyre learn` list
  lessons with their counts; the user edits, narrows or retires them.

## Tools

`learn.lessons`, `learn.add`, `learn.edit`, `learn.retire`, `learn.signal` (internal),
`learn.check {stage: "tool"|"stop", ...}`.

## Events

`lesson.learned`, `lesson.broken`, `lesson.escalated`, `lesson.retired`.

## Done when

In a real Claude Code session with the Harness: the user says "never use em dashes in anything
you write"; a lesson is proposed and accepted; the next reply that contains one is sent back by
the Stop hook and comes back without it; a second lesson ("update CHANGELOG.md whenever you
change code") blocks a turn that edited code without it. Tested with a fake transcript as well.

## Done
- `core/learn` module, `vyre learn`, `/vyre remember` and `/vyre lessons`; Harness wiring in
  enrich, rules, stop and brief; 24 new tests (203 in the suite, all green).
- Verified in real headless Claude Code 2.1.283 (haiku, temp `VYRE_HOME`): "never use em dashes"
  proposed, accepted by Claude through `learn_accept` after the user's yes; a reply with an em
  dash sent back once by the Stop hook, final reply clean. "Update CHANGELOG.md whenever you
  change code" accepted with `vyre learn accept`; a turn that wrote `src/add.js` only was sent
  back and then edited the changelog. `learn_retire` held (ask, denied headless) although
  `--allowedTools` allowed it.
- Offline checks (`core/learn/offline.js`): accepted-lessons snapshot `<home>/lessons.json`
  (0600), hook.js runs tool and Stop checks from it when vyred is unreachable, and the module
  counts the offline log at start. Verified for real in `/tmp/vyre-lab` with vyred unable to
  start: em dash reply 1 dash then 0; `src/add.js` turn sent back, then the changelog edited;
  2 offline catches counted on restart.
- Draft edits as signals: subscribes to gate-chat's `gate.released {edited: true}` and reads
  `gate.get {id}` for draft and final; a character taken out everywhere is proposed at remind.
  No change on gate's side.

- Flaky offline test fixed: the offline turn ordered edits and commands by `Date.now()`, and a
  test run in the same millisecond as the edit before it did not count. Now a counter per session
  file; a frozen-clock test covers it. Not suite interference: it failed alone too.

- Enforcement that cannot be dodged (ADR 0007, decision 11): project scope fixed (it never
  applied), accept by reply in `learn.signal`, `learn.accept|retire|relax` owner-only with a
  presence declaration, `learn.edit` tightens only, `max_level` and `pinned`, guards against
  every route in the ADR, offline project lessons and a read-only `vyre.db` fallback, the
  snapshot hash and `lesson.tampered`, and a visible break after the cap (next prompt opens with
  it, the brief counts the week, no reset by a new `prompt_id`). 15 new tests; `npm test` green.
- `requires` stays empty: the loader treats a missing required module as fatal, and Harness
  calls Learning, so requiring `harness` or `projects` would stop Learning with them. Each call
  already degrades to less when the module is absent.

- ADR 0007 decisions 6 to 10 and 12 (commits 848d679, 3cd836f, 7e13da5): check kinds `tool`,
  `path`, `after` and `paths` on any check, online and offline; nine new `distill()` shapes and
  scope words, with negative tests; signals with key, project, agent and meta (repeated,
  rejected, reverted, rewritten, failed, fixed, test-fix, untested, declined, denied, allowed,
  corrected); behaviour proposals (path at ask, tool at ask, after at remind); `learn_jobs`
  through `threads.launch` on events only; scope inference and widening; the `preference`
  taught to Memory; `learn_days`, `learn_lesson_days`, `learn.stats`, dormancy and
  `lesson.allowed`; skills wired end to end; `learn.signals`; retention; the CLI. 39 new tests
  (`npm test`: 959, 0 failing).
- Hook cost with 50 active lessons (in process, 360 rules calls and 30 Stops over 3 sessions with
  real file writes): `harness.rules` p50 2.2 ms, p95 3.3 ms, max 9 ms; `harness.stop` p50 2.3 ms,
  p95 4.0 ms; `harness.enrich` p50 0.3 ms.
- PostToolUseFailure checked against the Claude Code 2.1.283 binary: it sends `tool_name,
  tool_input, tool_use_id, error, is_interrupt, duration_ms`. The hook reads each field only if
  present. Not yet seen end to end in a live session.

## Doing
- Nothing; waiting for review.

## Review fixes (26 Sep 2026)
- Human-only learn tools (`accept`, `retire`, `relax`, `skill-install`, `skill-retire`,
  `skill-dismiss`) take only `cli`, `deck` and `capsule`; `local` (any socket client with no
  header) is refused. STOPGAP until security's registry enforces `presence`: `vyre learn` and
  `vyre call` ask the person at a terminal to type the id back (`core/cli/confirm.js`), after
  checking stdin and stdout are terminals and `/dev/tty` opens (it fails with ENXIO in Claude's
  Bash, ADR 0004). `script` or a hand-written client gets round this, so weakens() also asks
  before a model's shell reaches any of these tools. When `core/presence/index.js` exists the
  CLI skips the step and vyred decides.
- A forged enrich: the same prompt_id is a duplicate (nothing reset, answered or proposed). A new
  prompt before the last turn passed a Stop keeps its blocks, owed lessons and (when it changed
  files) its start; its no declines nothing, its yes still accepts. `learn_turns.stopped` records
  a passed Stop; offline keeps the same flag in the session file. Running `hook.js` by hand is asked.
- weakens(): `vyre learn scope`, `vyre learn skills install|retire|dismiss`, `claude plugin
  disable|uninstall|remove`, `~/.claude/plugins/` and `~/.claude` itself, scripts that name a
  human-only tool and a route to vyred. Always on (online and offline) for the store, socket,
  `learned/`, hooks, plugins and human-only tools; lesson files, lesson commands and stopping
  vyred still wait for an active lesson. Store names count only inside the home (bare only with
  cwd there), hooks only under the loaded plugin root (`CLAUDE_PLUGIN_ROOT`, or the hook's own
  folder, passed as `plugin_root` to `harness.rules`), and `git -m` messages are ignored.
- distill(): questions, firm words not at the start of a clause said to Claude, and "yet", "for
  now", "here", "this time", "for this PR" are not rules; softCorrection needs a habit after
  stop or quit ("stop the server" is a task).
- Declined: Claude Code settings refusals cannot be told from the user's no, so a proposal needs 3
  nos in at least 2 sessions, and headless threads (`VYRE_THREAD` equals the session) infer none.
- `learn.edit` refuses a proposed lesson. PreToolUse asks `harness.touched` for 1 row; an index
  on `learn_writes (path, done)`.
- Note: `node --test core/learn/` runs the folder as one module (1 test); use
  `node --test core/learn/*.test.js`.

## Next
1. A live headless check of PostToolUseFailure, declined calls and a revert, as was done for
   the first lessons.
2. A test-fix run is a signal, not yet a skill candidate "on its own shape" (ADR 10): it still
   needs 3 clean sessions like any procedure.
3. Seq is Learning's own turn count per session, not the transcript seq; line them up once
   Recall exposes it.
4. Online, `learn.check` still orders commands against `harness.touched` by millisecond
   timestamps from two modules; a shared sequence (or Recall's seq) would remove the tie.
5. Offline, nested projects: the snapshot carries only the folders of projects that have lessons,
   so in an inner project with none, the outer project's lessons apply offline (online they do
   not). Carry every project's folders if this matters.
6. Declined is read only for Bash and file writes, the tools whose PostToolUse the Harness hears.
   The "no allow" test for a declined shape uses allowed signals (14 days) and runs of that shape
   in `learn_calls` (7 days, its retention).
7. A revert is noticed when mtime or size moved; a same-size revert within one mtime tick is
   missed. A command from another session's Claude (a git checkout there) still reads as the user.

## Needs from others
- security: the registry must enforce `presence` on `learn.accept`, `learn.retire`,
  `learn.relax`, `learn.skill-install`, `learn.skill-retire` and `learn.skill-dismiss` whatever
  the caller claims. Until it does, any process can claim `cli` (daemon/client.js defaults to it);
  Learning's stopgap is the CLI's terminal check and weakens() asks. When your registry lands,
  add `core/presence/index.js` and the CLI stops asking for the id (it needs to answer your
  challenges instead).
- switchboard: agent threads should also load `<home>/learned/agents/<name>` (`learnedDirs`
  loads the account's and the project's only). `threads.launch` is called with `once: true`
  (the ADR says one-shot; there is no `oneshot` option) plus `plugin: false, tools: "none",
  settings: false, model: "haiku", budget_usd: 0.05`. Learning reads a job's answer from
  `thread.text {done: true}` and its end from `thread.stopped`, and treats `starting`, `working`
  and `waiting` in `threads.list` as a user thread working; keep those stable.
- harness install (`vyre harness install`): register `<home>/learned/account` as a plugin, per
  ADR 10; skills.js now writes the account plugin there, matching the Switchboard.
- memory: `ctx.memory.teach("preference", {subject: "the user", rel: "prefers", object: {name},
  text, key: "lesson:<id>", project_cwds?, forget?})`; the curator must accept `prefers` from a
  module (ADR 2 keeps extracted `prefers` off; this one is taught). Keep `memory.corrected`
  `{id, action, rel, scope, prior_source, prior_rule, prior_confidence}` stable.
- gate: Learning reads `gate.rejected {id, kind, via}` (never `reason`); keep those fields.
- security: add `learn.skill-install` and `learn.skill-retire` to the presence floor list. The
  ADR's `learn.skill_install` could not be used: the loader allows no underscore in a tool name.
- security: accept by reply is a deliberate path around the `learn.accept` tool (ADR 0007); add
  `learn.relax` to the presence floor list; make the Registry honour the `presence` declaration.
  The guards here are asks; the floor's denies for `vyre learn accept|retire`, raw socket
  clients and home internals are yours.
- gate-chat: keep `gate.released {id, edited, thread, agent}` and `gate.get {id} -> {draft, final, diff}`
  stable (agreed); message Learning before a field changes.
- deck: a lessons panel over `learn.lessons`, `learn.accept`, `learn.edit`, `learn.retire`.
- switchboard: a headless `claude -p` to distill free-text corrections; `VYRE_AGENT` in the env
  of agents' sessions, so lessons can be scoped to an agent.

## Changed contracts
- New tools: internal `learn.observe {session, tool_use_id?, tool_name, ok, error_head?,
  interrupted?, path?}`; `learn.signals {kind?, since?, limit?}` (owner callers) ->
  `{signals, counts, repeats, corrected, jobs}`; `learn.stats {id?}` -> `{before, after,
  escapes, attempts, turns, verdict, dormant}` (a list with no id); `learn.skills {status?}` ->
  `{skills, drift}`; `learn.skill-install {id, scope?, private?, agent?}` and
  `learn.skill-retire {id}` (owner callers, presence); `learn.skill-dismiss {id}` (owner).
- New events: `lesson.dormant {lesson, level}`, `lesson.allowed {lesson, allowed, asked, level,
  propose}`, `distill.finished {job, kind, ok, lesson, skill}`, `skill.proposed {skill, sessions,
  scope: "all"|"project"}`, `skill.installed {skill, scope}`, `skill.retired {skill}` (skill
  events no longer carry the name). `lesson.retired` may carry `replaced`.
- Checks: kinds `tool {tool?, command?, instead?, label}`, `path {pattern, label}`, `after
  {command, when?, label}`, and `paths` on any check. `atStop` takes `changes` and `commands`.
- A lesson gains `key`, `accepted`, `dormant`. `learn_signals` gains `key, project, agent,
  meta`. New tables `learn_writes`, `learn_calls`, `learn_jobs`, `learn_days`,
  `learn_lesson_days`, and the skills tables. `learn_turns` gains `project`, `agent`.
- `harness.rules` and `harness.learn` take `tool_use_id`; `harness.learn` takes `ok`,
  `error_head`, `interrupted` and runs for Bash too. Hook piece `fail` (PostToolUseFailure).
- Config: `learn.distill.daily` (default 6).
- module.json: `does`, `watches`, `shows {deck: ["panel:memory/lessons"], capsule:
  ["waiting:lesson.proposed"], cli: ["learn"]}` and `teaches {memory: ["preference"]}` per ADR
  12. `requires` stays empty for the reason above.
- New tools: `learn.lessons {status?}`, `learn.add {text | rule, when?, level?, scope?, check?}`,
  `learn.accept {id}`, `learn.edit {id, rule?, when?, level?, scope?, check?}`,
  `learn.retire {id}`, `learn.check {stage: "tool"|"stop"|"brief", ...}`, internal `learn.signal`.
  A lesson is `{ id, scope, when, rule, check, level, status: proposed|active|retired, source,
  applied, caught, broken, created, updated }`.
- New events: `lesson.proposed`, `lesson.learned`, `lesson.caught`, `lesson.broken`,
  `lesson.escalated`, `lesson.retired` (`lesson.proposed` and `lesson.caught` added to the
  brief's list: the Deck needs to show a pending proposal and a caught reply).
- `harness.enrich`, `harness.rules` and `harness.stop` accept `prompt_id` and `agent`;
  `harness.stop` also takes `text` and `stop_hook_active`, and may return `{decision: "block",
  reason}`. `harness.brief` text now ends with the active lessons, in a project or not.
- `tool.held` payload gains `lesson` (null for a floor hold); `rule` is null for a lesson hold.
- Files in the home: `lessons.json` (accepted lessons, `{version, at, lessons: [{id, rule, level,
  scope, check}]}`, 0600) and `learn-offline/` (per-session turn state and `log.jsonl`). Only
  Learning and the hooks read them.
- `lessons.json` is version 2: a project lesson adds `project` (slug) and `folders`. Version 1
  still reads. With the file missing or unreadable the hook reads `learn_lessons` (and
  `projects_projects` for folders) from `vyre.db`, read-only.
- `scope.project` holds the project's slug; names, homes and folders are accepted and stored as
  the slug when Projects knows them.
- `learn.accept`, `learn.retire`: `callers: ["cli","local","deck","capsule"]` and `presence:
  { summary }`. Claude is never told to call them; a thread accepts by a plain yes, declines by
  a plain no.
- New tool `learn.relax {id, rule?, level?, scope?, when?, check?, max_level?, pinned?}`, same
  callers and presence. `learn.edit` takes the same fields and refuses any that loosen, naming
  `learn.relax`.
- A lesson gains `max_level` (null means block) and `pinned`. New tables and columns:
  `learn_state`, `learn_turns.asked`. `learn_signals` kinds `broken` and `tampered`.
- `lesson.broken` payload is `{lesson, session, level, stage}` (stage `tool`, `stop`, `prompt`,
  `offline`). `lesson.retired` gains `declined: true` for a declined proposal. New event
  `lesson.tampered {}`.
- `learn.signal` returns `broke` (lesson ids); `harness.enrich` puts the lessons ahead of memory
  when it is not empty. `weakens(tool, input, {home, cwd})` takes where it runs.

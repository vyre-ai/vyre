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

## Doing
- Waiting for gate-chat's edited-approval event shape (asked), to read draft edits as signals.

## Next
1. Draft edits from the Gate as signals, once gate-chat sends the event shape.
2. Turning free text into a check with a model, off the hot path, through the switchboard.
3. Signals not read yet: reverted changes (`harness_files` plus git), and denials the user makes
   in Claude Code's own prompt (hooks do not see those).
4. Seq is Learning's own turn count per session, not the transcript seq; line them up once
   Recall exposes it.
5. Offline, project-scoped lessons do not apply; the snapshot could carry each project's folders.

## Needs from others
- deck: a lessons panel over `learn.lessons`, `learn.accept`, `learn.edit`, `learn.retire`.
- switchboard: a headless `claude -p` to distill free-text corrections; `VYRE_AGENT` in the env
  of agents' sessions, so lessons can be scoped to an agent.

## Changed contracts
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

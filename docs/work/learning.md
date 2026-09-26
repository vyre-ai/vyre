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

# ADR 0007 · Intelligence: the memory graph and the learning loop

Status: accepted, 26 Sep 2026 · Workstream: intelligence (memory + learning) · Spec: principles 1,
7, 8 and 9; sections 5, 6, 7.4, 7.11, 8, 9 and 10 · Related: ADR 0004 (presence)

## The problem

Memory already extracts people, orgs, addresses, domains and repos with provenance, and Learning
already turns a correction into a checked lesson. Both work, and both stop short:

- **Project graphs are filtered, not computed.** `works_at` is voted once over every session
  (`curator.js:560-606`) and a project view hides edges with no evidence there
  (`graph.js:268-274`). Another client's sessions can erase a project's fact, lower its
  confidence, or leave it with none. One global claimant per short form means "Summit" can
  resolve to the wrong project's Summit. An org in 12% of sessions becomes a hub and disappears,
  so the user's main client is the one Memory hides. Outside a project Enrich falls back to
  `project_cwds=[cwd]` (`harness/index.js:104`), so a session in `~` sees every client.
- **Nothing decays.** "Seen" is read from the six earliest evidence rows; ranking ignores age.
- **The user cannot correct a fact.** The Deck's "Forget this fact" mutes the whole person.
- **Learning hears few signals** (prompts, floor holds, Gate edits), knows three check shapes, and
  its project scope never applies: `inScope` reads `r.data.project` but `projects.of` returns
  `{slug, ...}` (`learn/index.js:110`).
- **Enforcement has gaps.** Project lessons do not apply offline; a missing `lessons.json` turns
  offline checks off; `learn.accept` is designed for Claude to call after the user's yes, which
  ADR 0004 now forbids; `learn.edit` can weaken a lesson with no proof; after two send-backs a
  turn simply ends.
- **No measurement.** Nobody can say whether a lesson reduced the thing it was about, or whether
  Memory's facts are right.

## Decisions

### 1. Rooms are computed, and nothing crosses between them

A **room** is a project (its folders plus the threads picked into it), or `unfiled` for sessions in
no project. A session can be in several rooms.

- The curator derives beliefs **per room** from that room's sessions and lessons only, with the
  same vote rules, and writes rows with `room = '<slug>'`. The `'*'` rows are the main graph.
- **Invariant, tested:** a room's rows are a function of its own sessions and lessons. Deleting
  every other room's sessions leaves them byte-identical.
- **Anchor rule.** A session picked into several rooms is evidence in room R only for entities R
  also has from a single-room session or a lesson, so a shared "Weekly planning" thread cannot
  carry one client into another.
- What a room sees of a shared person or org: label, kind, and this room's counts and dates.
  Never the list of rooms, a global confidence, a close caused elsewhere, a short form measured
  elsewhere, or a hub role. Short forms keep every claimant; the one in view wins at read time.
- **Unfiled sessions** read the `unfiled` room, not a folder prefix. Only the owner surfaces (Deck,
  CLI, local) and the assistant or an agent granted every project read `'*'`.
- **Hub rule:** an org is a hub when it is in at least `max(3, rooms/2)` rooms, or passes today's
  session share and no project names it. An org taught as `client_of` is never a hub.

**Conflicts in the main graph**, highest first: the user's correction for that scope; a taught
fact; the extracted vote. When two rooms' winners differ and were seen within 90 days of each
other, the `'*'` row is marked `conflict` and the Deck asks "Same Dana Reyes?", which leads to a
merge or a split. Otherwise the older is closed in `'*'` and stays open in its own room.

### 2. Better resolution and new relations, still with no model on the hot path

Resolution: an address's local part matches a person across sessions when exactly one kept
person has that form and works at the address's domain (0.75); word-like TLDs and org words are
stripped when matching a domain to an org (`harlow.law` is Harlow Law); two names with one address
are one identity; `Dana M. Reyes` is Dana Reyes. The user can `memory.merge` two nodes and
`memory.split` one (outright, or by room: two different Danas).

| Relation | Source | Default |
|---|---|---|
| `has_title` | the appositive the curator already matches ("Dana Reyes, the office manager at Harlow Legal") | on |
| `client_of` | taught by Projects (a project's name and org), then user turns: "our new client X", "X is a client" | on |
| `repo_for` | a repo named after an org's short form, co-occurring in 2+ sessions; or taught from a workspace's git remote | on |
| `deadline` | user turns: "due / deadline / launches / ships (on / by) <date>", weekdays resolved against the turn's own time; closes two days after | on |
| `prefers`, `decided` | narrow user-turn patterns | off until the eval shows precision 0.8 or more |

All new relations are project-private. Note text is clipped to 160 characters and never appears in
an event.

### 3. Decay happens at read time

Derive never reads the clock, so "a second pass changes nothing" still holds. A new `seen`
column is the newest supporting turn over all evidence, not the capped six.
`fresh = max(floor, 0.5 ^ (days since seen / half-life))`: identity 365 days (floor 0.4),
`works_at` and `has_title` 180 (0.25), `client_of` 120, `decided` 60, `mentioned_in` 30;
a deadline is 1 until its date. User and confirmed facts do not decay. Enrich multiplies its score
by `fresh` and drops anything under 0.35 unless pinned. `memory.facts` still lists stale facts,
marked `stale` with "last said 7 months ago". Silence never closes an edge; only a moved winner, a
passed deadline or the user does.

### 4. The user corrects a fact, and that is a learning signal

`memory.correct {fact | {subject, rel, object}, action, object?, at?, scope?, note?}`:

| action | effect |
|---|---|
| `wrong` | never true: dropped from every vote in scope and never re-derived |
| `ended` | `valid_to = at`; older evidence can never reopen it, newer evidence can open a new row |
| `replace` | `ended`, plus a row sourced `user`, confidence 1, shown as "your correction, 3 days ago" |
| `confirm` | confidence 1, no decay, never closed by derive |
| `add` | a new user fact |

Corrections are rows (`memory_corrections`), applied in derive after the votes, and undoable
(`memory.uncorrect`). Newer transcripts that disagree with a user row raise a conflict for the
Deck; they never change it. Correct, merge and split are **owner callers only** (`deck`, `cli`,
`local`, `capsule`); a session never writes Memory, and inside a turn Claude proposes a correction
as a lesson instead.

`memory.corrected {id, action, rel, scope: "all"|"project", prior_source, prior_rule,
prior_confidence}` carries no labels, node ids (they contain names), addresses, notes or session
ids. Learning counts corrections per `prior_rule`; a rule the user corrects again and again is a
curation bug to see in `vyre learn signals`, not a lesson for Claude.

### 5. Measured, in CI

`test/fixtures/memory-world.js` extends the fictional corpus (the current `SESSIONS` stay as they
are) with: Keel & Ash Architects and Priya Anand; a second Dana Reyes at Bramble Dental (split);
Summit Dental and Summit Roofing in two projects (short-form collision); titles, a client, a
deadline, a preference, a decision; distractors ("API client", "ship it Friday" in code talk);
eight-month-old sessions; a hub thread picked into two projects.

`test/eval/memory-gold.json` lists expected facts per room, facts that must be absent (with why:
`leak`, `noise`, `wrong`), labelled prompts with expected fact ids, and irrelevant prompts.
`scripts/eval-memory.js [--json] [--real <db>]` prints precision and recall per relation and room,
leakage, precision@3 for Enrich, the empty rate on irrelevant prompts, and `relevant` p50/p95.
`--real` reads a temp copy, prints numbers only, and is never committed.

CI thresholds: leakage 0 (hard fail); identity precision 0.95, recall 0.85; `works_at` precision
0.95; the new relations 0.85; Enrich P@3 0.8; empty on irrelevant 0.95; `relevant` p95 under
5 ms on the eval corpus; no metric more than 0.02 below `test/eval/memory-baseline.json`.

### 6. More signals, each with a fingerprint

A signal is `{kind, session, seq, project, agent, key, lesson?, meta}`. `key` fingerprints what it
is about, so repeats can be counted; `meta` is small and never holds whole content.

| kind | detected by |
|---|---|
| `prompt` | `distill()` on the prompt (exists) |
| `repeated` | the same key in prompts from 2+ sessions within 30 days |
| `edited`, `rejected` | Gate: `gate.released {edited}` (exists), `gate.rejected` |
| `reverted`, `rewritten` | Learning hashes a file before Claude writes it and after; at the next prompt or Stop in that project it stats at most 20 recent writes. Back to the old hash is `reverted`; changed by someone else is `rewritten`. Hashes only |
| `failed`, `fixed` | PostToolUseFailure on Bash (a new hook piece) and PostToolUse widened to Bash. A test command failing after a change and passing after more edits is a `test-fix` run |
| `declined` | PreToolUse saw a call, Vyre did not hold it, and neither Post nor PostFailure came by Stop: the user said no in Claude Code's own prompt |
| `denied`, `allowed` | `tool.held` (exists) and `ask.answered` |
| `corrected` | `memory.corrected` |

### 7. Distilling: code first, a model off the path, the user always last

New check kinds, each with `invalid()`, `atTool`/`atStop` and an `enforced()` sentence:
`tool` (a tool or command is forbidden, optionally with `instead`), `path` (files that must not be
touched), `after` (run X after changing Y, checked at Stop), and `paths` on any check to narrow it
to files. New `distill()` shapes: an unquoted banned phrase, "don't use sed -i", "never push to
main", "use pnpm not npm", "don't touch migrations/", "in docs never use X", "always run lint
after editing ts", "run X before Y", and scope words ("in this repo", "everywhere").

Behaviour becomes a proposal without anyone saying it: one path reverted in 2 sessions proposes a
`path` check at ask; one command shape declined or denied 3 times in 14 days with no allow
proposes a `tool` check at ask; a test-fix run where Claude stopped without re-running the tests
proposes an `after` check at remind. Anything inferred starts at remind or ask, never block.

Signals no pattern fits queue as `learn_jobs`. A job runs through the Switchboard as a headless
`claude -p --model haiku` thread on the user's own quota: one at a time, 10 minutes apart, at most
6 a day by default, never while a user thread is working, triggered by events only. The thread
has no plugin (so its own prompt proposes nothing) and no tools, and must answer strict JSON. Every
result is validated and becomes a **proposed** lesson only. Without the Switchboard, jobs wait
(capped at 200) and `vyre learn signals` shows them for the user to write by hand. Learning never
spawns `claude` itself.

### 8. Scope

Inferred in order: an explicit scope word; the agent (`VYRE_AGENT`); a check naming paths in the
project, a project command, a revert or a test run gives `{project}`; style checks (characters,
phrases) give `all`. A proposal whose key also appeared in another project widens to `all` and
says so. The user narrows or widens with `vyre learn scope` or in the Deck.

### 9. Escalation and measurement

remind → ask → block stays. New per-lesson `max_level` (the user's cap) and `pinned` (no
automatic change). Nothing weakens on its own: a lesson quiet for 60 days and 200 turns in scope
goes `dormant` (out of the brief, check still running); an `ask` lesson allowed 5 times out of 5
proposes a demotion, which the user decides.

**Does a lesson work?** Per day Learning counts turns in scope (`learn_days`) and per lesson
applied, caught, broken and **repeats** (signals with the lesson's key: the user correcting the
same thing again) in `learn_lesson_days`. Before = repeats per 100 turns from the first signal to
acceptance. After = escapes (broken + repeats) per 100 turns since. `working` when after is at most
half of before with 50 turns measured, `not working` when after is at least before, else
`measuring`. Shown in `vyre learn` and the Deck.

### 10. Skills from repeated procedures

At Stop, a turn's steps (command shapes and file kinds, consecutive repeats collapsed) are hashed
with their 3 to 6 step runs, at most 40 hashes. At the next prompt the turn is marked clean unless
it was corrected or sent back. One hash clean in 3 sessions becomes a candidate; a test-fix run is
a candidate on its own shape. A job drafts the SKILL.md (frontmatter `name: learned-<kebab>`,
`description: Use when ...`); without the Switchboard a template lists the steps.

Installing a skill is presence-only: it is instructions every future session follows. The user
sees the whole body; its hash is kept and drift is reported. Where it goes:

- account: `<home>/learned/`, a plugin of its own (`.claude-plugin/plugin.json`, `skills/`),
  loaded by Switchboard threads as a second `--plugin-dir` and registered by `vyre harness install`;
- project (default for project-scoped): `<project home>/.claude/skills/learned-<name>/`, Claude
  Code's own project scope, or with `--private` under `<home>/learned/projects/<slug>/`;
- agent: `<home>/learned/agents/<name>/`.

Never `~/.claude/skills` (the user's own setup is not ours to change) and never `harness/skills`.

### 11. Enforcement that cannot be dodged

Principle: **anything that makes Vyre stricter is free; anything that makes it looser needs a
person.** Accepting a lesson only constrains the model, so it can come from the user's own words;
retiring or weakening one needs presence (ADR 0004).

- **Accept by reply.** When a proposal was told to a thread, Learning remembers the proposal and
  the thread. The user's next prompt arrives through the UserPromptSubmit hook, which Claude Code
  fills from what the user typed. A plain yes ("yes", "keep it", "yes, keep lesson 7") accepts it
  inside Learning, with no tool call; a no declines it. The CLI (`vyre learn accept`), the Capsule
  (signed click) and the Deck (passkey) accept with presence as the floor list says.
  `learn.accept` stays on the presence list; accept by reply is not a tool, so there is nothing
  for a model to call. A model that forges a hook call to accept can only make rules stricter,
  and the forge itself is asked (below).
- **Weakening is presence.** `learn.edit` refuses a change that lowers the level, narrows the
  scope, removes or loosens the check, narrows `when`, or lowers `max_level`, and names
  `learn.relax`, a new presence tool that does those. `learn.retire` and skill install stay
  presence. Tightening stays free.
- **Guards before tools** (extend `weakens()`, asked at every level, online and offline): writes
  or shell commands reaching `lessons.json`, `learn-offline/`, `vyre.db`, the socket, the home's
  `learned/`, the Harness's `hooks.json` or `hook.js`, Claude Code settings files that could drop
  the plugin or its hooks, `vyre call learn.*|harness.*`, and stopping vyred.
- **Offline, complete.** The snapshot carries each project lesson's folders and matches `cwd` by
  prefix; agent lessons match `VYRE_AGENT`. When `lessons.json` is missing or unreadable, the hook
  reads the lessons read-only from `vyre.db`. vyred keeps the hash of the snapshot it wrote; a
  file that differs at start is a `tampered` signal, rewritten at once.
- **After the cap.** Two send-backs then the turn ends, and the break costs something: the lesson
  is broken (and escalates), the next prompt in that thread opens with it, the next brief in the
  project says "broken N times this week", and `lesson.broken` reaches the Capsule and the Deck.
  Waiting a check out is visible.

### 12. The contract

Memory `module.json`: `does` adds `memory.correct`, `memory.corrections`, `memory.uncorrect`,
`memory.merge`, `memory.split`; `watches` adds `memory.corrected`, `memory.merged`, `memory.split`;
`shows` `{deck: ["panel:memory"], capsule: ["answer:memory.relevant"], cli: ["memory", "why"]}`.

Learn `module.json`: `requires` names what it calls (`projects`, `harness`; `gate` and `threads`
are optional and degrade); `does` adds `learn.relax`, `learn.signals`, `learn.stats`,
`learn.skills`, `learn.skill_install`, `learn.skill_retire`, internal `learn.observe`; `watches`
adds `lesson.dormant`, `skill.proposed`, `skill.installed`, `skill.retired`, `distill.finished`;
`shows` `{deck: ["panel:memory/lessons"], capsule: ["waiting:lesson.proposed"], cli: ["learn"]}`;
`teaches` `{memory: ["preference"]}` (an accepted "use pnpm not npm" teaches the user prefers pnpm,
forgotten on retire).

Events carry ids, counts, kinds and levels. The rule text is the one exception, on
`lesson.proposed` and `lesson.learned`, because every surface must show the user what they are
agreeing to; it is the user's own sentence, redacted.

CLI: `vyre memory [about] [--project <slug>]`, `vyre memory correct|pin|mute|merge|split`,
`vyre why <fact>`, `vyre learn [show|add|accept|edit|relax|retire|scope|stats|signals|skills]`.

### 13. Surfaces

- **Deck Memory** (owned by Intelligence: `deck/views/memory*.js`, `deck/css/views/memory*.css`):
  one `memory.graph` call with the `since` cursor; nothing refetched while the tab is hidden; a
  scope select (Everything or one project); gold provenance on every fact (thread name, age,
  confidence, link to the exact turn); inline pin, mute and correct (the fact becomes a field;
  ⌘⏎ saves, Esc cancels, Undo is another correction). Phone is the list.
- **Lessons** are a tab in Memory (`/memory?tab=lessons`): proposed, active, retired, and proposed
  skills, with counts and the effect verdict. Accept, retire, relax and install go through the
  Deck's passkey flow. Settings keeps a link.
- **Capsule:** memory answers stay gold and gain age and confidence; lesson proposals become a
  Waiting item (not gold) that the user accepts with a signed click; they never raise attention on
  their own.

## Consequences

- Derive is about a quarter slower on a cold pass, estimated; `relevant` stays under 2 ms p95 on
  the real corpus, measured before merge. No new timers anywhere; decay, deadlines and the effect
  verdict are computed when read.
- Learning grows tables; `learn_commands` and the per-turn tables keep 7 days, pruned at start and
  at most hourly.
- Other teams:
  - `security`: accept by reply is a deliberate path around the `learn.accept` tool, add
    `learn.relax` and `learn.skill_install` to the floor list.
  - `switchboard`: `threads.launch` with `plugin: false`, `tools: "none"` and one-shot, a second
    plugin dir, and `tool` in `ask.answered`.
  - `deck`: the presence flow in `api.js`, the `learn` module name, turn links with `?seq=`, and
    lessons in Now's needs.
  - `capsule`: the lesson Waiting source and signed accept.
  - `projects`: picked thread ids in `projects.list`, and teaching `project.client` and
    `project.repo`.
- Rejected: a model on the hot path; silent decay of lessons; letting Claude call accept after a
  yes in chat (ADR 0004 closes it, and accept by reply keeps the experience); installing learned
  skills into `~/.claude`.

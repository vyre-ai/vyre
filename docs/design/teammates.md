---
title: "Teammates: default, and distinct in chat"
summary: Makes project teammates the default over subagents in every Vyre SDK session, adds @role routing that creates a teammate on first use, and makes a teammate's handoffs distinct in chat without a per-teammate colour.
audience: builders, agents
owner: chat
status: draft
---

Section 3 is settled (app-design 83434944); sections 1 and 2 are still building. See "What ships,
and by whom" below for which team owns each piece.

# Teammates: default, and distinct in chat

Builds on [ADR 0031](../adr/0031-teammates.md), which already has the tools (`team.ask`, `team.list`,
...), the inbox, notes, and worktree isolation built (through step 4, held on work/projects
landing). What is missing, and what this doc decides, is the user's 2026-09-28 ask: make
teammates the default, and make them look distinct in chat. Three pieces, in order of who builds
them.

## 1. Default: every project session gets team tools

Today (ADR 0031 section 4) a session only gets `team.*` tools when its project already has a
teammate. That is backwards for a default: a project with zero teammates is exactly the case
where `@role` (section 2) needs to work, so it can create one.

**Decision:** every Vyre SDK session started in a project (owned or shared, not a bare box
session with no project) gets the `team.*` tools and the policy append, whether or not the
project has any teammates yet. This is a `sessions` change, not a `core/team` one: `sessions` is
what decides a session's tool set and append per ADR 0030, and `core/team` must stay reachable
through `ctx.call` only (module boundary, `test/boundaries.test.js`). Concretely:

- `sessions`'s session-start path calls `team.list` (or a cheaper does-this-project-have-any-teammates
  call, name TBD with sessions) for the project and includes `team.*` in every project session's
  tool set regardless of the result.
- The append (ADR 0031 section 5's paragraph) is written by `core/team` today
  (`core/team/index.js`'s `preamble`/append path is for a *teammate's own* session; the append for
  an *ordinary* session asking about teammates does not exist yet and is new work here) and handed
  to `sessions` to inject, same as the project brief and memory today. With no teammates yet, the
  line changes from "this project has teammates: ..." to:

  > This project has no teammates yet. For an ongoing role (design, review, research, QA) prefer
  > team_ask with a new role name, it creates one on first use, over a subagent. Use a subagent
  > only for a one-off lookup or a burst that needs no memory.

- **The off switch.** A per-project setting, `team.default` (on by default, person-only,
  `sessions.limits`-shaped: `{project, enabled}`), turns this off. Off means: no append line, no
  auto-create on `@role` (section 2 still lists and asks existing teammates, it just cannot make
  new ones), and the Task tool is not de-emphasized. Existing teammates keep working either way,
  this switch is about steering new work, not removing what is already there. Surfaced in Project
  settings, alongside the project's other team settings.
- **Ongoing vs one-off** is a judgement call the append states but does not enforce (as today):
  design, review, research, QA and similarly-shaped recurring work read as "ongoing"; a single
  file read, a burst of screenshots, or a lookup that needs no memory of its own reads as
  "one-off". The Agents place's existing "subagents doing a teammate's job" signal (ADR 0031
  section 5) is the backstop when the guidance is ignored.

**Owner: sessions.** This is the one piece that must land in `core/sessions`/`switchboard`
(session start, tool set, append plumbing) rather than `core/team`. `core/team` provides the two
append strings and the `team.default` setting; sessions wires them into every project session's
start.

## 2. `@role` in chat: route, and create on first use

**Decision:** typing `@name` at the start of a chat message (Chat, the Capsule, the phone) sends
that message as a `team.ask` to the teammate named `name` in the current project, instead of
spending the current session's own turn on it: this is already described in ADR 0031 section 5
("a person who types `@design` ... sends a request without spending the current session's turn").
What is new:

- **If no teammate named `name` exists** in the project (and `team.default` is on), chat calls
  `team.add` there and then, with:
  - `role: name` (lowercased, `SLUG`-checked, same charset as `agentName` today);
  - a generic template (no role-specific brief guessed from the name, guessing wrong is worse
    than asking) with `brief: "Ask me about anything; I'll figure out the role from what you send
    me."`, `isolation: folder` (never `worktree` by default: code isolation is a deliberate,
    person-made choice per ADR 0031 section 7, not a side effect of typing a word with an `@` in
    front of it), `tools: files, web` (no shell, no connectors, until a person's Setup tab grants
    more);
  - **model: Sonnet**, not the ADR's stated default of Opus. This is the one place this doc
    changes ADR 0031 section 1's table: a teammate created by a person deliberately (`vyre team
    add`, the Agents place) still defaults to the `teammate` purpose (Opus); a teammate created by
    `@role` on the fly defaults to Sonnet, because it exists on a guess and should not spend Opus
    turns proving out a role nobody has scoped yet. The person can change it in Setup at any time;
    once changed, later requests use the new model like any other teammate.
  - This is a real `team.add` (`PERSON_ONLY` today): the chat message that typed `@role` is the
    person's own input in their own surface, so this is the person creating it, exactly as typing
    it into the Agents place would be. No session or teammate can trigger this path; it only fires
    from a verified person surface (Chat, Capsule, phone), the same check `team.add` already makes.
  - Chat shows a small inline confirmation before the request goes: "There's no `research` teammate
    yet, I'll create one and send it your message." with an inline "Don't create, just answer
    this here" fallback that routes the message as an ordinary chat turn instead. This is one
    click, not a form; the Setup tab is where the brief gets refined afterward.
- **If `team.default` is off** and no teammate exists, `@role` shows "There's no `role` teammate in
  this project. Add one in Setup, or turn Teammates on for this project." and does not send.
- **Ambiguity:** `@role` matches on the teammate's `role` slug only (not its brief, not fuzzy). A
  typo makes a new teammate rather than silently going nowhere: cheap to remove, and the
  chat-side confirmation is exactly where a typo gets caught ("There's no `desing` teammate yet").
- **Where this is built:** the routing and the confirmation card are `chat`'s (this doc's UI
  agreement, section 3); the create-on-first-use call is a straight `team.add`, no new tool needed.
  `app-design` and `chat` agree the confirmation card's look together (section 3).

## 3. Distinct in chat

The user's ask was "a teammate's turns show its role name and avatar with a distinct accent, a
handoff shows as a visible card, and teammates' own threads are one tap away." app-design ruled
out the accent-color part of that (below), and the lead confirmed the ruling stands; what
follows is the settled design (app-design, sha 83434944 on work/app-design,
`docs/design/system/components/avatar.md` and `tool-row.md`), not a proposal.

**No per-teammate colour, anywhere in the Deck, the App or the Capsule.** The product's colour
economy is closed: lime for action/focus/running/selection, violet for Needs you (teal the one
alternative), no other hue, and devices/hosts already don't get one
(`docs/design/one-app/README.md`'s System section). A teammate is that same kind of entity, not
a person, so a role-hashed accent (disc, border, dot, ANSI square) was the first crack in a rule
that reads fine at 3 teammates and breaks at 8, and is the kind of thing nobody walks back once
it ships. The earlier draft of this section proposed exactly that hashed accent; it is turned
down.

Distinct instead means three things, none of them colour:

- **Tile + name, always together.** The teammate's avatar tile (the existing neutral agent tile,
  `avatar.md`, unchanged: lowercase initial, no colour, same as `kit` or `juno` today) is never
  shown bare. Wherever a teammate appears (its handoff row, its Agents place row, its thread
  header) the role name sits directly beside the tile in text, same weight as any agent name
  elsewhere. The name is what tells teammates apart; the tile carries no more meaning than any
  other agent's.
- **A "Teammate" tag.** A plain `Tag` (`chip.md`: `--hover` fill, no border, 12/16 `--text-2`)
  sits after the role name in exactly those three places, once per surface, so a thread header
  shows it once at the top, not again on every turn. This is what says "design, a persistent
  project teammate" rather than a one-off subagent or the assistant, in words, since nothing here
  is said in colour.
- **The handoff row.** Not a new component: a `Handoff` variant of the existing tool-row
  (`tool-row.md`). It uses the teammate's own avatar tile (not the generic subagent icon), and
  its summary reads "Asked **design** [Teammate] to make the intake form calmer", verb flips to
  "Replied" once the result lands. It folds and unfolds like any tool row (default: folded,
  showing the summary only), but it is exempt from `tool-row.md`'s "folded run" collapse that
  bundles quiet tool calls into one summary line, the same exemption a plan or a todo list gets:
  a handoff is always its own line, and "collapsed" only ever means the reply detail is shut,
  never that the row itself is missing. The expanded detail is the teammate's prose reply,
  rendered as turn prose (`turn.md`), not a code block on `--code-bg`, since it is written
  language, not a tool's output. This also settles the earlier open question about a distinct
  message bubble for a teammate's result: there is no freestanding bubble. A teammate's reply
  never becomes an ordinary assistant-style message; it lives only inside the handoff row's
  expanded detail, so there is nothing to mistake for the session's own words and nothing extra
  to style.
  - If the result arrives after the person has moved to a different chat (their session slept or
    they navigated away), the same row appears retroactively in that session's history next time
    it is opened, plus the existing notification/Needs-you-adjacent surfacing ADR 0031 section 4
    already specifies for person-originated requests. No new delivery mechanism: this is a
    rendering rule over the same `threads_inbox` item.
- **One tap away.** Every handoff row, and every row for a teammate anywhere (Agents place,
  `@role` in the composer, the confirmation card in section 2), opens that teammate's own thread
  in one tap (`list-row.md`'s existing "row pushes a screen" pattern): its
  Now/Inbox/Results/Notes/Setup pane (ADR 0031 section 9), scrolled to the request in question
  when opened from a row. This reuses the Agents place's existing detail pane; chat does not
  build a second teammate viewer.
- **The one colour exception: the CLI.** `vyre team` and `vyre team ask <role>` may colour a
  teammate's name with a role-hashed ANSI 256 colour, but only from a small fixed set (about 8,
  pre-picked and AA-tested), never an arbitrary hash-to-hue, so a teammate's colour can never
  land near lime or violet and misread as a status signal. Text-only (never a fill), degrades
  under `NO_COLOR`, the same convention terminal tools like `git log --graph` already use, and it
  never touches the Deck/App/Capsule's colour economy. The palette values land with whoever
  builds the CLI side; the rule (fixed set, name-only, never a fill) is settled now.

## What ships, and by whom

1. **sessions:** the default-on team-tools-and-append wiring (section 1) into session start; the
   `team.default` setting; the cheap "does this project have any teammates" check `core/team`
   exposes for it. This is the one piece that must land in sessions/switchboard rather than
   core/team, per the module boundary.
2. **teammates (`core/team`):** the two append strings (with/without existing teammates); the
   `@role`-created-teammate defaults (Sonnet, `folder`, minimal tools) as a documented `team.add`
   call shape, not a new tool; nothing here needs a schema change to `agents_teammates`, a
   Sonnet-purposed, `folder`-isolated teammate is just a normal row.
3. **chat:** the `@role` composer routing and create-on-first-use confirmation (section 2); the
   handoff row, the tile+name+tag treatment, and the one-tap-to-thread links (section 3), against
   app-design's settled spec.
4. **app-design:** done for section 3: `docs/design/system/components/avatar.md` (unchanged
   neutral tile) and `tool-row.md` (the Handoff variant, the "never folds" exemption), sha
   83434944 on work/app-design. The CLI's fixed ANSI palette values are the one open item, for
   whoever builds the CLI side.

Sequencing: section 1 (sessions) can start immediately, it does not depend on section 2 or 3.
Section 2 (`@role` create-on-first-use) only needs section 1's `team.default` setting to exist;
chat can build the routing logic against the existing `team.ask`/`team.add` tools today and wire
the setting check in once sessions ships it. Section 3 is a design pass (chat + app-design) that
can run in parallel with 1 and 2, landing once both agree.

## Non-goals here

- Not touched: worktree isolation, the integrator, merging (ADR 0031 section 8). An `@role`
  teammate defaults to `folder`, never `worktree`, so none of that machinery engages until a
  person deliberately upgrades it in Setup.
- Not touched: sharing across projects (section 12) or the assistant-wide assignment. `@role`
  only ever creates a teammate scoped to the current project.
- Not a new tool: no `team.autoAdd` <!-- terms: ignore --> or similar. `@role`'s create-on-first-use is `chat` calling
  the existing `team.add` with a specific default shape; keeping it a plain `team.add` call means
  Setup, `vyre team`, and the Agents place all see and can edit the result the same way they see
  any other teammate.

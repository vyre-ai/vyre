# teammates

Branch: work/teammates · Worktree: ../vyre-teammates · Decisions: [ADR 0031](../adr/0031-teammates.md)

Scope: persistent project teammates (a named agent per role per project, durable notes, a serial
inbox, a summon tool in every session of the project), designed on ADR 0030's session model. The
new module is `core/team`. Surfaces are built by app-design, chat, mobile and capsule on the
contract in ADR 0031. No build until ADR 0030 steps 1 to 3 land.

## Done
- ADR 0031 drafted (number claimed in docs/work/README.md, front matter, nav.json entry).
- docs:ref regenerated (docs/index.json, docs/reference/index.md); on testbox
  test/docs-build, docs-check, docs-index, docs-shots: 61 of 61 pass (again after merging main
  and the user's decisions, 2026-09-27).
- Section 14 (lead's user requirement): per-project concurrency limits (active teammates,
  subagents), a box-wide ceiling, a fair slot queue with position and ETA, the usage-aware pause,
  presets Light / Balanced / Max / Custom with estimated peak usage.
- Read: ADR 0030 (work/sessions), core/agents, core/projects, core/memory, presence and the
  daemon's agent checks, ADR 0028's agent grants (work/vault-next), the one-app Agents and Needs
  boards (work/app-design), Paseo's agent tools and lifecycle docs.

## Doing
- RESUMED (2026-09-28): merged origin/main (bc751624/68463d04, batch 4, sessions' slot ledger)
  cleanly, no conflicts. Building migration step 1. Sha a876e5e4 has it green; see below.

## Where ADR 0031 stands
- Built (step 1, a876e5e4): `core/team` (roles box, local; requires threads, projects, sessions).
  Tables `team_teammates`, `team_requests`, `team_notes`. Tools `team.add` (PERSON_ONLY),
  `team.list`, `team.ask`, `team.status`, `team.cancel`, `team.done`, `team.fail`, `team.notes`
  (get/set, versioned, written to `<project home>/.vyre/team/<role>/notes.md`). A priority-ordered
  serial dispatcher (`pump`): one request running per teammate, urgent first then oldest; takes a
  `sessions.slots` teammate slot in the *requesting* project (section 12's rule, ready for
  sharing) before it launches via `threads.launch`, releases it on `team.done`/`team.fail`, and
  posts the result into the caller's thread with `threads.post {kind: "teammate-result"}`. A turn
  that ends without either call closes the request as failed rather than leaving it (and the
  slot) stuck. `vyre team [add|ask|status|cancel|notes]`. 8/8 tests green against the fake claude
  driver (core/team/team.test.js); boundaries clean (core/team imports only the kernel and calls
  other modules through ctx.call); docs:ref regenerated, all 61 docs tests still green;
  switchboard+agents+presence suites (52+54) still green after the fake-claude and presence
  changes below.
- Two small deliberate simplifications from the ADR's literal text, both to keep step 1 small and
  both safe to build on:
  - A teammate is its own `team_teammates` row, not an `agents_agents` row of kind `teammate`
    (section 1). Reusing `agents` would need a manifest change there (`kind` enum) and pulls in
    agents' own auth/budget model before it is needed; `core/team` drives `threads.launch` /
    `threads.post` / `threads.get` directly, the same tools `agents` itself uses, so nothing about
    the switchboard contract changes. Revisit at step 8 (converting today's agents).
  - `team.done`/`team.fail`'s `request` is optional and defaults to the caller's one running
    request (a teammate only ever has one). The ADR's wrapped `<vyre-request id="...">` still
    carries the id for a teammate that wants to be explicit; this just means it never has to be.
- Not yet built: notes-changed enforcement on `team.done`, compaction re-injection and rotation
  (step 2); the in-process MCP server and `@role` routing, summon from every session (step 3);
  worktrees and the integrator (step 4); sharing (`team.share`, per-project notes parts/grants,
  step 5); the Agents place tabs and Needs rows (step 6); `team.propose`, role templates, project
  setup (step 7); offering today's single-project agents conversion (step 8); `using/teammates.md`
  and the reference pages (step 9, the CLI/tools reference already regenerates itself).
  `team.cancel` only cancels a queued request for step 1 (a running one needs a person, and
  refuses naming what to do instead: stop the teammate's session, or `team.fail` from inside it).
  The cycle/depth-3 check (`via`) is implemented and exercised by `team.ask`'s own logic, but not
  yet by an integration test: that needs a teammate's own session to call `team.ask` on another,
  which is easiest to script once step 3's in-process MCP server exists rather than through the
  fake driver's text-prompt scripting.
- app-design boards approved (work/app-design 99820a16 and 6a1e2f7a) — not yet consumed (step 6).

## Next
1. e2e security review of the tools' caller rules (asked, 2026-09-28) before calling step 1 done.
2. Step 2: notes-changed check on team.done, compaction re-injection, rotation.
3. Step 3: summon tool in sessions' MCP list, result injection, per ADR 0031 and the lead's brief.

## Settings this feature needs (handed to native-core for Settings)
Declared by native-core (work/native-core 42dcb98c, core/sessions/module.json settings list):
sessions.max_active, sessions.max_subagents (per project, via sessions.limits.get/set),
sessions.box_teammates, sessions.box_subagents, sessions.model.teammate, sessions.model.helper.
Not declared yet: preset, pause_at_warning, api_fallback (sessions' manifest when built);
push_after_merge, test_command, daily_turns (core/team's manifest when built). Rows appear in
Settings from a manifest "settings" list with no Deck work.
Per project (Project settings > Teammates > Limits):
- `team.preset`: `light` (1, 2) | `balanced` (3, 4, default) | `max` (6, 10) | `custom`. Suggest
  Light with one line when the rate-limit signals show a Pro plan; never preselect Max.
- Per-project limits are set with `sessions.limits.set {project, max_active (1 to 8),
  max_subagents (0 to 16)}` (person-only), as built by sessions.
- Impact line: peak = teammates + 0.3 x subagents Opus sessions (1.6, 4.2, 9); shown as how long a
  5-hour window lasts at the peak; "estimate" until a week of history, then measured from
  `thread.usage`.
- `team.pause_at_warning`: on (pause new starts at `allowed_warning` or utilization >= 0.8).
- `team.api_fallback`: off (use the API key when the plan is exhausted; bills per call).
- `team.push_after_merge`: off. `team.test_command`: detected, editable.
Per box (Settings > Box), capping every project:
- `sessions.limits.max_active_teammates`: 6. `sessions.limits.max_subagents`: 8.
Models (Settings > Models):
- `models.purposes.teammate`: Opus. `models.purposes.helper`: the faster model.
Per teammate (its Setup tab):
- `daily_turns`: 200 on a subscription; `budget_usd` per day and month on an API key; model
  override; tools; isolation; shared projects or assistant; grants per project.
Read-only state to show: the plan's usage per auth from `thread.limit` (status, window kind,
utilization, resets_at), the slot chip (per project), the waiting queue, "Resume anyway".

## Needs from others
- sessions: the slot ledger (`sessions.slots`, events `slot.taken|released|queued`), the Task-tool
  hold in canUseTool, SubagentStop release, per-auth usage state and pause from `thread.limit`.
  TAKEN by sessions (2026-09-27): builds it after batch 3a, plus purposes `teammate` (opus) and
  `helper` (haiku); the rest (teammate-result kind, team.* in-process, compact hook, context used)
  after slots.
  BUILT on work/sessions after 4311fca5 (not in batch 3a): sessions.slots, the subagent hold,
  purposes, threads.post kind teammate-result, thread.usage.context.share, compact via the
  plugin's SessionStart plus harness.brief. Still open there: the per-auth usage pause, team.* in
  phase 3 (their per-thread plugin socket, which is fine by us), and a no-wake option on
  threads.post for a closed caller (asked).
- sessions: the purpose map (`models.purposes`, purposes `teammate` and `helper`); a
  `teammate-result` item kind in `threads_inbox`; `team.*` in the phase 3 in-process MCP server;
  SessionStart `compact` re-injection hook.
- app-design: DONE (work/app-design 99820a16, canvas https://claude.ai/artifact/Ap7uKGmbiEs4wM44iSyi1X,
  row "Teammates (ADR 0031)"): Agents place, Needs kinds, Limits. Reviewed and approved; asked for
  a "box full" reason on waiting rows and "On another project's request" instead of a client name.
- vault: `vault.agent.grant` on a teammate's agent name; revoke on removal; a `project` column on
  `vault_agent_grants`, checked on release for shared teammates (the lead told vault).

## Changed contracts
- New module `team` (a876e5e4): tables `team_teammates`, `team_requests`, `team_notes` (own,
  not `agents_agents` — see "Where ADR 0031 stands" above); tools `team.add`, `team.list`,
  `team.ask`, `team.status`, `team.cancel`, `team.done`, `team.fail`, `team.notes`; events
  `teammate.created`, `summon.queued`, `summon.started`, `summon.finished`, `summon.cancelled`.
  Talks to `threads`, `projects` and `sessions` only through `ctx.call` (boundaries.test.js clean).
- presence (a876e5e4): `team.add` added to `PERSON_ONLY` in `core/presence/index.js` — a
  teammate is made by a person, never a session or another teammate.
- switchboard/testing/fake-claude.js (a876e5e4, test-only): its `"vyre <tool> <json>"` prompt
  line is now found anywhere in the prompt, not only when the whole prompt starts with it, so a
  teammate's `<vyre-request>`-wrapped text can still script a tool call from a test. At the start
  it behaves exactly as before (multi-line JSON still works); found further in, only that one
  line is taken as the call, so it never swallows what follows it (the wrapper's closing tag).
  Every switchboard/agents/presence test still green (52+54) after this change.

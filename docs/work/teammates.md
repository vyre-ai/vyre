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
- PAUSED (2026-09-27, the lead): the user refocused on the native core. Last sha before this note:
  c2711b6f, staged in batch 3b.

## Where ADR 0031 stands
- Built: nothing. Design only: ADR 0031 is complete with every user decision in (integrator
  auto-merge, sharing and assistant-assigned teammates, one per role, notes per project folder,
  offered conversion, 200 turns a day, Balanced default, section 14 approved). Docs tests 61 of 61.
- app-design boards approved (work/app-design 99820a16 and 6a1e2f7a).
- Blocked on ADR 0030 steps 1 to 3 (sessions) before any build.

## Next (when resumed)
1. Merge main, then migration step 1: core/team (tables, team.*, inbox, CLI) against the fake
   driver, with the slot ledger and usage pause in sessions (or through its contract).
2. Steps 2 to 9 of the ADR's Migration section, in order.

## Settings this feature needs (handed to native-core for Settings)
Per project (Project settings > Teammates > Limits):
- `team.preset`: `light` (1, 2) | `balanced` (3, 4, default) | `max` (6, 10) | `custom`. Suggest
  Light with one line when the rate-limit signals show a Pro plan; never preselect Max.
- `team.max_active`: 1 to 8 (active teammates at once). `team.max_subagents`: 0 to 16.
- Impact line: peak = teammates + 0.3 x subagents Opus sessions (1.6, 4.2, 9); shown as how long a
  5-hour window lasts at the peak; "estimate" until a week of history, then measured from
  `thread.usage`.
- `team.pause_at_warning`: on (pause new starts at `allowed_warning` or utilization >= 0.8).
- `team.api_fallback`: off (use the API key when the plan is exhausted; bills per call).
- `team.push_after_merge`: off. `team.test_command`: detected, editable.
Per box (Settings > Box), capping every project:
- `limits.max_active_teammates`: 6. `limits.max_subagents`: 8.
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
- sessions: the purpose map (`models.purposes`, purposes `teammate` and `helper`); a
  `teammate-result` item kind in `threads_inbox`; `team.*` in the phase 3 in-process MCP server;
  SessionStart `compact` re-injection hook.
- app-design: DONE (work/app-design 99820a16, canvas https://claude.ai/artifact/Ap7uKGmbiEs4wM44iSyi1X,
  row "Teammates (ADR 0031)"): Agents place, Needs kinds, Limits. Reviewed and approved; asked for
  a "box full" reason on waiting rows and "On another project's request" instead of a client name.
- vault: `vault.agent.grant` on a teammate's agent name; revoke on removal; a `project` column on
  `vault_agent_grants`, checked on release for shared teammates (the lead told vault).

## Changed contracts
- None yet (design only). Proposed: module `team`, tables `agents_teammates`, `team_requests`,
  `team_notes`; events `teammate.*` and `summon.*`; kind `teammate` in agents.

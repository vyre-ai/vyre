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
- Lead approved (2026-09-27): per-project notes parts in each project's own folder, shown as one
  file; per-project vault grants (the lead told vault about the `project` column).
- User decisions folded in (auto-merging integrator, sharing and assistant-assigned teammates,
  one per role, notes per project folder, offered conversion, 200 turns a day, Balanced default).

## Next
1. When ADR 0030 steps 1 to 3 are on main: migration step 1 (core/team, fake driver), then 2 to 8.

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

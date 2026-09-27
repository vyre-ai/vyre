# teammates

Branch: work/teammates · Worktree: ../vyre-teammates · Decisions: [ADR 0031](../adr/0031-teammates.md)

Scope: persistent project teammates (a named agent per role per project, durable notes, a serial
inbox, a summon tool in every session of the project), designed on ADR 0030's session model. The
new module is `core/team`. Surfaces are built by app-design, chat, mobile and capsule on the
contract in ADR 0031. No build until ADR 0030 steps 1 to 3 land.

## Done
- ADR 0031 drafted (number claimed in docs/work/README.md, front matter, nav.json entry).
- Read: ADR 0030 (work/sessions), core/agents, core/projects, core/memory, presence and the
  daemon's agent checks, ADR 0028's agent grants (work/vault-next), the one-app Agents and Needs
  boards (work/app-design), Paseo's agent tools and lifecycle docs.

## Doing
- Waiting on the user's answers to the ADR's six open questions, relayed by the lead.

## Next
1. Fold the user's answers into ADR 0031.
2. When ADR 0030 steps 1 to 3 are on main: migration step 1 (core/team, fake driver), then 2 to 8.

## Needs from others
- sessions: the purpose map (`models.purposes`, purposes `teammate` and `helper`); a
  `teammate-result` item kind in `threads_inbox`; `team.*` in the phase 3 in-process MCP server;
  SessionStart `compact` re-injection hook.
- app-design: the Agents place tabs (Now, Inbox, Results, Notes, Setup), the summon box, the
  Needs kinds "New teammate", "Merge", "Stuck".
- vault: `vault.agent.grant` on a teammate's agent name; revoke on removal.
- The user: the six open questions in ADR 0031.

## Changed contracts
- None yet (design only). Proposed: module `team`, tables `agents_teammates`, `team_requests`,
  `team_notes`; events `teammate.*` and `summon.*`; kind `teammate` in agents.

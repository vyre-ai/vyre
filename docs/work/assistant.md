# assistant

Branch: work/assistant · Worktree: ../vyre-assistant · Owner session: assistant

## Done
- docs/design/assistant.md: audit of what the assistant is today (by file), 10 opportunities
  ranked by value/cost, the delegated-authority core design (scoped delegations, never-delegate
  list, provenance/taint tied to memory-iq's heard.js pattern, Undo + log, vault specifics), and
  6 open decisions with recommendations for the user.

## Doing
- 0.2 Phase 1 (planning, no product code): plan written at <team-dir>/0.2/plans/assistant.md;
  interface asks posted to <team-dir>/0.2/CHAT.md for sessions, teammates, iq, vault,
  capsule-pro, capsule-sight and tailnet. Waiting on replies and reviewer-2's review.

## Next
- Answer CHAT replies and fold them into the plan. Build starts only after the lead brings
  PLAN.md to the user. First build step: rebase this branch on main (1036 commits behind; the
  pre-0.2 digest and context work is saved as wip 9e6780c4).

## Needs from others
- vault (work/vault-next): the real session-credentials contract once designed, to cite by name
  instead of by intent in section 3.5.
- tailnet: timeline on the vitals module (docs/design/vitals.md) and whether an assistant-kind
  caller gets a read carve-out — currently refuses all agent callers outright.
- connectors: a `calendar.list`-shaped contract (opportunity 6) doesn't exist yet; don't build
  against a name it hasn't defined.
- cohesion/sessions: whoever owns core/context for the device-local time/day field (open
  decision 4).

## Changed contracts
- None yet. This round was design-only, no code changed.

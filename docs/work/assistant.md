# assistant

Branch: work/assistant · Worktree: ../vyre-assistant · Owner session: assistant

## Done
- docs/design/assistant.md: audit of what the assistant is today (by file), 10 opportunities
  ranked by value/cost, the delegated-authority core design (scoped delegations, never-delegate
  list, provenance/taint tied to memory-iq's heard.js pattern, Undo + log, vault specifics), and
  6 open decisions with recommendations for the user.

## Doing
- Nothing in flight. Report sent to lead; waiting for direction (build the digest/triage
  opportunities, or hold for the user's decisions).

## Next
- If the user green-lights: build opportunity 1 (assistant.brief digest) and 3 (device-local
  time/day on context.now) first — both S-cost, no dependency on other teams shipping first.
- Opportunity 9 (delegated authority itself) waits on vault-next's session-credentials design
  landing (docs/design/assistant.md section 3.5) and on the digest/triage track record the user
  asked to see first (open decision 1).

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

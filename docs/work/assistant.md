# assistant

Branch: work/assistant · Worktree: ../vyre-assistant · Owner session: assistant

## Done
- docs/design/assistant.md: audit of what the assistant is today (by file), 10 opportunities
  ranked by value/cost, the delegated-authority core design (scoped delegations, never-delegate
  list, provenance/taint tied to memory-iq's heard.js pattern, Undo + log, vault specifics), and
  6 open decisions with recommendations for the user.

## Doing (0.2 build, backend; plan: <team-dir>/0.2/plans/assistant.md)
- Branch merged with main at c1d4828d (module contract v1 is in). Pre-0.2 work kept at
  backup/assistant-pre02.
- B1 (Wave A0) P17 extractor: lib/said/ (extract, resolve, match helper for vault's Gate), the
  S9 eval scripts/eval-said.js with record/replay reads and a dev set; deterministic guards
  (recipients must appear in the person's own unquoted words; quoted/pasted blocks stripped first).
- B2 core/undo: the shared acted-log (P14, PL-M9): undo.record (modules), undo.list, undo.run.
- B3 core/assistant v1: assistant.glance, assistant.capabilities (tools via modules.capabilities
  when platform lands it), assistant.log (= undo.list for the assistant), settings.
- B4 the daily assistant thread with memory.digest (when iq lands it).

## Next
- B1 first, then B2 to B4. Surface UI waits for app-design.
- Land via the integrator onto stage/0.2 after reviewer-2 clears.

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

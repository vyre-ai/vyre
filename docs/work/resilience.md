# resilience

Branch: work/resilience · Worktree: ../vyre-resilience · Owner session: resilience · ADR 0029

Scope: the resilience contract (docs/adr/0029-resilience.md) for every surface, the shared
pieces (SSE cursor fixes, idempotency layer, drain on stop, reference stream and outbox client
in core/resilience/), the chaos harness (test/chaos/), and the audit with fixes filed to owners.

## Done
- ADR 0029 drafted (R1 streams, R2 idempotency and outbox, R3 quiet reconnect, R4 terminal,
  R5 path failover, R6 local alarms, R7 restarts, R8 chaos harness).
- Audit of every surface (27 Sep 2026), summary under "Audit" below.

## Doing
- Reported ADR summary and top gaps to the lead; next the shared box-side pieces.

## Next
1. core/daemon stream(): `retry:`, `id:` on open and on heartbeat, `event: reset` past a prune.
2. events table AUTOINCREMENT migration.
3. Idempotency layer in Registry.call + `Idempotency-Key` header, 24 h table.
4. Drain on stop (5 s), `thread.stopped{reason:"restart"}`.
5. test/chaos/ fault proxy + R1..R7 tests.
6. core/resilience/ reference client (stream + outbox), adopted by CLI threads watch/connect.
7. File fixes to owners (list under "Needs from others").

## Audit (27 Sep 2026)
- R1: Deck, iOS, Android and the Mac link reconnect with since=latest if they drop before the
  first event (gap). Deck never rebuilds a CLOSED EventSource. `vyre threads watch` and
  `connect --sign-in` never reconnect. No client detects a stalled stream.
- R2: no idempotency key anywhere; composer retry and Capsule retry double-send; OkHttp
  retryOnConnectionFailure can double-POST; no outbox on any surface.
- R3: mostly quiet already (Deck status line, CLI). Capsule shows a full OFFLINE banner and
  clears its tool list on a blip; Deck remounts views on reconnect and loses drafts; phones
  open with empty Now and Needs offline; iOS no jitter; no NWPathMonitor / wake handling.
- R4: term idle grace 10 s; replay has no offset and client resets scrollback; ring cut at
  arbitrary bytes; vyred restart kills every pty; typed keys dropped.
- R5: every client stores one address; no failover; Mac link serve loop restarts only on the
  60 s heartbeat; box loses questions handed to a dead held request.
- R6: no local notifications on either phone; firing id exists only after firing, so no dedupe.
- R7: stop() cuts in-flight calls (closeAllConnections) and SSE without draining.

## Needs from others
- (filed after lead review)

## Changed contracts
- (none yet)

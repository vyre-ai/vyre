# sessions under Wink (core/space-sessions): the session engine

Branch work/flows. Ruled by the lead on 4 Oct: this module owns the session engine only. It does not own files, keys or placement.

## Who owns what
- **runner** (core/runner): the sandbox, the encrypted workspace on a member's computer, continuous sync to and from the Space, per-turn checkpoint writes, the key lease, and where a session runs (`decide`).
- **vault** (kernel/seal/leases.js): key leases.
- **kernel grants** (`gateway.grants.offers`): the two-grant check (the Space allows, the member accepts).
- **this module**: one Space per session, the state a checkpoint carries (taint and permissions), resume from a checkpoint, "Continue in another space", the stage tasks (kernel/flows/stages.js), the door retrofit, and the budgets (budget.js).

## Pieces
- `index.js` createSpaceSessions: create (placement from `runner.decide`, hours reserved), get, list, end, `stateFor` (the state the runner stores with a checkpoint), `resume` (reads the Space's last acknowledged checkpoint through the runner's sync port).
- `state.js` snapshot and restore. Taint is carried and never improved by a cleaner resuming chain. A permission is carried only if the resuming chain still holds it; the rest are reported as dropped. A state of another session or Space, or an altered one (hash), is refused.
- `continue.js` Continue in another space: the summary is stripped of source-only facts and passed through the door's sanitize, raised as a `continue_in_space` task, delivered once and only if a checker approved those exact bytes. An edit changes the hash.
- `budget.js` `session_hours` and `ai_spend`: a refusal stops the session with `budget_exhausted` and raises a task for the person.

## Interface agreed with runner (proposed in team/0.2/CHAT.md)
- runner option `sessionState(session) -> state`, called at every checkpoint and stored in `putCheckpoint({ turn, seq, manifest, state })`; we supply it from `sessions.stateFor`.
- `runner.start({ resume: true })` returns `resumed.state`; we call `sessions.resume` for the labels and permissions to put on the resumed session's chain.

## Decision (lead, 4 Oct)
Working-copy sync is confirmed as intended. Wink encrypts the transport. The Space is the source of truth and keeps its own data in its Drive. Vault's pool encrypts anything that leaves the home. So the Space holds plaintext at rest inside the home, never ciphertext only.

## Needs from others
- runner: the `sessionState` option and `resumed.state` above.
- platform: allow `continue_in_space` as a task source from a service chain; `ctx.model` and `ctx.chainFor` for the live core/sessions module.
- live core/sessions has no `ctx.limits` yet, so only this module meters hours.

## Changed contracts
None.

## The session kernel credential (lib/kernel-session.js)
- vyred holds each session's kernel token; the session's own socket (core/daemon/threadsock.js) stamps `x-vyre-kernel-session` on every call and drops any the client sent. The harness gets a socket path only: no env var, file or tool argument carries the token.
- Every token has a model hop. A thread with no named assistant runs as the default assistant, `agent:assistant`, which the kernel adds to every new Space at its start (kernel/grants/index.js bootstrap) with read and task-work grants only. A Space made before that needs one `grants.addActor` for it, or unnamed threads fail with `not_a_member`.
- A token is renewed before it expires; after a failed renewal past its life the socket refuses the call (401 `no_session`).
- This is half of the boundary. It is not one until the sandbox rules D-1 to D-3 keep a session off vyred's main socket (platform and runner).

# sessions

Branch: work/sessions · Worktree: ../vyre-sessions · ADR 0030 (Vyre-owned sessions and the provider router)

## Scope
ADR 0030. User said GO (27 Sep): the Agent SDK becomes the default for every session Vyre starts.
Steps 1 to 3 behind `sessions.driver`; flip the default as soon as the full suite is green on it;
then retire the CLI runner. Approved defaults: auth box setup-token / Mac login / api-key
fallback; bundled Claude Code on the box, installed on the Mac; idle 10 min; cap 6 on the box;
Capsule quick asks to the box assistant, Mac project folders Mac-owned.

## Done
- ADR 0030 + proof (3496b48); steps 1 to 3 (759dec8, dfeda64, 0bae485).
- e2e blockers (e20f459): spawn.js (group/session, tini -s, uid/gid, pids+pgids+sids), floor denies
  settings-file writes and runs before asks, threads.mode person-only and safePermissions; dash bind;
  callerKind mcp:thread; restart reason; box image with SDK + tini.
- Models per purpose + providers as modules + conformance (33ae9e7).
- Adoption, threads.fork, idempotent answers, ADR contract/security/models/adoption/parity (a6021c88).
- Cost from Claude Code's running total (9eb5d18).
- Steering by default, queue + unqueue/edit/send-now, thread.turn/state/usage/steered/unqueued,
  block and call keys (b8b1a0a7).

## Doing
- Waiting for the full-suite slot (after the integrator's batch; load under 4), run with
  VYRE_SESSIONS_DRIVER=sdk; then flip `driver` default to "sdk" in core/sessions/config.js.

## Next
1. The flip, then retire runner.js except as the not-installed-yet fallback.
2. Rewind (threads.rewind {thread, uuid} via resumeSessionAt/forkSession, thread.rewound), usage context max.
3. Phase 3: in-process hooks (SessionStart about-you + memory.context, UserPromptSubmit, PreToolUse floor, Stop)
   and in-process MCP (planner, memory tool sets agreed) with the driver-set caller; with e2e, the box's session uid.
4. Credentials-in-Bash measurement (cc-plugin's fake Messages API).
5. Parity items that are ours: slash-command list, @file, !, #, image paste, background tasks, compact.

## Needs from others
- integrator: one full-suite run with `VYRE_SESSIONS_DRIVER=sdk VYRE_SESSIONS_SDK_DIR=<dir with SDK 0.3.283>`.
- box: pre-install the SDK with its bundled binary in the image (`npm i --omit=dev
  @anthropic-ai/claude-agent-sdk@0.3.283` into <VYRE_HOME>/sessions-sdk, or set
  `sessions.dir`), so the first session on a fresh box does not wait on a 255 MB download.
- existing boxes: the vault's claude-setup-token and anthropic-api-key must be granted to module
  `threads` (`vyre vault grant claude-setup-token threads`); new onboarding does it.
- chat, capsule-pro, mobile: `thread.stopped` reason `idle` is resumable (show "idle", not an
  error); `threads.interrupt`; `busy` refusal on start; sessions.prompt.* for a settings screen.

## Changed contracts
- threads: send {mode}, unqueue, edit, send-now, fork, mode, interrupt; events thread.turn, state,
  usage, steered, unqueued, mode.changed; `turn` on every turn event; thread.text `block`;
  thread.tool `call`/`name`/`status`; thread.finished `total_cost_usd`, `canceled`; cost_usd is the
  turn's own; send answers `queued_id` and `uuid` when queued; answer repeats return `already`.
- modules: manifest `does.providers`, ctx.provider / ctx.providers; callerKind strips :thread:.
- threads: new tool `threads.interrupt`; records carry `driver`; `thread.stopped` reason `idle`;
  `threads.start`/`launch` can refuse with code `busy` (sessions.max_live); manifest needs.vault
  claude-setup-token, anthropic-api-key.
- runner.js: argsFor takes `system` ({mode, text}); run() returns `interrupt()`.
- fake-claude.js: launch log written at initialize (argv normalised, SDK init fields added as
  flags); interrupt support.
- presence: PERSON_ONLY gains sessions.prompt.set, sessions.prompt.revert.
- onboard: CREDENTIAL_READERS gains threads.
- New module sessions: tools sessions.status, setup, prompt.get/set/history/revert/preview,
  internal prompt.compose; event prompt.changed.

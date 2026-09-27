# sessions

Branch: work/sessions · Worktree: ../vyre-sessions · ADR 0030 (Vyre-owned sessions and the provider router)

## Scope
ADR 0030. User said GO (27 Sep): the Agent SDK becomes the default for every session Vyre starts.
Steps 1 to 3 behind `sessions.driver`; flip the default as soon as the full suite is green on it;
then retire the CLI runner. Approved defaults: auth box setup-token / Mac login / api-key
fallback; bundled Claude Code on the box, installed on the Mac; idle 10 min; cap 6 on the box;
Capsule quick asks to the box assistant, Mac project folders Mac-owned.

## Done
- ADR 0030, proof, steps 1 to 3, security blockers, models, providers, adoption, fork, rewind,
  steering and the queue, cost fix (see CHANGELOG, commits up to b8b1a0a7).
- API key on fd 3 (measured leak via Bash env; OAuth token already scrubbed by Claude Code) 72b6a78d.
- Full suite on the SDK driver: 2551 tests, 2499 pass; failures were stale docs, a test writing in
  VYRE_HOME, journey DB-lock flakes (pass on rerun). Default flipped to sdk: d12171cc (batch 3a).
- After 3a: idempotent sends (keyUuid), threads.queue, mode on record (359764d7); concurrency
  slots (a4118f6c, 527cc480); context in thread.usage + threads.post (468af69f); threads.model,
  threads.commands, rewind restore code (7543952e); images, threads.shell, threads.remember,
  thinking, background tasks (034c71e5).

- After LOGOUT 4: Capsule quick answer = Vyre IQ prompt (core/sessions/iq-prompt.js, capsule@1,
  replace mode, facts numbered, thinking off, version on thread.started), eval
  scripts/eval-iq-prompt.js --live + test/eval/iq-prompt.test.js. No temperature knob exists in
  Claude Code or the SDK (reported to the lead).
- Event names stay as chat's contract reads them (model.switched, thinking.switched,
  thread.thinking); sessions.models added.

- Option A wired: per-thread socket (Switchboard.openSocket/closeSocket), VYRE_SOCKET in the
  child env, client.js honours it, MCP server + ensureUp never start a vyred inside a session,
  spawner default on for a box, sessions.thread_socket auto|on|off.

- "Doesn't ask": threads.mode bypassPermissions (person-only, no Touch ID), sessions.mode.set
  project default, plugin required, in-process floor on the SDK, answers never grant it.
- cohesion catches: Bash ask summary redacted; asks rows keep project.

- Effort (threads.start/launch effort, threads.effort, effort.switched), threads.send
  {model, effort} for Cmd-Return; queued images kept; steers persisted (threads_steers) and
  restored on resume.

- threads.quick (warm lean sessions per purpose) for memory-iq; usage pause per auth
  (sessions.usage.*, usage_paused on sessions.slots take with auth).

## Doing
- SAVED for restart (2026-09-27). Handed off: e8fd0e42 to the integrator (release candidate; 501ca3fc e2e-passed on db4af9c3); e9d734c7 (work/sessions-sdkfix) = sdk-driver test fix alone for batch 4. Waiting on: native-core settings.resolve sha, cohesion context.now, vault f4272358 on main (threads needs.credentials) and vault's Connect Claude relay to review, native-core c012c13c aliases.
- X-Vyre-Call-Id from the MCP server; quick sessions ephemeral; stopAll waits for spares: tested, pushed.
- Now own onboard's Claude sign-in (onboard.claude, setup-token.js): review vault's vault.connect relay when it arrives; add threads needs.credentials (vault f4272358 shape) once on main.
- Lead's list done through 7. Compile phase next: the promised items below, then docs + polish.

## Next
- When native-core c012c13c (MODEL_ALIASES) lands: keep it on merge; make sessions.models read it, or retire sessions.models for sessions.models.get aliases.
- Tell launch (onboard page restyle) if vault's Connect Claude relay changes any onboard page text or step.
- After 0.1.0 (the lead): the 5 cross-imports among core/sessions, core/switchboard,
  core/transcripts, core/spawner and core/harness (frozen in test/boundaries allowlist) are mine to
  remove: merge sessions and switchboard into one module, or talk over ctx.call.
- vault: threads record origin (the Capsule) for vault's surface mapping; Claude sign-in as a
  vault need (needs.credentials on threads, onboard.claude callable by module:vault).
- Promised (after the queue): settings.resolve at start (effort, mode, max_turns, budget_usd,
  checkpoints, fast); server `t` on thread.text; threads.effort + settings.changed level
  session (ADR 0035); thread.status event; context.now in enrich/capsule; brief adds planner
  agenda, needs, connections (cohesion); tool_use id on call meta once kernel has the field.
Then the compile phase: tests for every piece, docs, polish.
Testing the SDK driver on testbox: VYRE_SESSIONS_SDK_DIR=~/vyre-ci/sessions-sdk (0.3.283, with
optional deps; without them the tests silently run on the CLI).

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
- daemon/client.js: request opts.socket; VYRE_SOCKET used when no root or socket given.
  cli/daemonctl ensureUp: inside a session (VYRE_SOCKET + VYRE_THREAD) only pings, never starts.
- sessions config: spawner defaults "on" for role box; new thread_socket auto|on|off.
- threads.mode enum adds bypassPermissions; mode.changed {label}; sessions.mode.get/set/resolve,
  event mode.defaulted; presence PERSON_ONLY adds sessions.mode.set. Fake claude honours the
  permission mode and runs plugin PreToolUse hooks in bypass.
- sessions.prompt scope "capsule"; sessions.prompt.compose/preview take purpose "capsule".
- onboard: CREDENTIAL_READERS gains threads.
- New module sessions: tools sessions.status, setup, prompt.get/set/history/revert/preview,
  internal prompt.compose; event prompt.changed.

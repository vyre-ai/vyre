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

## Doing
- Lead order (after LOGOUT 4): 2 Option A wiring (VYRE_SOCKET in spawnSession, client.js, MCP
  server, hooks, then the spawner on; daemon side is e2e efb02b2c, merged in 8a2c5959).

## Next
3. "Doesn't ask" (bypassPermissions): person-only, no Touch ID, per session (Shift+Tab) and a
   project default; an answer never grants it; floor (PreToolUse) + Gate still apply; refused
   when the harness plugin is not loaded.
4. Bugs: queued sends drop images; persist pending steers (st.steers is memory only).
5. threads.send model/effort for the Capsule's Cmd-Return (or confirm threads.model covers it).
6. A warm background session for purpose "memory" (Vyre IQ latency).
7. Usage pause per auth for teammate starts and subagents.
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
- onboard: CREDENTIAL_READERS gains threads.
- New module sessions: tools sessions.status, setup, prompt.get/set/history/revert/preview,
  internal prompt.compose; event prompt.changed.

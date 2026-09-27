# sessions

Branch: work/sessions · Worktree: ../vyre-sessions · ADR 0030 (Vyre-owned sessions and the provider router)

## Scope
ADR 0030. User said GO (27 Sep): the Agent SDK becomes the default for every session Vyre starts.
Steps 1 to 3 behind `sessions.driver`; flip the default as soon as the full suite is green on it;
then retire the CLI runner. Approved defaults: auth box setup-token / Mac login / api-key
fallback; bundled Claude Code on the box, installed on the Mac; idle 10 min; cap 6 on the box;
Capsule quick asks to the box assistant, Mac project folders Mac-owned.

## Done
- ADR 0030 + proof (3496b48).
- Steps 1 to 3 (759dec8, dfeda64 and the docs commit after): core/sessions (claude.js driver with
  the runner's contract, sdk.js install-on-first-use, config.js, prompts.js, module `sessions`),
  switchboard wiring (driver pick, lazy SDK load, box credential, composed system prompt, idle
  close, cap, threads.interrupt, `driver` on records), vyre resume hand-over, docs/using/sessions.md.
- Tests: core/sessions/sessions.test.js 32/32 on both drivers; switchboard 47/47 on sdk; agents,
  learn, computers, harness, presence, daemon, federation, onboard, peer, projects-cli 267/267
  on both.

## How to run the SDK tests
- testbox has the pinned SDK in ~/vyre-ci/sessions-proof. `VYRE_SESSIONS_SDK_DIR=$HOME/vyre-ci/sessions-proof`
  enables the sdk cases; `VYRE_SESSIONS_DRIVER=sdk` runs any suite on the SDK driver.

## Doing
- Waiting on a full-suite slot with VYRE_SESSIONS_DRIVER=sdk (integrator), then the default flip.

## Next
1. Flip `sessions.driver` default to `sdk` (config.js one line) once the full suite is green on it.
2. Retire runner.js as a fallback only (keep for the "not installed yet" window).
3. Phase 3: in-process hooks and MCP for owned sessions (caller set by the driver), floor in canUseTool.
4. New events from the ADR (thread.turn, thread.usage, thread.state, tool status by call id), queue
   take-back/edit, "send now".
5. Codex driver, then ACP.

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

# sessions

Branch: work/sessions · Worktree: ../vyre-sessions · ADR 0030 (Vyre-owned sessions and the provider router)

## Scope
Phase 1: understand how sessions run today, study Paseo's provider layer, write ADR 0030, and a
small proof on testbox. No big rewrite until the lead and the user have read the ADR.

## Done
- ADR 0030 draft (docs/adr/0030-sessions.md), in the nav.
- Proof (scripts/sessions-proof/): real SDK 0.3.283 driving fake-claude via
  pathToClaudeCodeExecutable; all 6 steps pass (stream, canUseTool ask answered, floor deny,
  question, queued message, resume in a new query with --resume=<id>, transcript grows in place).
- Perf on testbox: real bundled Claude Code idle = 187 MB / ~1% of a core for 30 s, then
  178 MB / 0.13%; host (Node + SDK + 1 session) 66 to 83 MB, 0.4% after a turn, 0 settled.

## How to rerun the proof
- rsync the worktree to testbox:~/vyre-ci/sessions/, then in scripts/sessions-proof:
  `ln -sfn ~/vyre-ci/sessions-proof/node_modules node_modules` (SDK installed in
  ~/vyre-ci/sessions-proof), `SCRATCH=~/vyre-ci/sessions-scratch OUT=~/vyre-ci/sessions-scratch nice -n 15 node proof.mjs`;
  `MODE=real-idle IDLE_WAIT_MS=120000` for the real binary (no credentials, no API call).

## Findings worth keeping
- The SDK spawns Claude Code with `--permission-prompt-tool stdio`, `--setting-sources=user,project,local`,
  `--session-id=<id>` / `--resume=<id>` (equals form), no `-p`. The append, hooks and SDK MCP go
  in the initialize control request.
- The SDK bundles a 231 MB native claude (linux-x64 optional dep).
- No public API to take back a queued SDK message (Paseo casts an undocumented cancelAsyncMessage),
  so the ADR keeps the queue in Vyre.

## Doing
- Waiting for the lead's and user's read of ADR 0030 (open questions in the ADR).

## Next (after sign-off)
- Migration step 1: core/sessions router + Claude driver behind `sessions.driver`, tests on the fake.

## Needs from others
- user (via lead): the 4 open questions in ADR 0030 (auth default, bundled vs installed binary,
  idle policy, Mac-owned sessions).

## Changed contracts
- core/switchboard/testing/fake-claude.js (switchboard's test double): also reads `--flag=value`.
  No behaviour change for the CLI form.

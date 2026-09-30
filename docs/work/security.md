# security

Branch: work/security · Worktree: ../vyre-security · Spec: sections 7.5, 7.7, 7.11, 8 and 11

## Scope

Owns `core/presence/`, `core/harness/rules.js`, `core/harness/shell.js`, `core/cli/presence.js`,
`core/cli/commands/presence.js`, `docs/adr/0004-presence.md`.

A human-only action needs a person who proves they are there, whatever the caller claims
(layer 1). The floor stops the model's routes to those actions before they run (layer 2).

## Done
- ADR 0004. The verifier (touchid, tty, capsule, passkey, code) and the registry gate, wired
  into vyred. The WebAuthn check and the hash-checked Touch ID helper. The CLI proof. The floor
  rules, with the in-process fallback. `test/presence-bypass.test.js` covers a forged caller over
  curl, forged proofs, agent claims, `vyre call` with no terminal, and Bash through the floor with
  vyred up and down, plus the legitimate Capsule and terminal paths.
- Real run on Claude Code 2.1.283 with haiku: 16 routes tried, all refused, nothing sent.
  The floor refused every route before it reached layer 1.

## Needs from others
- Owners of human-only tools: declare `presence: { summary(input) }`, so the dialog and terminal
  show the destination and the start of the content (gate, threads.answer, vault, learn).
- Vault CLI (`vyre vault put`, and the other human-only verbs): call through `callAsPerson`.
- Capsule: enroll an Ed25519 key held by the main process at first run, and sign presence calls.
- Deck: enroll a passkey (with `presence.code`), then send assertions via `/v1/presence/challenge`.
- Learning: `learn.accept` and `learn.retire` are no longer reachable from MCP. The person accepts
  a lesson in the CLI, the Deck or the Capsule.

## Next
- A real Touch ID prompt from vyred, once, with the user present.
- A passkey enrolled and used from the Deck on a real device.

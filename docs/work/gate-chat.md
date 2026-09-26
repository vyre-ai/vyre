# gate + chat

Branch: work/gate-chat · Worktree: ../vyre-gate-chat · Milestone: M9 · Wave 2 (after switchboard and vault merge)

## Scope

Owns `core/gate/`, `modules/chat/`.

- **Gate.** The only way out of an agent's container. It adds credentials at the boundary (from
  the Vault, so the agent never holds them) and holds anything that would send as the user, spend
  money or delete, until the user has approved the final content (floor rules 1 and 2). Held items
  show in Now, the Capsule and the phone. It replaces the interim MCP-send rule in
  `core/harness/rules.js`: keep that as the fallback.
  Tools: `gate.held`, `gate.approve {id, edited?}`, `gate.reject`. Events: `gate.held`,
  `gate.released`, `gate.rejected`. What the user finally approved, compared with what the
  agent drafted, is a signal for Memory (teach `draft.edited`).
- **Chat.** Mattermost on the box, with a channel per project and a thread per session, wired to
  the switchboard. Port the constraint in `the prototype's bin/channels.cjs`: on the phone everything is
  a post with buttons or a slash command, never custom UI.

## Done when

An agent drafts an email; it is held; the user edits and approves it on the phone; it is sent
with a credential the agent never saw. A Mattermost thread mirrors a Vyre thread both ways.

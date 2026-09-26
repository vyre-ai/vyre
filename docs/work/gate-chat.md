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

## Contracts (working; final when merged)

### Gate (`core/gate`, module `gate`)

Tools:

| Tool | Callers | Input | Returns |
|---|---|---|---|
| `gate.request` | all | `{kind: "send"\|"spend"\|"delete", via, to: string\|string[], content: object, why?, thread?, project?}` | `{id, state: "held", message}` |
| `gate.senders` | all | `{}` | `[{name, type, kinds, content}]`: the `via` values that exist and the content each takes. Never a credential. |
| `gate.held` | all | `{thread?, project?}` | held items, oldest first: `{id, kind, via, to, summary, why, agent, thread, project, at}` |
| `gate.get` | cli, local, module | `{id}` | the item plus `draft`, `final`, `diff: {removed: [], added: []}`, `state`, `result`, `error` |
| `gate.revise` | same as approve | `{id, edited: object, by?}` | the item as `gate.get` gives it, still held, with `final` the revision |
| `gate.approve` | cli, local, and modules in `gate.approvers` (default `["chat"]`) | `{id, edited?: object, by?}` | `{id, state: "sent"\|"failed", result?, error?}` |
| `gate.reject` | same as approve | `{id, reason?, by?}` | `{id, state: "rejected"}` |
| `gate.route` | internal | `{tool, input, agent?, session?}` | `{decision, reason}` or `{decision: null}`: harness.rules asks this for a sending MCP tool |

A model never approves or rejects (floor rule 1). `edited` replaces the fields it names in the
content; `to` may be edited too, since the person is the one choosing. The id is nine random bytes
in hex: it is a capability, and a button carries it.

Events (payloads never carry the content or a credential):

- `gate.held` `{id, kind, via, to, summary, agent, thread, project}`
- `gate.released` `{id, kind, via, to, edited, by, agent, thread, project}`, after a successful send
- `gate.failed` `{id, via, error}`, when the send was approved and the sender failed; the item can be approved again
- `gate.revised` `{id, via, to, by, agent, thread, project}`, when the person changed a held item without sending it
- `gate.rejected` `{id, kind, via, by, reason}`

Senders are configured in `config.json`, never by a model:

```json
{ "gate": { "approvers": ["chat"], "senders": {
    "mail": { "type": "gmail", "vault": "work-mail-token", "from": "alex@example.com" },
    "billing": { "type": "http", "vault": "billing-key", "hosts": ["https://api.example.com"], "kinds": ["spend"] },
    "partner": { "type": "http", "pass": { "owner": "sam", "item": "partner-api" }, "hosts": ["https://api.partner.example"] } } } }
```

`gmail` sends `{subject, body, cc?, bcc?, in_reply_to?}` to `to`. `http` sends `{method, url,
headers?, body?}` with `{{vault}}` placeholders, only to an origin in `hosts`. A sender with
`pass` uses `vault.relay`, so the value never reaches this box at all. Credentials come from
`ctx.vault.fetch` (`needs.vault: ["per-sender"]`; grant each item with `vyre vault grant <item>
gate`) at the moment of sending, and the result is scrubbed of them.

Memory: on an edited approval, `ctx.memory.teach("draft.edited", fact)` with the recipient,
the agent and a one-line diff, keyed `gate:<id>`.

### Chat (`modules/chat`, module `chat`)

Mattermost as a surface. One channel per project (`<project-slug>`), one thread per session
(a root post in the project's channel, or in `sessions` for a thread with no project).

- Out: `thread.started` makes the root; `thread.text` (done) and `thread.sent` from other
  surfaces become replies; `ask.raised` becomes a reply with Allow and Deny buttons;
  `gate.held` becomes a post with Send, Discard and (with `chat.deck` set) an "Edit in Deck" link,
  and `gate.revised` patches it to the new words; the answered or released post is
  updated in place, with the buttons removed.
- In: the owner's reply in a thread goes to `threads.send {surface: "chat:<owner>"}`; a root post in a
  project channel starts a thread there; buttons go to `threads.answer`, `gate.approve` and
  `gate.reject`. There is no Edit button (the user's rule): the post always shows what Send
  sends, `/vyre body <id> <text>` and `/vyre subject <id> <text>` call `gate.revise`, and the Deck
  edits every field inline.
- Slash command `/vyre`: `held`, `send <id>`, `discard <id>`, `body <id> <text>`, `subject <id> <text>`, `new <prompt>`.
- Only the configured owner's Mattermost user is obeyed. The bot token is a vault item.

## Done
- `e5616cc` loader: any `per-<thing>` vault declaration.
- `76eb4b0`, `91e6686` Gate: tools, gmail and http senders, relayed passes, diff, draft.edited, mid-send recovery.
- `ed5c580` harness.rules routes an agent's send to the Gate; ask-first stays as the fallback.
- `6f29a57` Mattermost compose fragment and SETUP.md (not run: no Docker here).
- `9832842` Chat bridge: channels, threads, asks, held posts, edit dialog, /vyre, fake Mattermost.
- `8ce3a50` `4c4e58a` `f900857` No Edit button: `gate.revise`, held posts patched to the words Send sends, `/vyre body|subject`, Edit in Deck, lease surface `chat:<owner>`.
- `3b64c03` End-to-end Done-when in one vyred with fake Mattermost and fake Gmail. Suite: 316 pass, 0 fail.

## Doing
- Waiting on the lead's go-ahead for a real run on the box, and on box's compose layout.

## Next
1. Reconcile compose with box (network, vyred's name, tailscale serve path).
2. Real run on the box: Mattermost up, bootstrap, a real headless thread mirrored, an edited email held and sent to a test inbox the user owns.
3. When the switchboard merges: drop the stub, check the real payloads, and handle agent DMs (`agents.ask`).
4. The container egress proxy (with computers), so the Gate really is the only way out.
5. `vyre chat setup`, which runs SETUP.md's steps.

## Needs from others
- switchboard: session id visible to a tool called from inside a thread (asked).
- box: where the compose lives, the network, how vyred is reached (asked).
- deck: Now shows `gate.held` items; tool and event shapes above.
- learning: whether `gate.released {edited: true}` plus `gate.get` is enough for the edit signal (asked).

## Changed contracts
- `gate.revise` and the `gate.revised` event are new; `gate.approve {edited}` takes the whole content, and "" clears a field.
- Chat's lease surface is `chat:<owner>`; the edit dialog and `/chat/dialog` are gone.
- Chat buttons carry `{kind, id, action, s}`, where `s` is a secret generated once per install; `gate.approve` and `gate.reject` accept `by`.
- `core/harness/index.js`: harness.rules calls `gate.route` for a floor rule 1 send when `agent` is set.
- `package.json`: the test glob includes `modules/**/*.test.js`.
- `core/modules/index.js`: `ctx.vault.fetch` accepts any `per-<thing>` declaration, not only
  `per-watcher` (gate uses `per-sender`; agents' `per-agent` is covered too).

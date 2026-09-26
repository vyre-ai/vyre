# gate + chat

Branch: work/gate-chat · Worktree: ../vyre-gate-chat · Milestone: M9 · Wave 2 (after switchboard and vault merge)

## Pivot, 2026-09-26

The lead dropped Mattermost, on the user's own call: Vyre builds its own chat layer instead of
adopting someone else's. `modules/chat` (the Mattermost bridge, its compose fragment and
SETUP.md) and `test/gate-chat.test.js` (the Mattermost-shaped Done-when) are deleted. Gate is
untouched: still `core/gate/`, still the only way out. Chat is rebuilt from nothing as **Vyre
Chat**, a Deck surface at `deck/chat/`, owned here, coordinating with `deck` for the shell,
`switchboard` for thread and lease shapes, `capsule` for consistency and `intelligence` for
memory. The sections below marked Mattermost-era are history; the scope and contracts that
replace them follow.

## Scope

Owns `core/gate/`, `deck/chat/`.

- **Gate.** The only way out of an agent's container. It adds credentials at the boundary (from
  the Vault, so the agent never holds them) and holds anything that would send as the user, spend
  money or delete, until the user has approved the final content (floor rules 1 and 2). Held items
  show in Now, the Capsule and the phone. It replaces the interim MCP-send rule in
  `core/harness/rules.js`: keep that as the fallback.
  Tools: `gate.held`, `gate.approve {id, edited?}`, `gate.reject`. Events: `gate.held`,
  `gate.released`, `gate.rejected`. What the user finally approved, compared with what the
  agent drafted, is a signal for Memory (teach `draft.edited`).
- **Vyre Chat.** A Deck web app and installable PWA: projects, then sessions (threads), then the
  session view, mirroring the terminal beautifully over `thread.*` SSE. The composer sends
  through `threads.send`, taking the lease. Held Gate items and permission asks render inline,
  editable in place, never behind a separate Edit surface. See `deck/chat/` and
  `docs/design/boards/Chat.dc.html`.

## Done when

An agent drafts an email; it is held; the user edits and approves it from Vyre Chat, on the phone
or the desktop; it is sent with a credential the agent never saw. The session view mirrors a real
headless thread's terminal output live.

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

### Vyre Chat (`deck/chat/`) — Mattermost-era section, superseded, kept for the shape it proved out

Mattermost as a surface. One channel per project (`<project-slug>`), one thread per session
(a root post in the project's channel, or in `sessions` for a thread with no project).

- Out: `thread.started` makes the root; `thread.text` (done) and `thread.sent` from other
  surfaces become replies; `ask.raised` becomes a reply with Allow and Deny buttons;
  `gate.held` becomes a post with Send, Discard, Edit and (with `chat.deck` set) an "Edit in Deck"
  link, and `gate.revised` patches it to the new words; the answered or released post is
  updated in place, with the buttons removed.
- In: the owner's reply in a thread goes to `threads.send {surface: "chat:<owner>"}`; a root post in a
  project channel starts a thread there; buttons go to `threads.answer`, `gate.approve` and
  `gate.reject`. The post always shows what Send sends. Mattermost cannot edit inside a post, so
  Edit opens an interactive dialog (`POST /api/v4/actions/dialogs/open` with the press's
  `trigger_id`) filled from `gate.get` with the current final content: To, Cc, Subject and Body
  for an email, URL and Body for an http request. Its submission (to `/chat/dialog`, the hook
  secret in `state`, owner only) calls `gate.revise {id, edited: <every field shown>, by: "chat"}`,
  never `gate.approve`: the item stays held, `gate.revised` patches the post, and the person then
  presses Send. An emptied field clears it. `/vyre body <id> <text>` and `/vyre subject <id> <text>`
  also call `gate.revise`, and the Deck edits every field inline.
- Slash command `/vyre`: `held`, `send <id>`, `discard <id>`, `body <id> <text>`, `subject <id> <text>`, `new <prompt>`.
- Only the configured owner's Mattermost user is obeyed. The bot token is a vault item.

What carries forward into `deck/chat/`: no separate Edit surface, the item always shows exactly
what Send will send, `gate.revise` for in-place changes and `gate.approve` only for Send, the
lease surface naming pattern, and never inventing custom UI for what a real control can do.

## Done
- `e5616cc` loader: any `per-<thing>` vault declaration.
- `76eb4b0`, `91e6686` Gate: tools, gmail and http senders, relayed passes, diff, draft.edited, mid-send recovery.
- `ed5c580` harness.rules routes an agent's send to the Gate; ask-first stays as the fallback.
- `6f29a57` Mattermost compose fragment and SETUP.md (not run: no Docker here).
- `9832842` Chat bridge: channels, threads, asks, held posts, edit dialog, /vyre, fake Mattermost.
- `8ce3a50` `4c4e58a` `f900857` No Edit button: `gate.revise`, held posts patched to the words Send sends, `/vyre body|subject`, Edit in Deck, lease surface `chat:<owner>`.
- `3b64c03` End-to-end Done-when in one vyred with fake Mattermost and fake Gmail. Suite: 316 pass, 0 fail.
- (uncommitted) The Edit button is back as a Mattermost dialog prefilled with the current words; saving calls `gate.revise`, and Send sends. Suite: 420 pass, 0 fail, 1 skipped.

## Done (Vyre Chat)
- `5f9d815` Mattermost removed: `modules/chat`, `test/gate-chat.test.js`, SPEC.md's Chat row.
- Subagent-built, CSP-safe (no innerHTML anywhere) `deck/chat/lib/`: `markdown.js` (paragraphs,
  headings, bold/italic, inline code, fenced+highlighted code blocks, lists, links restricted to
  http(s)/relative, blockquotes, a 50k-char cap), `highlight.js` (regex tokenizer, js/ts/json/
  bash/css/html/python + a safe fallback), `diff.js` (word-level LCS diff, reused for a Gate
  item's draft-vs-final and for file edits).
- `bf7a62a` `deck/chat/`: `app.js` (hash router + shell on deck.css's existing `.shell/.rail/.view/
  .tabbar`), `nav.js` (projects -> sessions, no-project, agents, search), `session.js` (loads
  `threads.get`, follows `thread.*`/`ask.*`/`gate.*` over api.js's shared SSE, renders streaming
  text with a cursor, tool chips that expand, day rules), `gate-item.js` (held items inline and
  editable: `gate.revise` on edit, `gate.approve` only for Send, `gate.reject` for Discard, no
  separate Edit surface), `ask-item.js` (Allow/Deny), `composer.js` (`threads.send`, lease on
  typing, @ mentions, "/" left to Claude Code's own commands), a manifest and `sw.js` (installable
  PWA, offline read of recent sessions, writes never cached).
- Verified for real: `deck/test/world.js` plus a live `threads.start` with `claude -p --model
  haiku`. Streamed text and a `Bash ls -la` chip rendered and expanded; a held Gate item (via a
  temporary `gate.senders.mail` added for the run) was edited inline, Sent, failed correctly on an
  ungranted vault item, and showed the server's own error in the card. Screenshots at 1440 and 390.

## Doing
- Nothing blocking. Next pass: pointer-cursor scroll-stick tuning, the memory-fact tool once
  intelligence answers, folding the hash router into deck's shared one once it lands, and updating
  `docs/design/boards/Chat.dc.html` from the real screenshots (still Mattermost-shaped today).

## Next
1. `deck/chat/` v1: projects -> sessions -> session view, composer with lease, gate items and asks
   inline. Screenshots at 1440 and 390.
2. Web Push for asks and held items, if it holds up over the tailnet.
3. Offline read of recent sessions (cache the last N thread.* pages).
4. The container egress proxy (with computers), so the Gate really is the only way out.

## Needs from others
- switchboard (answered): `thread` is the verified field name on run context; gate.request now
  files under it and refuses an mcp caller naming a different or unverified one.
- deck: the shell, CSP rules, and where `deck/chat/` mounts in the app's routing.
- capsule: the same visual language, so a held item looks the same wherever it appears.
- intelligence: how memory facts should render (gold, per the lead's brief) and what `memory.*`
  gives a Deck-side reader.
- box (moot): the Mattermost fold-in is torn out; nothing further needed there for Chat.

## Changed contracts
- `gate.revise` and the `gate.revised` event are new; `gate.approve {edited}` takes the whole content, and "" clears a field.
- Chat's lease surface is `chat:<owner>`.
- The Edit button and `/chat/dialog` are back (the lead's call: Mattermost cannot edit inline, so
  a prefilled dialog is its fallback). The dialog's submission calls `gate.revise`, not
  `gate.approve`, as it did before `4c4e58a`; `state` carries `{kind, id, fields, s}`.
- Chat buttons carry `{kind, id, action, s}`, where `s` is a secret generated once per install; `gate.approve` and `gate.reject` accept `by`.
- `core/harness/index.js`: harness.rules calls `gate.route` for a floor rule 1 send when `agent` is set.
- `package.json`: the test glob includes `modules/**/*.test.js`.
- `core/modules/index.js`: `ctx.vault.fetch` accepts any `per-<thing>` declaration, not only
  `per-watcher` (gate uses `per-sender`; agents' `per-agent` is covered too).

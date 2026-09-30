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
|  |  | `thread` is filled from the caller vyred verified (`run(input, {caller, thread, agent})`): an agent's thread, or the session the MCP server's hook bound. From a model, a `thread` that differs is refused; `project` comes from the thread when the Switchboard knows it. | |
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

## Done (integration round 2, after the lead's review)
- Mounted onto deck's real shell and router once it landed (merge `4ec42be`): `deck/chat/index.js`
  now exports the `async (ctx) => void` `deck/views/chat.js` expects; the hash router is gone.
  `deck/chat/lib/routes.js` centralizes the URLs. Route gap flagged to deck: no pattern yet for a
  project-less thread, worked around with `"_"` as the project segment.
- `11c4e62`: the real fix for a bug the interim `deck/chat/index.html` duplicate had papered over —
  `core/daemon`'s `serveDeck()` now falls back to the one shell for a real directory that lacks its
  own `index.html` (a view's folder of JS modules, exactly what `deck/chat/` is), the way it
  already did for a path that is not a file at all. Test in `test/daemon.test.js`. The duplicate
  `index.html` and the per-view `sw.js`/manifest are gone; `deck/sw.js` already exists
  (network-first, API calls never cached) and two workers on one origin would fight.
- `docs/design/boards/Chat.dc.html` redrawn from the real app (deck's shell, Chat's rail tree, a
  held Gate item inline), not the old Mattermost mockup.
- Proposed to deck (not landed): a read-only allowlist cache in `deck/sw.js` for offline session
  read, since Chat's `sw.js` caching `threads.get`/`projects.list` touched their stated
  "nothing a tool returned is ever kept on the device" invariant and needs their sign-off.

## Done (round 3, perf + deck follow-up)
- `dbe730a`: nav.js's disclosure toggle used to dispatch `deck:navigate` (perf caught this) —
  every sidebar arrow click reran the whole router: refetched `projects.list`/`threads.list`,
  tore down and rebuilt every subscription, and, worst, fully remounted an open session view,
  dropping an unsent composer draft. Fixed with a local `onChange` callback (`index.js`'s
  `drawNav`) instead of the global event; verified a draft survives a toggle now.
- Offline read of recent sessions, deck's way: not the SW raw-response cache (deck's review —
  a held item's or a thread's text can carry real content, so caching `threads.get`/`gate.held`
  bodies was a real change to their "nothing a tool returned is ever kept on the device" line, not
  a drop-in). Matches `deck/views/now.js`'s `SNAP_KEY`/`saveSnapshot`/`loadSnapshot` pattern:
  localStorage holds ids, names, projects, statuses, timestamps only. Verified with fetch stubbed
  to reject against a real vyred.
- `/chat/thread/:thread` (deck added it) replaces the `"_"` sentinel for a project-less thread.

## Done (security's presence ask)
- `cd0770a`: `presence.summary` on `gate.approve`, `gate.revise` and `gate.reject`, from gate.get's
  own shape. Tried merging work/security to test it live; backed the merge out (and work/link,
  merged to make security's floor list pass link's own tests) after it also activated the floor's
  presence list against six-plus other workstreams' test suites that do not inject the `present`
  verifier yet, none of them gate/chat's to fix. The registry here does not store `def.presence` at
  all (core/modules/index.js's `tools.set()` keeps a fixed field list), so the addition is inert
  until security's branch, which does store and read it, merges to main.

## Doing
- Nothing blocking. Watching for deck's merge of the `serveDeck()` fix (they made the same one
  independently, commit `9432aa2` on work/deck) to reconcile on the next merge.

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

## Changed by capsule-apps (2026-09-27, the lead asked)
- `gate.settle {id, outcome: "sent", evidence}` (core/gate/gate.js settle, core/gate/index.js):
  marks an approved item whose send failed as sent, with the evidence, once. Only an item that was
  approved and failed (error and final set); callers are a person or the module that offered the
  item's sender (sender_module), else the same rule as approving. Emits `gate.settled`. Tested in
  core/gate/gate.test.js and local/apps/slack.test.js (a Slack post whose answer was lost).
- A failed approval now says `reached: "maybe" | "no"` when the sender's error carries
  detail.reached (the MCP hub's); gate.failed carries it too. moduleType.send keeps r.error.detail.
- previewOf also reads an MCP call's words from content.arguments, so gate.approve's presence line
  is not blank for hub-held calls (557421d).

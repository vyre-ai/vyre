# deck

Branch: work/deck · Worktree: ../vyre-deck · Milestone: M6 · Wave 1

## Scope

Owns `deck/` except four carve-outs, each its own workstream now: **Vault** (`deck/views/vault*`,
`deck/vault/` — team `vault`), **Memory** (`deck/views/memory*` — team `intelligence`), **Glass**
(`deck/glass/` — team `glass`), **Chat** (`deck/chat/` — team gate-chat; Mattermost is dropped).
deck keeps the shell (header, rail, phone tab bar, router), routing hooks for all four (route,
loader with a "not here yet" fallback, an auto-loaded css/views/<name>.css slot; Vault also gets
`ctx.rail(el)` to fill the rail's lower group), Now, Projects, Agents, Ask, Settings and
onboarding.

vyred already serves `deck/` for every non-API path, with a strict CSP (`default-src 'self'`,
Google Fonts allowed), so no inline scripts and no CDNs.

The web app at `<you>.vyre.run`. Build exactly from the boards in `docs/design/boards/` (DeckNow,
DeckProject, DeckAgent, Chat) and the tokens in `docs/design/TOKENS.md`. The colour rules are
strict: Signal is focus and the one primary action, Recall gold marks only what came from memory,
Beacon only what needs the user.

- **No build step to run it.** Plain ES modules and CSS, served as files. A small component
  helper of your own is fine; no framework downloads at runtime. If you want a framework, vendor
  a single file under `deck/vendor/` and say why in the changelog.
- **Data.** Only vyred's API: `POST /v1/tools/<name>`, `GET /v1/events/stream` (SSE; resume via
  Last-Event-ID). Never read the store. Every tool may be missing: show an empty state that says
  which module is not running.
- **Phone.** The Phone boards are Deck views at narrow widths (Now, approvals, drafts, Ask).
  Design for 360px up; installable as a PWA.
- **Security.** Never render a vault value (there is no API for it, so don't build one). Text
  from threads is untrusted: always textContent, never innerHTML.

## Onboarding (first screen)

`deck/onboard/`: the six-step onboarding in spec section 1, one step a screen, each skippable,
with live progress for Tailscale sign-in and history indexing. It calls the box stream's
`onboard.*` tools; build against fixtures until they land. There is no board for it yet:
design it from the tokens and the Deck boards, and add a board to `docs/design/boards/`.

## Needs

Projects/recall/memory tools land with M1; threads with the switchboard stream. Build against
fixtures (`deck/fixtures/*.json`, fictional world only) behind the same client function, and
switch to live tools as they merge.

## Done when

Now and Projects work live against a running vyred with M1 merged, on desktop and phone widths,
checked by screenshot against the boards.

## Done
- Onboarding (`deck/onboard/`), all six steps, against `onboard.*` fixtures; history step live on
  Recall and Projects. Board: `docs/design/boards/Onboard.dc.html`.
- Foundation: `deck/css/deck.css` (tokens, dark and paper), `deck/js/dom.js`, `deck/js/api.js`
  (tools, fixtures fallback, one shared event stream), `deck/js/icons.js`, `deck/js/fmt.js`.
- Test helpers: `deck/test/world.js` (temp home, real vyred, proxy on 127.0.0.1), `deck/test/shoot.js`.

- Shell (header, search, rail, phone tab bar, router) and Now, live and against fixtures, at
  1440 and 390. PWA manifest, icons, service worker.

- Projects, Memory, Agents, Vault, Settings, each live where its module is on main and against
  fixtures otherwise, at 1440 and 390. Memory and Vault are handed off (see Scope); Agents stays.
- Phone views: `/needs/:id` (PhoneApprove, PhoneDraft), `/ask` (PhoneAsk); every view checked
  for overflow at 360. `/agents/:name/glass` loads `deck/glass/`, owned by team `glass` (see Scope).
- Now, Projects, Agents and Ask switched from fixtures to the real switchboard (`core/switchboard`,
  `core/agents`, merged to main) and verified live: agents.list's field is `status` (+`doing`), not
  `state`, so agents.js showed every agent as idle and 0 working; the lease is a flat `holder` on
  the thread record, not `lease.surface`; thread.text streams as partial `{delta}` then one final
  `{text,done:true}`, so a live reply now grows as it streams instead of staying blank until the
  end; thread.tool's "done" phase shares its "started" event's id and carries no result text by
  design (switchboard keeps events small) — it now marks the line failed instead of drawing a
  second blank one; agents.ask's reply is `{text,ok,note?,ask?}`, not `{answer,recalled}` (no
  recall step exists yet), fixed in ask.js. `thread.sent` now shows another surface's own typing,
  not just the eventual reply (floor rule 3).
- Onboarding matched to the real `onboard.*` contract as box's core returns it (relayed by the
  lead): `why` not `reason`, the setup-token code-entry flow (the pty needs the code back, so
  there is nothing to poll), no `info.path`/`system.info` (loopback never allows the latter),
  `onboard.history {action:"start"}`, the real `onboard.stepped`/`onboard.finished` events (was
  listening for `session.indexed` and a nonexistent `onboard.progress`), no dead-link fallback to
  `/now`, and a blocked-Tailscale state (shape unconfirmed, asked box).
- Held items (Now and PhoneDraft) edited in place against the real gate module (merged to main):
  `js/editable.js` turns a held item's own fields (To, Subject, Body, or a spend/delete's method,
  url, body) into inputs that read as text until focused. No Edit button anywhere; Send is
  `gate.approve {id, edited?}` with only the changed fields, Discard is `gate.reject`. Verified
  against a real vyred (`deck/test/world.js`, now seeds two real held items): a live edit-and-send,
  a Discard, and a failed send (no real credential) that returns to held with the edit kept as
  `final` and its error shown as "Held again: …" in Beacon, above the still-editable fields.

Onboarding rewritten again (2026-09-27) to box's full `onboard.*` contract (both messages) and
install's ADR 0008: no more `<you>.vyre.run` anywhere, a ts.net address shown once box gives it,
`https_off` handled with "Turn on HTTPS" + "Check again", a collapsed "Your own domain", the
Tailscale no-account line, Devices as three cards with two QR codes and door-A "Connected: <name>",
and a real ending screen (greeting streamed from `onboard.finish`'s thread, three ticks, "Open
Vyre"). Verified against a rewritten `deck/fixtures/onboard.json`, not yet against box's real
branch (not merged into this worktree).

Shell hooks landed for the four carve-outs: `deck/chat/` mounts via `deck/views/chat.js` (same
"not here yet" pattern as Glass) routed at `/chat`, `/chat/:project`, `/chat/:project/:thread` plus
a rail entry (gate-chat asked where; settled); `/vault/:place` and `/vault/:place/:name` routed;
`ctx.rail(el)` lets a view fill the rail's lower group. `js/api.js`'s module-name map said `learn`
was named "learning"; it's `learn`.

Now made a real home (2026-09-27): the assistant's name and what it's doing (`agents.list`'s
`doing`), Recent projects, and an offline read of the last state (`localStorage`, counts and a
timestamp only, never a held item's words — the service worker already refuses `/v1/` for the
same reason) shown as "Offline. As of … ago: …" when `threads.list` fails with the offline error
code. Found and fixed a real bug while wiring this: Working read `t.state === "running"`, but the
real field is `status`, and the switchboard never sets `"running"` or `"finished"` — only
starting/working/waiting/idle/stopped — so Working always said "Nothing is running" no matter
what was actually live. Verified against a real thread (`status: "working"`).

PWA installability: manifest, icons (already generated from the mark, matching `icons.js`'s
`mark()` exactly), iOS meta tags and the shell-caching service worker were already in place from
an earlier pass; the offline-Now read above completes the "offline gives you something" half of
the ask. Web Push is not built: there is no server-side piece anywhere in the codebase (no VAPID
keys, no subscribe tool, nothing that would call a push service when an event fires while the
Deck is closed) — a client `Notification`/`PushManager` registration alone cannot deliver anything
without one. iOS 16.4+ supports Web Push for an installed (Add to Home Screen) PWA, and the
tailnet does not block it (the box has ordinary outbound internet to reach Apple's/the browser's
push service; the tailnet only restricts inbound). So it is feasible, but it needs a new module
(VAPID keypair in the vault, a `push.subscribe`/`push.send` pair, called from wherever
`ask.raised`/`gate.held` already fire) that nobody owns yet — flagged to the lead rather than
guessed at.

## Doing
- Nothing; waiting on box's onboard core to merge, and answers from box below.

## Next
- Re-check onboarding once box's onboard core merges (branch not yet in this worktree).
- `deck/js/presence.js` (ADR 0004, on work/security): vault and intelligence both asked for it
  independently; told both to prototype it in their own view first, to centralize once there are
  two real callers to generalize from rather than guessing the challenge/retry shape now.
- View-scoped keyboard shortcuts (vault asked): same answer, prototype first, lift out later.
- Settings section 7 (Lessons) should become a link to `/memory?tab=lessons` once intelligence's
  tab exists; a one-line swap, waiting on them to say it's live.
- `/threads/:id?seq=N` scroll-to-and-highlight (intelligence asked, for provenance links).
- Proposed lessons in Now's needs, with a count (intelligence asked) — a new need "kind" next to
  draft/ask, bigger scope, not started.
- Settings: confirm the per-step `vyre` commands it shows once box's core is in.
- Web Push client side: subscribe UI in Settings, iOS "install first" hint, and the service
  worker's `push`/`notificationclick` handlers — waiting on switchboard's `core/push` shapes
  (VAPID, subscribe, delivery on ask.raised/gate.held/thread.watched, no content in the payload).
- A usage badge on the Agents *list* rows (turns or spend, at a glance) — the detail page's Usage
  section (below) covers "per agent"; the list is a natural follow-up, not started.

## Done (continued)
- `agents.history` turned out to already be a real tool by the time I checked (switchboard added
  it alongside `agents.usage`) — Ask's past-exchange log, which already read the right field names
  defensively, works with no code change.
- A per-agent Usage section on the Agents detail page (`agents.usage`, switchboard, merged to
  main): money only for `auth:"api-key"` (`spent_usd` of `budget_usd`, `left_usd`); subscription/
  ambient agents show turns and time instead, since `cost_usd` there is Claude Code's notional
  figure, not money spent. Tokens, last used, and the last rate-limit report
  (`allowed_warning`/`rejected`, with when it resets) when there is one. Verified the real shape
  live (curl) and the populated state (mocked at the fetch layer, since a fake `claude` binary
  can't produce real turns).

## Needs from others
- box: whether `detail.devices.phoneUrl`/`macDownload`/`mac.connected` (Devices step) are the
  real field names or my guess at them from install's ADR 0008 description; confirmed already:
  the blocked-Tailscale and bad-setup-token-code shapes.
- switchboard: `agents.ask` returning a recall-first answer (so Ask's already-built "From memory"
  block and "Ask a model" button have something to show); `computers.*` shapes (`computers.get`,
  `restart`, `limits`), `watchers.list/pause` shapes; `core/push`'s client-facing shapes, when
  ready.
- vault: the new `vault.*` event names, for `js/api.js`'s known SSE list (asked 2026-09-27).

## Changed contracts
- None.

## Fixed against main (2026-09-26)
- `projects.list` returns `{ projects, problems }`, not a bare array; the Needs project-name
  lookup crashed on it against a real vyred.
- `gate.get` returns `draft` and, once a revision exists, `final`; Now and PhoneDraft now show
  `final ?? draft` (what every surface shows and Send sends), and drop their cached `gate.get`
  answer when an approve comes back `failed`, since gate.js keeps the edit as `final` on the row
  even though state reverts to held.
- the phone `.nd-form .ed-row` width rule matched the body row too, forcing the growing textarea
  into the 76px label column; scoped to `:not(.ed-body)`.

## Fixed against main (2026-09-27, switchboard)
- agents.js read `.state`; the real field is `.status` (with `.doing` as the friendlier label).
  No agent ever showed as working.
- projects.js's thread composer read `thread.lease.surface` (doesn't exist); the flat field is
  `thread.holder`. The keyboard indicator always started wrong until a `lease.changed` event.
- projects.js's thread.text handling wrote `ev.text` on every event, but a partial carries only
  `delta`; a live reply stayed blank until its one final event. Now accumulates deltas per message
  id and lets the final `text` win outright.
- projects.js's thread.tool drew a second, blank line for every call's "done" phase (which shares
  its "started" event's id and carries no tool name or result, by switchboard's design); now only
  marks the started line failed.
- ask.js read `d.answer`/`d.recalled` from agents.ask; the real reply has no recall step, it's
  `{text,ok,note?,ask?}`. A reply that came back inline never rendered.

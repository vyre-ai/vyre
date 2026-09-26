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
"not here yet" pattern as Glass) routed at `/chat`, `/chat/thread/:thread` (a thread with no
project — added once gate-chat hit the ambiguity: `/chat/:project` and a hypothetical flat
`/chat/:thread` are both two segments and the router picks by segment count, not content, so they
can't coexist; `/chat/thread/:thread` is a third, unambiguous, literal-prefixed pattern, listed
before `/chat/:project/:thread` since match() takes the first same-length pattern that fits),
`/chat/:project`, `/chat/:project/:thread`, plus a rail entry; `/vault/:place` and
`/vault/:place/:name` routed; `/glass/:name` alongside `/agents/:name/glass`; `ctx.rail(el)` lets
a view fill the rail's lower group; `js/api.js` gained `ApiError.detail` (the whole error body,
not just code/message) and `upload()` (a ticketed-PUT-with-progress, lifted from glass's
`transfer.js`, which was written to be moved here). `js/api.js`'s module-name map said `learn`
was named "learning"; it's `learn`.

**Gotcha for the next carve-out that gets its own real subfolder** (gate-chat hit this): vyred's
`serveDeck()` falls back to the root `deck/index.html` shell only when a path matches no file at
all. A view folder that is a real directory (`deck/chat/`, `deck/glass/`, …) makes a bare
`/chat`-style path resolve to that folder's own `index.html` if one exists, or 404 if it doesn't
— the root shell never gets a chance. gate-chat's fix: keep a byte-identical copy of
`deck/index.html` inside `deck/chat/` (harmless duplication; `js/app.js` reads `location.pathname`
itself regardless of which file served it). Any of vault/memory/glass doing the same thing should
do the same fix if they see a 404 on their own section's bare route.

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
- `deck/views/projects.js:313` calls `memory.facts {project_cwds}`; intelligence says unscoped or
  folder-only reads are now refused and it must move to `memory.facts {room}` — waiting on
  work/memory to reach main (not yet, checked 2026-09-27) before switching, so as not to guess the
  new shape.
- View-scoped keyboard shortcuts (vault asked): prototype in deck/vault/ first, lift out later.
- Settings section 7 (Lessons) should become a link to `/memory?tab=lessons` once intelligence's
  tab exists; a one-line swap, waiting on them to say it's live.
- `/threads/:id?seq=N` scroll-to-and-highlight (intelligence asked, for provenance links).
- Proposed lessons in Now's needs, with a count (intelligence asked) — a new need "kind" next to
  draft/ask, bigger scope, not started.
- Settings: confirm the per-step `vyre` commands it shows once box's core is in.
- A usage badge on the Agents *list* rows (turns or spend, at a glance) — the detail page's Usage
  section (below) covers "per agent"; the list is a natural follow-up, not started.
- Re-check Web Push (below) once `core/push` merges into this worktree — built and verified
  against switchboard's shapes and a mocked response, not yet against the real module.

## Changed invariant: the service worker now caches two reads (2026-09-27)

deck/sw.js's rule was "API calls (/v1/) are never cached, so nothing a tool returned is ever kept
on the device." gate-chat asked for offline read of recent sessions for Chat; the lead approved a
narrow exception instead of dropping the rule: **only `threads.get` and `projects.list`** may be
read back when the network is down, everything else — every write (approve/revise/reject/send/
lease/answer among them), every `vault.*` or `gate.*` read, anything a model wrote as a secret —
is still never cached, exactly as before. `threads.get` is only ever called for a thread someone
actually opened (`deck/views/projects.js`, `deck/chat/session.js`), never a background poll, so
this is already scoped to "sessions the user opened" without extra bookkeeping. The cache
(`vyre-deck-offline-1`, separate from the shell's own `vyre-deck-1`) is capped at 20 distinct
calls and a week old, oldest evicted first, and can be wiped with
`postMessage({type: "vyre:clear-offline"})` — there is no sign-out in Vyre yet, so nothing calls
that today, but it's ready for whatever that turns out to be. Verified: a live `projects.list`
call while online lands in the offline cache under the tool's exact input, with the tool's real
data shape; did not simulate a true offline network condition (the test harness has no clean way
to force that against a live local vyred), so the read-back path is code-reviewed, not exercised
end to end — worth a real device test before this ships.

## Done (Web Push, 2026-09-27)
- Settings → Notifications: turn this device on/off (push.key + pushManager.subscribe +
  push.subscribe), other devices with delivery health and Remove (push.unsubscribe), quiet hours
  and per-kind toggles (push.settings, browser timezone sent along), a test send (push.test).
  This device's id lives in localStorage (push.devices never returns an endpoint to match
  against), with a fallback to the live subscription's endpoint if that's ever lost.
- An iOS install-first hint replaces the button when Web Push cannot work yet (an ordinary Safari
  tab, not an installed Home Screen app).
- deck/sw.js's `push` handler shows a notification from exactly {kind,title,path,tag,at} — never
  a held item's words, by core/push's own design — with a short fixed body per kind written here;
  `notificationclick` focuses an open tab and posts it the path for a client-side navigation, or
  opens a new one.
- settings.js now honours `?section=` (a query, since a notification's path is a plain fetchable
  link) alongside the existing `#section`.
- `js/icons.js` gained a `bell` glyph.

## Done (Security, 2026-09-27)
- `js/api.js` gained presence proof (ADR 0004): `call(name, input, {presence: true})` (and
  `attempt`'s third arg) runs the WebAuthn dance — POST /v1/presence/challenge, a passkey prompt,
  the tool call carrying the signed proof as `x-vyre-presence` — before the real call, for a
  human-only action (a Gate approval, a Glass take-over). Lifted from `deck/glass/presence.js`
  (glass's ask; it was written to be moved) since Gate approvals will want the same proof; keeps
  "only api.js calls fetch" intact. `canProve()` is exported for a view to check WebAuthn support
  first. `callWithCode(name, input, code)` is the enrollment-only sibling: a one-time code from
  `vyre presence code` stands in for a passkey that doesn't exist yet.
- Settings → Security: add a passkey. The first one needs that one-time code; `navigator.
  credentials.create` runs client-side (a random challenge — the code is what actually
  authenticates the enrollment call, not WebAuthn's own challenge matching, since there is no
  passkey yet to sign it against), then `presence.enroll {kind:"passkey", name, public_key,
  alg, rp_id, credential_id}` via `callWithCode`.
- Verified against a real vyred: the section renders and a submit attempt fails cleanly on
  WebAuthn's own error (this environment has no real hostname or authenticator) rather than
  crashing. Not verified end to end (a real ts.net/vyre.run origin and an actual authenticator
  are needed for that) — worth a real device test before relying on it.
- The first-passkey page (box, ADR 0004). Went through three shapes before landing: (1) I first
  wired `passkeyUrl` into the ending screen, per box's first message; (2) box pointed out the
  loopback onboarding session (caller onboard/cli/local, never a tailnet caller) lives in
  sessionStorage, which does not survive the redirect from loopback to the https address, so
  `passkeyUrl` could never come back at the ending — I moved the check to an early
  `onboard.finish` call in the "name" step, right before that redirect; (3) box then said not to:
  calling finish early marks onboarding finished and closes the loopback door before history/
  devices run. The landing: a dedicated `onboard.passkey {}` (box) returns `{address,
  passkeyUrl}` and changes nothing else; the "name" step calls that instead, goes to `passkeyUrl`
  instead of `#history` when set, and `onboard.finish` still runs exactly once, at the real
  ending, as it always did. `deck/onboard/passkey/` is a standalone page (not the wizard, not the
  Deck's router) at `https://<addr>/onboard/passkey#e=<code>` — the code rides in the hash,
  stripped at once — and always continues to `/onboard#history` after (enrolled or skipped),
  since it's a detour mid-wizard, not the ending. Same enrollment shape as Settings →
  Security, reusing `callWithCode`. Same verification caveat: the missing-code and enroll screens
  render correctly, the WebAuthn ceremony itself needs
  a real device to exercise end to end.

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

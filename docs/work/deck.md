# deck

Branch: work/deck · Worktree: ../vyre-deck · Milestone: M6 · Wave 1

## Scope

Owns `deck/` only. vyred already serves `deck/` for every non-API path, with a strict CSP
(`default-src 'self'`, Google Fonts allowed), so no inline scripts and no CDNs.

The web app at `<you>.vyre.run`: **Now**, **Projects**, **Memory**, **Agents**, **Vault**,
**Settings**. Build exactly from the boards in `docs/design/boards/` (DeckNow, DeckProject,
DeckMemory, DeckAgent, DeckVault, Chat, and the Glass boards for later) and the tokens in
`docs/design/TOKENS.md`. The colour rules are strict: Signal is focus and the one primary action,
Recall gold marks only what came from memory, Beacon only what needs the user.

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
  fixtures otherwise, at 1440 and 390.
- Phone views: `/needs/:id` (PhoneApprove, PhoneDraft), `/ask` (PhoneAsk); every view checked
  for overflow at 360. `/agents/:name/glass` loads `deck/glass/` (computers stream).

## Doing
- Nothing; waiting on shapes from box, switchboard, vault and learning to switch fixtures to live.

## Next
- Switch each view to live tools as switchboard, box, vault, learning and gate merge; drop the
  fixture fields that turn out different.
- computers: Glass goes in `deck/glass/index.js` (default export is a view, same contract as
  `deck/views/*.js`); the route and loader exist.

## Needs from others
- box: `onboard.*` as assumed in `deck/fixtures/onboard.json` (sent 2026-09-26): `onboard.status`,
  `onboard.you {name, assistant}`, `onboard.name {name, action: check|reserve|status}`,
  `onboard.claude {mode: detect|setup-token|api-key}`, `onboard.tailscale {action: detect|connect|poll}`,
  `onboard.skip {step}`, `onboard.finish`. Token sent as header `x-vyre-onboard`.
- switchboard: exact `threads.*`, `agents.*` and open-asks shapes (asked 2026-09-26).
- main: `GET /v1/events/stream?since=latest` (or a way to read the newest event id), so a fresh
  Deck does not page the whole log to find where to start. vyred serves `.mjs` as
  octet-stream; `.js` works, so nothing is blocked.
- vault: the Deck's writes are denied (caller `deck` not allowed on put, grant, pass.create,
  offboard); item names cannot have spaces; `vault.usage` vs `vault.audit`. Sent 2026-09-26.
- box: confirm the per-step `vyre` commands Settings shows (`vyre up --step <id>`).
- switchboard: `agents.ask` returning `recalled` (answer, ms, sources), `agents.history`,
  `computers.*` shapes (`computers.get`, `restart`, `limits`), `watchers.list/pause` shapes.
- main: `deck/**/*.test.js` is outside the `npm test` globs; if the Deck gets unit tests, add it.

## Changed contracts
- None.

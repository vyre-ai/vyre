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
- Held items (Now and PhoneDraft) edited in place against the real gate module (merged to main):
  `js/editable.js` turns a held item's own fields (To, Subject, Body, or a spend/delete's method,
  url, body) into inputs that read as text until focused. No Edit button anywhere; Send is
  `gate.approve {id, edited?}` with only the changed fields, Discard is `gate.reject`. Verified
  against a real vyred (`deck/test/world.js`, now seeds two real held items): a live edit-and-send,
  a Discard, and a failed send (no real credential) that returns to held with the edit kept as
  `final` and its error shown as "Held again: …" in Beacon, above the still-editable fields.

## Doing
- Nothing; waiting on shapes from box, switchboard and learning to switch fixtures to live.

## Next
- Switch each view to live tools as switchboard, box and learning merge; drop the fixture fields
  that turn out different (gate's real content has no `toName`/`sources`/`recalled` — those degrade
  to a plain "To" and no recall block, already handled).
- computers: Glass goes in `deck/glass/index.js` (default export is a view, same contract as
  `deck/views/*.js`); the route and loader exist.

## Needs from others
- box: `onboard.*` as assumed in `deck/fixtures/onboard.json` (sent 2026-09-26): `onboard.status`,
  `onboard.you {name, assistant}`, `onboard.name {name, action: check|reserve|status}`,
  `onboard.claude {mode: detect|setup-token|api-key}`, `onboard.tailscale {action: detect|connect|poll}`,
  `onboard.skip {step}`, `onboard.finish`. Token sent as header `x-vyre-onboard`.
- switchboard: exact `threads.*`, `agents.*` and open-asks shapes (asked 2026-09-26).
- box: confirm the per-step `vyre` commands Settings shows (`vyre up --step <id>`).
- switchboard: `agents.ask` returning `recalled` (answer, ms, sources), `agents.history`,
  `computers.*` shapes (`computers.get`, `restart`, `limits`), `watchers.list/pause` shapes.
- main: `deck/**/*.test.js` is outside the `npm test` globs; if the Deck gets unit tests, add it.

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

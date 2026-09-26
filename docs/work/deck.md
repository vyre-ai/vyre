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

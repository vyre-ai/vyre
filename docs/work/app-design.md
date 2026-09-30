# app-design

Branch: work/app-design · Worktree: ../vyre-app-design · Owner session: app-design

Scope (lead, 2026-09-27): lead product designer. One app (Expo) for web, iOS and Android that
covers all of Vyre, plus the Capsule and the CLI on the same tokens, and device install with no
Apple Developer account. Absorbs deck-design and phone-design.

## Done

- Direction A (inbox first) decided by the user, 27 Sep. Full sheet published: Direction,
  Smooth, Principles, System, Layout; key screens Needs, Session, Plan and modes, Agents, Planner,
  Vault, Devices; places Onboarding, Projects, Memory, Settings; States, Install 1 and 2, Capsule
  and CLI; every key screen in dark and paper, each with a "Smooth:" note. All pass the audit.
- Design canvas "Vyre one app" (private, owned by the user):
  https://claude.ai/artifact/CKLkX4pcZpsyiKYDEnXKWr (republished on the new account 27 Sep from <team-dir>/design-backup/canvas-2026-09-27; the old link belonged to the previous account). 23 boards: Main (principles), System,
  Layout, then Needs you, Session, Agents and Glass, Planner, Vault, Devices, States,
  InstallLaptop, InstallPhones, Capsule and CLI, each key screen in dark and paper.
- Source in docs/design/one-app/ (project/ is the canvas, vyre.css the shared parts),
  tokens.json as the one token source, README.md as the written spec. A copy of the canvas
  source is in <team-dir>/design-backup/one-app/.
- Render audit on testbox (docs/design/one-app/render/render.sh, sizes now read from each
  board's $preview): all 23 boards pass, 0 contrast, 0 clipped, 0 off-system, both themes.
  Every dark board and several paper boards were looked at as PNGs.

## Doing

Session 5 (27 Sep, after logout 4). Done this session, all on work/app-design:
- Canvas republished on the new account (51 boards from the backup, then the Capsule and Install
  changes below): https://claude.ai/artifact/CKLkX4pcZpsyiKYDEnXKWr.
- docs/design/system/capsule.md (6f8ae52f): the Capsule redesign for capsule-pro. Boards
  CapsuleLong and CapsuleDo drawn, CapsuleSearch and CapsuleIQ on the canvas (63321814); the 8
  Capsule boards pass the audit on testbox.
- Tokens in the hub: lib/theme (95b430f7) and core/appearance (c4f1ca5d). 8 pass, 1 skip here
  (the hub test skips until native-core's settings land); 33/33 with native-core's settings code
  overlaid.
- Spec lists by team: docs/design/system/teams.md (f0752612).
- Install boards: the real 8-character code, 7KQM-4P2X, valid 10 min (e7db7f55).

- Later in session 5: appearance aligned with ADR 0035 (34ac793b; 14/15 with native-core's
  settings overlaid, the skip is the device level); specs tip, glass-mini, suggestions,
  account-row, credential-sheet, result-card and the waiting count in needs-row (b4d7b27e); boards
  TipLine and GlassMini (3da9eecb), all audited; canvas republished (63 boards).
- The design workflow passed in CI on 548c4572 (run 36326407452).

Now (lead, 27 Sep late): support the new launch team (worktree vyre-launch) until the RC closes
about 03:00 UTC. Its requests come first: review its visuals against Design A, and draw the hero,
product shots, the og image and the README hero as boards. Kit sent to it. The hub branch
(work/app-design-hub 9a6abbcf) lands after native-core 6ccad201; merged run on testbox green.

Next: native-core's six asks for appearance (device level, call check, choicesFrom shape,
settings.snapshot, /theme.css and /v1/theme from the daemon, GROUPS), then switch the keys to
account + device and drop the tokens tool store. Then polish passes over the specs with each team.

## Now (28 Sep, launch support)

- Launch art done: Og, Social, ReadmeHero + -paper, boards + PNGs, both pass the audit clean.
  Committed e95897c3. PNGs handed to launch at /tmp/launch-art-handoff/ (not copied into
  vyre-launch/site — this Mac's filesystem is case-insensitive, `Og.png` collides with their
  tracked `og.png`; told launch to rename on their side).
- Visual review of launch's site against Design A (screenshots via testbox vyre-chrome,
  site/index.html and site/404.html; onboard.html needs a live loopback server, static open
  renders empty, not reviewed live):
  - 404 page: clean, on-brand, no findings.
  - Landing page (site/index.html, site/styles.css): systemic gold violation. `--recall: #EBC76B`
    is the visual identity of the whole "It remembers, and shows you where from" section (the
    recalled-answer card, the legend dot, `.gold` utility, 6+ uses in styles.css). Design A retired
    gold entirely (tokens.md Retired names: "Gold is gone from the system") — a memory source
    should be a plain source chip (1px --rule-strong), not a colour. This is the single biggest
    finding; it's a redesign of that section's cards, not a token swap.
  - deck/onboard/onboard.css: `.dev-off` and `.need` both set `background: var(--beacon-wash)`,
    which was retired (Retired names table) and isn't even generated into deck/css/tokens.css
    (grepped — not present), so it resolves to nothing. Retired names says use `--hover` where the
    card needs a ground. Two-line fix.
  - No other off-token colours found (grepped every hex in site/*, deck/onboard/*, install-box.sh
    against tokens.json; everything else matches token values exactly).
  - Sample world used correctly throughout (Harlow Legal, kit, juno, alex, Northwind Bakery).
  - Findings sent to launch (msg_id 9bf64bab) with the handoff.
- Re-review of launch 342e02f5 (both findings fixed + their own hotkey copy fix, Option-Space
  default / Control-twice optional): gold redesign and onboard.css --hover swap both correct;
  hotkey copy consistent across site/, site/start/, README, onboard.js; art placement confirmed
  byte-identical to the handoff. One thing the gold pass missed: `--beacon-wash` still in
  styles.css :root and still live on `.held-chip` (the hero Capsule's "Held for you" cycling
  state, index.html:154) — same retired needs-pill pattern, same fix as onboard (drop the wash,
  keep the text). `.dest.do` also references it but isn't applied anywhere, looks like dead CSS.
  Minor nit not blocking: `.keys .kc` renders the hero's ⌥Space as two boxed chips; key-hint.md
  wants one chip per chord. Pre-existing, not part of this session's changes. Sent to launch
  (msg_id 3050a9b8).
- Third pass, launch 57eebd9f: `--beacon-wash` fully removed from site/styles.css (the lead caught
  it live in `.dest.do` (dead, removed), `.held-chip`, `.ph-card`). Confirmed clean: violet is
  text-only everywhere on the page now (`.held-chip` color-only, `.ph-card` on `--raised` with
  `.lbl.beacon`/`.dot.beacon`). Full hex/rgba sweep of styles.css against tokens.json: every value
  matches, both themes. No regressions in the memory section or hotkey copy. Cleared for RC
  (msg_id e75a2677).
- Fourth pass, launch 2b3f55ca: .btn/.chip/.dtab off mono/uppercase, checked against
  button.md/chip.md/tabs.md, all exact including 404.html's copies. Ruled on .lbl (they'd held it
  back, asking whether docs/design/TOKENS.md's mono/uppercase/+0.16em label spec still applies):
  no — TOKENS.md is the stale pre-Design-A doc, already proven wrong by this same commit (its own
  uppercase-mono button rule is what got overridden), and our canonical vyre.css already settles
  .lbl as 12/16 600 sans in every board. Told them to fix all ~15 sites. Also flagged a small
  pre-existing nit: `.dtab[aria-pressed=true]` inks the label lime instead of `--text` (only the
  border/fill should carry signal colour per tabs.md/chip.md's On state) — not from this commit,
  not blocking. (msg_id 55defeb5)
- TOKENS.md itself (docs/design/TOKENS.md, root, owner "docs", status "stable") should probably be
  retired or marked superseded now that two separate stale-carryover bugs have traced back to it.
  Flag for after RC — not touching a doc I don't own mid-RC.

## Next

- After RC (~03:00 UTC): add an "Answer" variant to result-card.md for memory-iq's IQ answer card
  (Deck Find, Memory view, phone Find, chat-core so PWA gets it too). Confirmed the shape by
  message (msg_id 8dc60e94): no header row, sources as source chips (--rule-strong border, no
  fill, mono meta — the same pattern as the launch boards), no colour-coding by confidence or by
  abstain/limited state, --space-3 gap above the search hits. memory-iq is building against this
  now; the spec write-up is the only thing left.
- Also fold in correct-in-place (msg_id f9faf5a1): quiet "Wrong?" text after the meta line (not a
  chip/button), expands in place to two ghost buttons ("That's wrong", "Forget this") + a
  prefilled text field, Enter sends, Esc collapses; the abstain card skips straight to an always-
  open empty field ("Know it? Tell me"); after a fix the meta line becomes "you corrected this" +
  an untimed "Undo" ghost text (not a toast — this card can sit unnoticed in a scroll-past
  result). Same shell on the phone, row grows in place, never a sheet.

- ADR 0033 theme overrides: validation built (scripts/lib/theme.js, `gen-tokens --validate`).
  Still to do in P4: the board for module UI slots.
  Also in P4 (agreed with platform): move the runtime half (applyOverride, check, css, fromLegacy,
  rgba, load) and tokens.json to lib/theme/, add "lib" to package.json files (main excludes
  docs/design, so tokens.json does not ship today), repoint SOURCE; outputs byte-identical.
  Confirmed by platform (ADR 0033 366b10a7): top-level lib/theme; the first branch to create lib/
  adds "lib" to files in the same commit; run scripts/release-check.sh to prove tokens.json ships;
  tell mobile about SOURCE (or keep the docs path as a pointer until they rebase). Rules already sent 27 Sep: Now card =
  the Needs row, tool card = the tool row plus a template, iframes get theme.css + tokens.json and a
  theme message, a "Modules" rail section (3 pinned), one Settings group per module, and tokens a
  theme may never override (attention role, status model, focus ring, 12 px text, 44 targets, AA).

1. Hand tokens.json to mobile (tokens.ts), deck (tokens.css) and capsule-pro (Theme.swift), with
   a generator and a test that fails off-system values.
2. Propose `vyre phone add` (with `--android --usb|--wireless`) to polish-cli and tailnet.
3. Verify the iPhone web app over a `*.ts.net` address on a real device (Tailscale issue 19147).

## Needs from others

- native-core: add ["appearance", "Appearance"] to GROUPS; consider a `check: {tool}` field that
  settings.set calls before writing a plain key (appearance.tokens could then drop its tool
  store). Update the Theme.swift and deck.css comments that name docs/design/one-app/tokens.json.
- platform: ADR 0033 calls appearance.theme a preset ("vyre" or "<module>/<name>"); the module
  built the enum system, dark, paper. One of the two changes. A /v1/theme alias and /theme.css
  from the hub are daemon changes (platform's call).
- capsule-pro: capsule.md Gaps, in order. memory-iq: iq.ask stream stages. sessions: the capsule
  prompt (Vyre IQ, cite or say you don't know, temperature 0).
- ci: release-check's install-size gate already fails on main (12936 KB); lib adds about 72 KB.

- relay (parked until after native-core, lead 27 Sep): relay.devices.trust asks no proof when
  trusted is false (reducing trust protects the person; e2e's rule that revoke needs no proof);
  its presence summary names the device ("Trust browser Chrome on alex's Pixel 8 fully") instead
  of the id; and the proposed "Ask to trust" tool (e.g. relay.devices.ask-trust) that puts one
  Device row in Needs on the person's trusted devices. The TrustBrowser board draws all three.
  Accepted and queued by relay (work/relay 5243964, docs/work/relay.md Next).
  Added 27 Sep (mobile's build): record trusted_by and trusted_at on web devices for the
  "Trusted from <device> · <time>" line; mobile hides it until then. Queued by relay (81b0dfa).
- onboard: expose the person's name (onboard.person) so the app's avatar shows their initial.

- integrator: when merging, take this branch's scripts/gen-tokens over work/mobile 622224a's, drop
  capsule-pro's hand-written Swift add-on, then run `npm run tokens` and commit the three outputs
  (apps/app/src/theme/tokens.ts, the Capsule's Tokens.generated.swift, deck/css/tokens.css).
- capsule-pro: Theme.swift reads Tokens.monoSizes, not TypeScale.mono.
- deck: switch deck.css to import deck/css/tokens.css when ready.

- User (via lead): violet or teal; confirm the install defaults (iPhone: web app over Tailscale;
  Android: APK over adb); Planner in the desktop rail and the phone's Places sheet.
- sessions: Session board aligned with ADR 0030 (work/sessions 3496b48): provider, model and auth
  in the chip, the state word, Stop (Esc) as interrupt, queued words with Edit, Take back and
  Send now, idle close "Resumes on your next message", Mac-owned asks. ExitPlanMode and mode
  switches still need a surface design (ADR 0030 open question).
- relay: the hosted app at app.vyre.run and the relay QR copy follow ADR 0026 as proposed.

## Changed contracts

- New module core/appearance (ADR 0035): settings appearance.theme (a preset), appearance.scheme
  and appearance.tokens (group "appearance", account and device level, kept in the hub), tools
  appearance.check (the hub's check), appearance.presets (choicesFrom) and appearance.resolve
  {device?, project?, format?}, event appearance.changed {version, theme, scheme}. No route of its
  own: vyred serves GET /v1/theme and GET /theme.css by calling appearance.resolve.
- tokens.json moved to lib/theme/tokens.json; package.json files gains "lib"; release-check
  requires lib/theme/tokens.json in the tarball.

- scripts/lib/docs/check.js (docs): OWNERS gains "app-design". docs/nav.json gains a "Design system"
  section. package.json gains `design:audit`. New workflow .github/workflows/design.yml (ci).

- New: scripts/gen-tokens and scripts/lib/tokens.js own the token exports (capsule-pro asked,
  27 Sep). The Swift output's default path is local/capsule/native/Sources/UI/Tokens.generated.swift;
  mono sizes are `monoSizes: [12, 13]` (the hand-written file had `mono: (12, 13)` as size and line).

- docs/nav.json (docs team): design/one-app/README.md and DIRECTION.md added under Contributing;
  docs/index.json and docs/reference/index.md regenerated with npm run docs:ref.
- Proposed only: the CLI verbs `vyre phone add` and `vyre allow` / `vyre deny` (lines marked
  terms: ignore until polish-cli builds them).

## Now (28 Sep, cohesion support)

- Lead asked me to give cohesion Design A's interaction rules for docs/design/interaction.md
  (motion tokens, card states, key hints, the swipe rule, the Answer card) and offer 2-3 boards if
  useful. Sent the full rundown by message (msg_id e5bf84f6) rather than drawing boards up front —
  offered streaming IQ / computer-use step pills / multi-device handoff on request, to keep this
  light while still on launch RC support. No board drawn yet; waiting to hear if one would help.

## Now (28 Sep, memory-iq's import + graph view)

- Drew the two boards the lead asked for (Import.dc.html, MemoryGraph.dc.html, +paper each,
  e7aab867): discovered sources (counts, dates, projects, dev folders unticked, choosing is
  confirming — no separate dialog) and live progress (Searchable/Understood/Graph stages,
  per-source checklist) as step 5 of the existing Onboarding.dc.html flow; the graph view drawn
  literally off memory.graph's own contract ("one room per project, a shared room, nodes and
  edges") as bordered room rectangles with node tiles and connecting lines, a cross-project person
  drawing a line into every room it touches, and a clicked node opening its facts in the Answer
  card's confirmed shape (source chips, "Wrong?"/"Undo"). All four pass the audit clean; took a few
  render/audit rounds to fix real overflow (not audit noise — the two-window Import frame genuinely
  didn't fit at my first two height guesses). Handed to memory-iq (msg_id 8582da7f) and flagged to
  launch as non-blocking (msg_id c3fd6735).

## Now (28 Sep, top priority: vault + connections onboarding)

- Lead: "the UI/UX needs to be INSANELY good", top 0.1.1 priority. Two boards, both pass the audit
  clean, both themes, sample world:
  - VaultImport.dc.html/-paper (19a96abd): the onboarding secrets moment, 4 frames — Discover (6
    source cards: .env, shell exports, password manager, Chrome, SSH keys, MCP/Claude config;
    found/in counts; masked project-grouped list; the footer button is the confirm), Touch ID
    (centred card, the canonical shield glyph reused from elsewhere), the live "flying into the
    vault" delight moment (item chips on dashed trails converging on the vault glyph, N-of-34
    counter + progress bar, per-project checklist), Done (grouped summary + Open the vault). This
    is also launch's onboarding-v2.md step 5.
  - Connections.dc.html/-paper (db3dbbfa): Google, mail/IMAP, Apps Script and MCP servers all draw
    from account-row.md's spec as the same card — provider tile, account, status, "Granted to" as
    one-tap toggle chips, "Wrong account?" as a quiet link, never colour for a problem state
    (outline Sign in / Sign in again is the only tell). Desktop + phone frames.
  - Both build directly off account-row.md and credential-sheet.md, which I'd already written and
    which named exactly these boards under their own Gaps sections — nothing new invented.
  - Real lesson from this session: `.frames` does not wrap on its own (`flex-wrap: wrap` alone
    left every cap stacked in one column, not a grid) — multi-frame boards need an explicit
    `.col` of `.row`s, and `.win` height needs real headroom (a two-frame-wide onboarding sheet
    wants close to 900-960, not 620-820) or the render audit's "clipped" is catching a genuine
    overflow, not noise.
  - Sent to vault (msg_id 79e667f5) and launch (msg_id f7dacdfd). Still owe launch: the step-shell
    board and the session-import 5-stage revision (queued, see above).

- cohesion folded the interaction rules into docs/design/interaction.md (5debc1bc, sent binding to
  every 0.1.1 team) and asked for three follow-ups: wrote the confirmed Answer card into
  result-card.md as its real home (00d3f471, see below); streaming IQ / step pills / handoff
  boards stay queued until memory-iq/capsule-pro/glass actually ask, so I'm not guessing at shape;
  the violet-fill cleanup they flagged was already closed by launch's 57eebd9f before they read my
  message — confirmed clean, nothing open there.
- cohesion re-ran the grep on origin/main and reported --beacon-wash back in site/styles.css
  (.held-chip, a .block.beacon-bg). Fetched origin/main fresh (a3a844e4) and checked directly:
  no --beacon-wash anywhere in the file, .held-chip is colour-only, no .block.beacon-bg class
  exists, 57eebd9f is a confirmed ancestor, and four more commits touched the file after it
  (c81244a1, 2b3f55ca, acca5cbc, 342e02f5). Their checkout was stale, not a real regression — told
  them to re-fetch. Also checked core/config/theme.js and every deck/*.css on origin/main for the
  "sanctioned wash pattern elsewhere" they held back from flagging: zero hits there too, so that
  may be stale as well. Nothing open.

- Lead (connectors feedback): Connections board's grant chips were Chat/Planner/Agents, should be
  the vault's real surfaces (Capsule/Chat/Agents/Phone). Fixed both frames (f79b6cad), re-audited
  clean. Also asked to finish card.md and chip.md including "the Connections card row": added the
  Connections card as a named variant in card.md (the account-row grown into a card: the row, a
  "Granted to" filter-chip row per surface, a footer with "Wrong account?" and the connected date)
  and the surface-grant chip as a named filter-chip use in chip.md, cross-linked from
  account-row.md both ways (f65d51e5). While in there, ran npm run docs:check and found it had
  been failing on my own recent edits: 10 em dashes and 3 unregistered `memory.ask` mentions
  across card.md/chip.md/result-card.md, going back to the Answer-card write-up. Fixed all of it;
  docs:check is clean on every file I own now (265 remaining problems are pre-existing shot/
  reference staleness, none mine). Should run docs:check after every spec edit from now on, not
  just at the end.
- Connectors is building the Connections card against production tokens now; watching for their
  Deck card to review when it lands. They asked (crossed with the fix above) whether app-design
  ships deck/css/views/connections.css or they build it themselves off the docs, and flagged the
  same Planner/Phone mistake independently (ADR 0028 decision 9b only grants capsule/chat/agents/
  phone). Told them: they build it, card.md's new Connections card variant is the exact anatomy to
  follow, pull f79b6cad + f65d51e5 first. When their file lands, fill in card.md's Implementing
  file table and close its native-core Gaps line.
- Lead: granting Agents needs presence (Touch ID/passkey), revoking stays one tap always, granting
  Capsule/Chat/Phone stays one tap but now with the undo toast instead of an in-place re-tap
  (47030189). Updated card.md, chip.md (new Asking state on the filter chip) and the board (the
  Touch ID shield glyph trails the Agents chip whenever it's off). Told connectors, who hadn't
  built the DOM yet, before checking with them (msg_id 2bf39209).
- Reviewed connectors' real build (work/connectors 482f7b6d, deck/views/connections.js +
  deck/css/views/connections.css): structure's right, two real fixes needed. (1) toggleSurface
  treats Agents like every other surface — no presence check — built after or crossed with the
  47030189 rule above; they already import withPresence and use it for vault.grant elsewhere in
  the same file, just not wired into this path yet. (2) .cn-chip-on is `--hover`/`--rule-strong`,
  not chip.md's lime On state (--focus border, --signal-wash fill) — traces back to deck.css's
  base .chip never having had an On state at all, and being 26/square instead of spec's 28/full
  radius (chip.md's own pre-existing Gap, now worth closing since they're the ones adding the
  first real On state). Answered their two questions: Sign in again opens the credential sheet
  with {module, need, account} per credential-sheet.md/account-row.md, oauth-only is enough for
  now since every problem card in their data is a sign-in not a missing key; and yes, fold into
  card.md/chip.md now, not later, since f65d51e5 (03:16) landed before their commit (03:42) and
  their "still draft with no Connections row" comment is already stale. Waiting on their fix +
  final class names to close card.md's native-core Gap line (msg_id 717f7d6c).

## Now (28 Sep, chat/native-core-composer/pwa UI/UX review, as built)

- Lead: review the CURRENT chat experience as built (chat 33b81bd1, native-core-composer d5b0ed18,
  pwa), not as designed. Merged the three branches locally (review/chat-native-pwa off main
  4fd286d7, clean octopus merge), ran `deck/test/chat-shots.js` on testbox (desk 1280 + phone 390,
  world's demo/ask/question/composer/rewind/terminal/plan threads), 20 PNGs, no failures (no
  sideways scroll, no console errors). Screens: /tmp scratch (not the repo)
  chat-review-shots/1-demo-desk.png, /6-rewind-desk.png, /6-rewind-phone.png, /8-plan-desk.png
  among others; sent the lead 3 (see message).
- Confirmed present and correct: the sight strip (session.js sightEl/.cv-sight, checks
  sight.targets once, refreshes on sight.stepped, hidden with no target), the project chip
  (.cv-project, correctly a Tag per chip.md), pictures with the shared lightbox
  (deck/chat/lightbox.js, single mounted overlay, 4 MB inline cap), no $ anywhere in the transcript
  (session.js:630's own comment names the reason), the plan card (clean, on-spec), the question
  card (radio list + live preview, on-spec).
- 6 ranked fixes sent to chat (msg_id 34099b56) and native-core (msg_id 105df639): (1) rewind
  sheet has no "Fork from here" though native-core's threads.fork {at} (48de0bd3) shipped with
  exactly that framing, both teams are holding on each other, worth unblocking now; (2) deck.css's
  base `.lbl` is still the retired mono/uppercase label style, ~146 call sites, most visible right
  now in chat's own queued row and todos pin ("QUEUED FOR AFTER", "TODOS 1 of 3"); (3) the phone
  stacks lease bar + todos pin + queued row + the rewind sheet inline above the composer, and the
  rewind sheet should be a real overlay (sheet.md), not drawn in the transcript's own flow; (4) the
  lease bar's "No one is typing" fallback shows on every solo single-device session and reads as
  chat presence, not a keyboard lease; (5) ask-item.js's Allow once/Deny hints are unstyled text,
  not the shared key-hint.md `.kbd` chip everything else in the same view uses; (6) the lightbox is
  aria-modal="true" but explicitly does not trap focus, a real contract mismatch. Tried to reach
  pwa directly (not an active session right now) for the desktop command-bar copy still not
  matching spec ("Search threads, files, people" vs "Jump to anything, or ask juno", a pre-existing
  Gap, still true as built); relayed to the lead instead.
- Specs written up and committed (5051188a, f427f62d): turn.md gained a Session header item
  (project chip + sight strip) and a Picture item (the lightbox), plus 6 new Gaps entries; list-row.md
  gained a Queued row variant and the `.lbl` finding; chip.md cross-links the project chip to its
  existing `.tag` gap. `npm run docs:check` clean on all three (pre-existing shot/reference
  staleness elsewhere, none mine).

## Next
- Follow up once chat/native-core confirm the fork UI and `.lbl` fix land; tick the new Gaps.

## Now (28 Sep, Windows Capsule spec)

- Lead: spec how Design A translates to the Windows Capsule (Tauri shell per windows-plan.md Tier
  C, hosting Deck's web views, Alt+Space, always-on-top). Wrote
  docs/design/system/components/capsule-windows.md (d044f0e1, nav.json + docs:ref regenerated,
  docs:check clean): same content model as capsule-mac.md (same rows, tools, events, tokens), the
  shell differs. Mica on the panel (persistent surface), Acrylic only on the tray's transient
  right-click menu, per Microsoft's own material guidance; `--panel` becomes a translucent tint
  over Mica, every other role stays opaque. Borderless window with DWM rounded corners. Font
  fallback gains Segoe UI Variable/Segoe UI ahead of the Mac-only Helvetica Neue. Native system
  tray icon + menu (kept close to stock Windows styling, not reskinned). Native Windows Toast
  (Action Center) for a Needs-you item when the Capsule is closed, distinct from toast.md's in-app
  Undo toast. Windows Hello, not "Touch ID," on the existing Confirm-send card, same no-nagging
  rule. High contrast mode and transparency-off both fall back to solid tokens.
- Flagged rather than assumed: Alt+Space is Windows' own reserved shortcut for the active window's
  system menu, so once the Capsule itself has focus, native Alt+Space could reopen the OS menu
  instead of closing the panel. Needs a hands-on check; Ctrl+Alt+Space is the fallback. Also called
  out not to wire the Windows system accent colour into `--primary-bg` or any status colour, lime
  stays the one accent, Mica's tint is where "feels like this desktop" belongs.
- Sent to windows (msg_id 30a3d494). Nothing built yet (Tier C hasn't started); this spec exists so
  it starts from Design A and the Mac Capsule's content model.

## Now (28 Sep, teammates section 3: avatar, accent, handoff card)

- teammates asked chat and app-design to agree teammates.md section 3 ("Distinct in chat"):
  proposal was a role-hashed accent colour per teammate (disc, 3px bubble border, a dot in rows,
  ANSI square), a handoff card, one-tap to the teammate's thread.
- Turned down the per-teammate colour. `docs/design/one-app/README.md`'s System section already
  settles this for the whole product: "lime for action... violet for needs you (teal the one
  alternative). No other hue. Devices and hosts never get a colour." A teammate is that kind of
  entity, not a person; hashed hues is the first crack in a rule Design A has held since day one,
  fine at 3 teammates, bad at 8. avatar.md now says so explicitly (73e35ce2), with the one CLI
  exception: `vyre team` output may colour a name from a small fixed, AA-tested set (never an
  arbitrary hash-to-hue), degrading under NO_COLOR, same convention as `git log --graph`.
- Kept and homed the handoff card as a new "Handoff" variant of the existing tool-row (tool-row.md,
  73e35ce2), not a new component: sub-agent icon, "Asked" -> "Replied," folds like any tool row,
  detail renders as turn prose (not a code block, since it's words, not output). This also answers
  their open "indented bubble" question by construction: a teammate's reply lives inside the card's
  detail, never a freestanding message, so there's nothing left to mistake for the assistant's own
  words.
- Ruling sent to teammates (msg_id 059cc442) and chat (msg_id a1f36f57).
- Lead accepted the no-colour call but pushed back: distinct still has to read without colour.
  Added, in the same two files (83434944): the tile is never shown bare, the role name always sits
  beside it in text (handoff card, Agents place row, thread header); a "Teammate" tag (a plain Tag,
  chip.md) follows the name in those same three places, once per surface, not per turn; the
  handoff row is now an explicit exemption from tool-row's "folded run" (same as a plan or todo
  list), always its own visible line, "collapsed" only ever meaning the reply detail is shut. The
  Handoff row's icon is now the teammate's own avatar tile, not the generic sub-agent icon. Final
  versions sent to teammates (msg_id bbfec377) and chat (msg_id ecd9d16b).

- windows confirmed receipt of capsule-windows.md, building Tier C against it
  (windows-plan.md section 9, 87bcd02d). Taking the lead's Alt+Space resolution as final; will do
  the hands-on focused-panel check before shipping it as default and report back. No open
  questions on the rest of the spec.

## Now (28 Sep, generated avatars: agents vs teammates)

- Lead: evaluate DiceBear (fallback Boring Avatars, not needed) for cute per-entity avatars, one
  style for agents, one for teammates, offline, seeded on vyred's unique agent id not the name,
  licence-checked, colour economy honestly assessed. Design only, no product code. Not in this
  repo: `@dicebear/core`/`@dicebear/collection` installed and rendered in a local scratch folder
  outside the repo (path in the message to the lead, not here); Mac local Chrome headless for the
  contact-sheet screenshots, per the lead, no test box needed.
- Recommendation sent (msg_id 1e8d6982): agents get `bottts-neutral`, teammates get `notionists`.
  Compared against `pixelArtNeutral` (agent fallback), `thumbs` and `funEmoji` (teammate
  fallbacks). Licence table in NOTICE-draft.md: notionists is CC0 (clean); bottts-neutral's
  "free for personal and commercial use" (bottts.com) is not a standard licence and is flagged as
  a real open item, not papered over, since it's the only robot-styled set in the collection.
  funEmoji not recommended on fit, not licence or legibility: a fixed identity that's literally a
  crying or worried face reads odd.
  Colour honestly assessed: for the two recommended styles, full colour does not read much better
  than greyscale/duotone (both are line/shape-carried, not hue-carried); pixelArtNeutral and
  thumbs are the two where colour is doing real legibility work.
- Named the tension plainly rather than picking quietly: full-colour generated avatars are a
  deliberate exception to "no colour per agent, no photos" (avatar.md, reaffirmed twice already
  this session for teammates and the Windows accent colour). Left the call with the lead; will
  write it into avatar.md for real once decided.

## Now (28 Sep, launch's Server panel + onboarding screenshot pass)

- Lead: screenshot pass on launch's new Settings > Server ("Move to a server") panel and
  onboarding's "How will Vyre run?" screen (ce9c4c5f, not yet on work/launch's tip when checked;
  worked directly off that commit). Wrote a throwaway CDP script (not committed, a local scratch
  copy of the tree) that runs the real move flow end to end against `deck/fixtures/federation.json`
  (point at a server, plan, start, live progress, ready-to-confirm, after-move) plus onboarding's
  live step, on the test box.
- 5 ranked findings sent to launch (msg_id 9ee66d00): (1) the whole move wizard has no card or
  elevation, reads identically to a static settings row even though it's moving the person's
  entire vault/projects/memory, card.md/plan-card.md's existing pattern is what to reuse; (2) the
  vault's encryption guarantee (anywhere.md is emphatic about it) is invisible in the plan screen,
  "Vault · 23 items · 40 KB" exactly like any other row, no lock glyph, no reassurance line; (3)
  the progress meter renders as a barely-visible underline, not a legible bar; (4) no
  status-mark vocabulary in the flow ("Waiting"/"Done" as plain words, no lime "in progress"
  ring, no hollow done dot); (5) the onboarding radio's selected dot is plain text-colour, not
  lime, unlike every other "selected/checked" mark in the system. Onboarding's own copy and layout
  matched anywhere.md exactly, no findings there.
- One thing flagged, not as a product bug: the onboarding header's "Setting up <hostname>" reads
  `os.hostname()` (core/onboard/index.js:222), correct for a real user, but means test-box
  screenshots show the shared box's real name; didn't forward the raw files outside the team.

## Now (28 Sep, generated avatars round 2: in-chat mockups, 5 pairs)

- User saw round 1's sheet, wants "something cool for both, pookie and modern" with a few real
  options shown IN CHAT. Built 5 pairs, each a realistic in-chat mockup (a session turn, the
  Handoff card expanded with the teammate's face and reply, an Agents list row for both, a
  floating Capsule notification), dark and paper: bottts-neutral+notionists (round 1's baseline),
  big-smile+open-peeps, Boring Avatars "beam"+micah, thumbs+croodles, and an original Vyre concept
  (hand-written SVG: soft blob creatures for agents, small rounded characters for teammates, code
  and art both ours, no licence question). All in a local scratch folder outside the repo (path in
  the message to the lead), not this repo.
- Ranked pick sent (msg_id c441681a): 1) the original blob+character (best legibility at 24px of
  the five, zero licence risk, genuinely charming, not a placeholder); 2) big-smile+open-peeps
  (strongest "makes you smile" hit, CC0 teammate half); 3) beam+micah (best "cool/modern" abstract
  read, cleanest licence mix); 4) thumbs+croodles (solid, least memorable); 5) bottts-neutral+
  notionists (only if agents specifically need to read as robots, bottts's licence still open).
- Ran a real check before shipping, not just a note: swept every pair's generated colours against
  the exact lime/violet hex values (a small hexDist script). Two real hits in DiceBear's own
  bigSmile and micah palettes (occasional violet-adjacent purple, not something to fix in their
  code, flagged as a pre-ship per-seed check); one hit in my own original palette (a blue too
  close to violet), fixed before the final render, so what shipped is clean.

## Now (28 Sep, generated avatars round 3: real teammate variety + role props)

- Lead's note on round 2: teammate characters were too alike (bald, smiling, only colour varied).
  Rebuilt the character generator with independent per-seed variety: 7 hair shapes, optional
  headwear (cap/beanie/headband/bow), optional glasses (round/square), optional earrings
  (stud/hoop), 5 expressions, two independent pastel colours (head + body). Role props exactly as
  asked: design gets a beret or a pencil badge (per-seed), reviewer's prop is glasses forced on
  (no separate badge), docs a book badge, research a magnifier badge, qa a checkmark badge.
  Agent blobs unchanged (already liked).
- Real legibility check, not assumed: rendered actual 24x24 rasters (a true downscale, not a
  scaled-up vector) and looked at them pixel by pixel. Hair, head colour, glasses and expression
  hold up at 24px; badge icon detail (a pencil, a book spine, a checkmark) does not, it blurs to
  "a small dot." Fixed: badges only render at 32px and up; at 24px a teammate is still distinct
  from hair/colour/glasses/expression alone.
- Sent (msg_id bb2f3ce4): sheet-combined.png (12 teammates + 8 blobs, both themes, both sizes),
  mock-combined.png (an in-chat scene showing design/reviewer/qa together so the variety reads in
  context). All in the same local scratch folder as rounds 1-2, not this repo.

## Now (28 Sep, launch's Server panel: second pass, all 5 confirmed)

- launch fixed all 5 findings from the first pass (72d69271: .set-server-card wrapping the whole
  wizard, the vault lock+encryption line, a real .set-meter track+fill, statusMark for
  running/done instead of plain words, the onboarding radio's lime selected dot) and asked for a
  re-check rather than assuming it landed right.
- Re-ran the same real flow on 72d69271 (fresh screenshots, not a diff read): all 5 confirmed
  fixed with the actual UI, not just the code. Sent to launch (msg_id 3cdebc62). Nothing new
  found; cleared it.

## Now (28 Sep, generated avatars round 3b: skin tones + friendly-only)

- Lead: while the user decides, keep teammate HEAD colours to a warm, realistic skin-tone set
  (light to deep), pastel on clothes/accessories only; keep only friendly expressions (smiles, a
  soft closed-eye smile, a gentle neutral), no open-mouth or startled faces. Agent blobs untouched.
- Built on round 3's generator: added an 8-tone SKIN_TONES palette for the head only (bodyColor
  stays pastel for clothes/headwear/glasses/badges); cut face() down to three expressions
  (smile weighted most common, a closed-eye smile, neutral), dropped grin and surprised.
- Re-ran the lime/violet colour sweep against the new palette before rendering anything (not
  after): one existing pastel (#E3C05F, a golden yellow used for clothes/badges) sat about 60
  units from lime, right at the edge; swapped it for a terracotta (#D98E52, 92+ units clear)
  before generating the sheet. All 12 teammates + 8 agents clean.
- Sent (msg_id 0c1565e0): sheet-combined.png (12 teammates + 8 blobs, both themes), mock-combined.png
  (design/reviewer/qa together in a real scene, showing the skin-tone range and friendly
  expressions in context). Same local scratch folder as rounds 1-3, not this repo.

## Now (28 Sep, generated avatars round 4: person + assistant, SVG export for ui-ux)

- User loves the direction, wants more: a generated avatar for the person (the user) that becomes
  their identity everywhere, one for their assistant clearly distinct from agents and teammates,
  and less text-heavy overall. A new ui-ux team is building a visual canvas from static SVGs
  (their own brief: scratchpad/avatar-canvas/BRIEF.md).
- Designed two new identity families on top of avatar.md's existing "only the person gets a
  circle" rule, in round4/identity.js: person = a true circle, a warm two-tone gradient, a calm
  face, no hair or role accessory (4 reroll options); assistant = a soft squircle (rounder than a
  teammate tile, short of a full circle), a luminous gradient with an abstract mark, never a face
  (3 directions: spark, ring, chevron). Four families now have four distinct silhouettes, agent
  blob / teammate tile / person circle / assistant squircle, readable before content even loads.
- Same lime/violet sweep as every round: caught one gradient stop right at the edge before
  export (an assistant option's pale straw tone, ~58 units from lime), fixed before generating
  anything.
- Exported 27 static SVGs + manifest.json (name, role, kind, file, seed/option) to
  round4/svg/: 8 agent blobs, 12 teammates (round 3b's look), 4 user options, 3 assistant options.
  Sent directly to ui-ux (msg_id 7a859a7b) with sourcing notes, and a 5-line opinion to the lead
  (msg_id ca4d26b6): shape carries the real distinction; the user avatar should stay simple and
  un-rolled (it's the one person); the assistant should never be a face (spark is my pick over
  ring/chevron, which read as a spinner and a "next" button); worth seeing all four families
  together in real chat context before anyone commits, not just an isolated grid.
- Design files only, no product code, no avatar.md changes yet (the round is still exploratory).

## Now (28 Sep, round 4 fix: assistant avatar contrast on paper)

- ui-ux found assistant-spark nearly invisible on paper (#F5F2EA), patched around it with a
  caller-side box-shadow ring and flagged it as a source bug, not a mockup nitpick.
- Checked properly rather than just fixing spark: computed real contrast ratios for all three
  assistant options against the paper panel. All three's pale gradient stop measured ~1.0-1.1:1,
  the same problem everywhere, ui-ux just happened to hit it on the one they picked. It's the
  soft-gradient technique itself, not a single bad colour.
  Fixed at the source in round4/identity.js: every assistant avatar now carries its own hairline
  ink ring (stroke, 14% opacity) baked into the SVG, so it always has a defining edge regardless
  of the ground, rather than deepening the gradients (which would have killed the soft/luminous
  look) or leaving every caller to patch around it individually. Re-swept lime/violet clean,
  re-exported all 3 assistant-*.svg to round4/svg/, told ui-ux to drop their workaround.

## Now (28 Sep, round 5: the "Vyre code", a scannable person avatar)

- Lead's direction: the person avatar becomes a unique identifier, seeded from a stable public
  identity (a public-key fingerprint, never a secret), with a scannable full form ("Vyre code")
  like a Snapcode: the face at the centre, a ring of dots around it encoding ~64-96 bits plus a
  checksum and Reed-Solomon, an orientation marker, our own scanner reads it, a plain QR is the
  fallback. Deliver 2-3 visual ring styles (light/dark) plus a real encode/decode prototype and
  its pass rate. Design and prototype only.
- Built: `rs.js` (Reed-Solomon over GF(256), the QR/CD field), `payload.js` (8-byte id + CRC-8 +
  9 RS parity bytes = 144 bits), `vyrecode.js` (rendering, 3 ring styles: dot/ring/tick, both
  themes), `decode-core.js` (pixel sampling + rotation/scale search, shared between a Node
  self-test and real in-browser decode), `harness.js` (renders, degrades with real CSS in real
  Chrome - blur/rotate/scale/perspective/noise -, screenshots, reloads into a fresh canvas, reads
  real getImageData pixels, validates in Node).
- Real result, not simulated: **14/17 degradation scenarios decoded correctly.** All 3 failures
  are perspective (camera-tilt) cases specifically, since the search models rotation+uniform
  scale, not a true homography - a known, scoped next step, not an unexplained gap.
- Found and fixed 3 real bugs while building this (all in NOTES.md, not glossed over): the RS
  decoder had an array-index-vs-field-exponent bug that failed every correctable-error test
  (fixed, fuzz-verified 100/100 through 4 byte errors); a fixed light/dark threshold silently read
  every bit backwards on the dark theme (fixed: try both polarities, let RS decide); and the
  subtlest one, rotating by an exact multiple of the dot spacing samples the identical pixels just
  relabelled, so 36 rotations tie in confidence by construction, and a top-K cutoff was discarding
  the correct one at random, which alone explained a batch of "random"-looking rotation failures.
- Sent to the lead (msg_id e8a49bfa) with full write-up in round5/NOTES.md. Nothing wired into
  product code.

## Now (28 Sep, round 5 beauty pass, ADR 0043, and a fixed face-scale bug)

- User's "eww" on round 5's first ring look, relayed by the lead: face too small relative to the
  ring, 4 stark 1-bit rings read as a technical barcode, marker glyph too separate. Built
  `round5/vyrecode2.js`: face now fills 60% of the diameter, 2 rings not 4 (2 bits/mark, same 144
  bits at half the marks), ticks/dots/dashes coloured from the avatar's own gradient on a soft
  92%-neutral tint (a first attempt at 86% hue read as a flat saturated block, fixed), the marker
  disguised as 3 ascending dots in the same visual language as the marks. `faceSvg` override lets
  the assistant's `creature.js` share the exact same ring geometry and palette technique as the
  person's face - "same hand," one ring implementation for both families.
- The lead's showcase (round4+round5 files, `/tmp/.../scratchpad/avatar-showcase/build.js`)
  surfaced a real bug and hand-patched around it (`scale(3)`) rather than living with it: source
  fixed instead. `renderCode2` stripped a face SVG's outer `<svg>` tag to inline it, which also
  throws away the browser's automatic viewBox-to-size scaling, so the face rendered at its native
  120 units inside a 360-unit (FACE_D) slot - a third size. Fixed generically in
  `round5/vyrecode2.js`: reads the face's own `viewBox` and scales explicitly
  (`FACE_D / faceNativeW`), so it holds for any future face source, not pinned to today's 120.
  Verified with a direct render + regex check on the emitted `<g transform=...>`, not by eye.
- Locked the shape/silhouette rule that's grown across rounds 3-5 as **ADR 0043** (claimed in
  `docs/work/README.md`) and folded it into `docs/design/system/components/avatar.md`: the four
  identity families (person circle / assistant creature / agent blob / teammate tile), why the
  assistant is a creature and not round 4's squircle, the "no AI-brand lookalike" rule now stated
  as covering all four families and the ring marks (not just the assistant's abstract mark), and
  the Vyre code's geometry/palette/pairing contract (a public id/ticket only, never a secret;
  pairing still needs Touch ID/presence per ADR 0032). Handed to `pwa` (decode-core.js/rs.js
  port) and `launch` (render on the Deck's pairing screen) via the lead.
- Design/spec files only; no product code touched. Perspective/homography decode is still the one
  scoped gap (ADR 0043 section 4), unchanged from round 5's NOTES.md.
- Correction (lead, 28 Sep): the user decided there is no plain-QR fallback and no normal-camera
  path - the ring is read only by phone.vyre.run's own decoder. Reworded ADR 0043 (summary,
  context, section 3) to state this and move plain QR to "considered, not chosen," committed
  d24e9c3f. avatar.md never claimed a fallback, so it needed no change.

## Now (28 Sep, widened the Vyre-code outer margin per pwa's decode finding)

- Lead relayed pwa's decoder finding (work/pwa bdca618b, docs/work/pwa.md): the outer margin was
  too thin (~15px), clipping at 120% scale and limiting perspective correction; the two rings were
  also bleeding into each other. Asked to widen the outer margin to 8-10% of the diameter and keep
  the ring gap clearly wider than the longest tick + its cap, then tell pwa and launch the new
  constants.
- Root cause, found by doing the actual arithmetic rather than trusting the old comment: the
  orientation marker (the disguised 3-dot cue), not the ticks, was setting the real outer edge -
  it reached `RING_R[1] + 37.1` versus the longest tick's `RING_R[1] + 31.25`. The first pass's
  margin math only ever checked the ticks.
- Fixed in `round5/vyrecode2.js`: pulled the rings in tight against the face
  (`RING_R = [FACE_R+8, FACE_R+8+34]` = `[188, 222]`, was `[210, 245]`), shortened
  `ticksSunburst`'s tick lengths to `6, 12, 18, 24` (was `8, 15, 22, 29`), and tightened the
  marker's own offsets (`r0+8+k*6`, radius `2+k*1`, was `r0+14+k*9`, radius `2.5+k*1.3`) so it no
  longer out-reaches the ticks. Verified by computing both reaches directly, not by eye: outer
  margin is now 51.75 units (8.6% of the 600 canvas), ring-gap clearance 7.75px. Re-rendered and
  confirmed the module still executes clean (no visual regression check on this Mac - headless
  only, per the no-visible-windows rule).
- Wrote the fix and the corrected invariant into ADR 0043 (814d0b08): the outer edge is
  `max(tick reach, marker reach)`, not tick reach alone - restated so the next person doesn't
  repeat the same mistake.
- Sent the new constants to pwa and launch directly. Not verified end-to-end against pwa's real
  decode harness on my side - that's theirs to re-run against the new numbers.

## Now (28 Sep, geometry consolidated into one shared module)

- Lead: the numbers drifted once already (the widen above), consolidate - one shared constants
  module both the renderer and the decoder import, instead of a second hand-copied set.
- Built `round5/geometry.js`: every constant and reach formula from ADR 0043 2a (`RING_R`,
  `tickLength(level)`/`tickReach(level)`, `markerOffset(k)`/`markerRadius(k)`/`markerReach()`,
  `outerReach()`) plus `validateGeometry()`, which recomputes the margin-percent and gap-clearance
  invariants and throws a specific message if either regresses.
- `vyrecode2.js` now imports from `geometry.js` (dropped its own copies of `RING_R`, the tick
  length formula and the marker math) and calls `validateGeometry()` at load. Verified, not
  assumed: re-rendered and got the identical 51.75px margin / 7.75px clearance as before the
  refactor, and separately proved the guard actually fires by passing an impossible threshold and
  confirming it throws the expected message (not just that the happy path still works).
- Documented as ADR 0043 2b (be7fce03) and told pwa and launch to vendor `geometry.js` itself
  (same pattern as their existing `rs.js`/`payload.js`/`identity.js`/`vyrecode2.js` vendoring) and
  import from it rather than hand-copying values into `decode-core2.js` or a render-side copy.

## Now (28 Sep, launch built the pairing screen off ADR 0043)

- `launch` vendored `rs.js`/`payload.js`/`identity.js`/`vyrecode2.js` into
  `deck/vendor/vyrecode/` (CJS->ESM only, `fingerprint8` moved onto `crypto.subtle` for the
  browser, no logic changes) and used `renderCode2`/`ticksSunburst` exactly as specced.
- Built the live/pairing variant this doc had flagged as launch's to do (shimmer while valid,
  countdown, expired-and-dimmed): `deck/js/phone-code.js`, wired into onboarding's devices step
  behind `can.relayJoin`, f0a85c09 on work/launch.
- Using a placeholder ticket id until tailnet's `relay.pair.ticket` exists; the ring rendering
  itself is not placeholder. Nothing further needed from app-design unless the ticksSunburst
  geometry needs to change once a real ticket shape lands.

## Now (28 Sep, ADR number collision: 0033 renumbered to 0043)

- pwa flagged (after merging main at 90c6d2c1) that the identity-marks ADR's number, 0033, was
  already taken on main by platform's "Hackable Vyre" ADR - this repo's local
  `docs/work/README.md` claim table had gone stale under my own branch (last synced before
  platform's claim landed on main), so RULES.md's "claim it here first" check passed locally
  while colliding for real.
- Checked properly before picking a replacement, not just bumped by one: grepped every active
  worktree's `docs/work/README.md` for any claimed ADR number, not just main's (several
  worktrees carry uncommitted local claims main hasn't seen yet - federation's own 0042 already
  came from resolving an 0041 collision with work/github the same way). Highest claimed anywhere,
  committed or not: 0042 (federation, committed 726576f6). Picked **0043** - one past that, not
  a token +1 off the stale local table.
- Renamed `docs/adr/0033-identity-marks-and-vyre-code.md` -> `0043-identity-marks-and-vyre-code.md`
  and every `ADR 0033` reference to `ADR 0043` in that file and in `avatar.md` (4 occurrences).
  Left `app-design.md`'s own three other `ADR 0033` mentions alone (theme-overrides validation,
  lines above this section) - those are platform's real, correctly-numbered 0033, not mine;
  checked line-by-line before touching anything so the two didn't get conflated.
- Updated `docs/work/README.md`'s claim table: restored platform's actual 0033/0034/0035/0036
  rows (this file's copy was missing them, another symptom of the same staleness) and added 0043
  under app-design with a note explaining the renumbering, so the next person who diffs this
  table against main understands why app-design's row isn't at 0033.
- Told pwa (who caught it), launch (who also references the file), and the lead. No product code
  touched; this is a docs/numbering fix only.

## Now (28 Sep, pwa's two findings: paper contrast + avatar-option source)

- pwa vendored geometry.js/vyrecode2.js/identity.js/creature.js as ESM (deck/vendor/vyrecode/,
  work/pwa 84164e15), decode-core2.js now imports RING_R/tick lengths from geometry.js instead of
  hardcoding - the 2b consolidation is live on their side. Reran their harness against the real
  geometry AND the real renderer (not their earlier flat-color test fixture): 8/17, down from an
  earlier 11/17 measured against synthetic colours. Blur and scale-80 newly failed.
- Measured why instead of guessing: computed real WCAG contrast ratios for `paletteFor`'s
  mark/markDeep against the ring's own tint, across all 4 `USER_GRADIENTS` options. Dark theme
  was fine (8.5-12.3:1). Paper theme wasn't - `markDeep` (levels 2-3) measured a genuinely weak
  1.59-2.57:1 worst case, because it used the raw gradient "deep" stop with no ink mixed in at
  all (every other colour in the palette mixes toward `#141311`; this one didn't). Level 0's tick
  additionally drew at 0.55 opacity with no decode-headroom reasoning behind that number.
- Fixed at the source in `round5/vyrecode2.js`: paper's `mark` mix deepened 0.3->0.5, `markDeep`
  0->0.65, level-0 opacity 0.55->0.85. Worst case across all 4 options now 4.86:1 mark / 7.35:1
  markDeep - roughly double. Verified: re-ran `validateGeometry()` (unaffected, still 51.75px/
  7.75px), confirmed dark theme's palette is byte-identical to before, re-rendered both themes.
  Documented as ADR 0043 2c. Have NOT verified this recovers pwa's 8/17 - that needs their real
  harness, not arithmetic; told them so plainly rather than claiming a fix I didn't measure.
- Second question, avatar-option source for the phone's "same avatar" pairing screen: checked -
  there is no real one. round4/identity.js's own comment says the person's avatar is meant to be
  a deliberate, stored pick ("reroll, or pick from a few, and keep it"), the same kind of thing
  `onboard.person` already stores for the name - never a hash of a device/box key. pwa's
  `sha256(box key)[0] % 4` is a reasonable stopgap but not the intended design. Wrote this into
  avatar.md's Gaps as a real, unbuilt need (`onboard.person.avatarOption` or similar, native-core/
  onboard's to build) rather than just answering pwa in a message and leaving no trace.

## Now (28 Sep, lead's ruling: avatar option defaults from identity)

- Lead ruled on the avatar-option question: default is deterministic from the identity's own
  8-byte fingerprint (zero setup, unique by design), a stored pick is optional and overrides it,
  only the person can set their own. tailnet carries the fingerprint in the verified ticket
  record now; anywhere/onboard builds the optional stored field later, not needed for 0.1.1.
- Implemented `defaultAvatarOption(fingerprint8Bytes, optionCount)` in `round4/identity.js`:
  `fingerprint[0] % optionCount`. Verified live, not just written: a real fingerprint through
  `payload.js`'s `fingerprint8` produced a deterministic option index and rendered through
  `userAvatar` without error. Same function covers the assistant too, on its own separate
  fingerprint - never the person's, matching the separation `creature.js` already required for
  its palette.
- Rewrote the earlier "no stored field" Gap in `avatar.md` to reflect the ruling: the default
  mechanism is no longer a gap at all (it's specified and implemented), only the optional
  override's storage field remains open, explicitly marked "not needed for 0.1.1." Added a proper
  "Avatar option" section to avatar.md and a new ADR 0043 2d documenting the full ruling.
  Committed 6676b4a6.

## Now (28 Sep, pwa's per-mark blur diagnostic: geometry, not palette, tried first)

- pwa sent raw per-mark error counts for the 8/17 run (dark theme, userOption 1): blur 2/4/6px
  gave 18/38/56 errors (all fail), rotation and noise stayed at 3-6 (fine), scale-80 borderline
  at 12. Blur is clearly the dominant failure, not rotation or noise.
- Checked the maths before assuming contrast was the lever (pwa's framing, since their real
  palette scored 8/17 against an 11/17 flat-colour fixture): dark theme's WCAG contrast is
  already 11.74-12.31:1, very high. What actually changed since round 5's original prototype
  (which passed all 3 blur levels clean, per NOTES.md) was 2a's tick-length shrink (8-29px ->
  6-24px) to buy back margin - a short, thin stroke loses proportionally more signal to a
  fixed-pixel blur kernel than a wider one does, independent of colour. Team-lead had also told
  pwa not to touch the palette themselves.
- Tried the geometry-only lever first: widened TICK_STROKE_WIDTH 4.5->6 in geometry.js (matching
  dashesRounded's own width), not the lengths (would reopen the margin problem) or the palette.
  Re-verified margin/gap: 8.5%/7px, still comfortably within spec. Documented as ADR 0043 2e
  (0612f4c2), told pwa plainly this is a hypothesis to test against their real harness, not a
  claimed fix - if it doesn't move the blur numbers, palette contrast or a scoped blur-tolerance
  gap (the same treatment perspective already gets) is next.

## Now (28 Sep, confirmed: stroke-width fix worked, 14/17, only perspective left)

- pwa's first rerun against the wider stroke was 0/17 - even pristine broke. Real cause was on
  their side, not mine: a round line-cap always overshoots a tick's nominal length by its own cap
  radius, and widening the stroke grew that overshoot 2.25px -> 3px, which against LEVELS' 6px
  spacing was enough to misquantize several marks with zero degradation applied. pwa fixed it in
  decode-core2.js (subtract TICK_CAP_RADIUS before quantizing, sha 5e5e2d86) - geometry.js already
  exported that constant for exactly this, it just wasn't consumed on the decode side yet.
- Result: **14/17**, matching round 5's original synthetic-fixture ceiling almost exactly, now on
  the real palette and geometry. Remaining 3 failures are all perspective (15/30deg, worst combo)
  - the same already-scoped homography gap from round 5's first pass, not a new one. Documented
  the full close-out in ADR 0043 2e (08e9af7d).
- pwa also wired renderPersonAvatar() to defaultAvatarOption() per 2d's ruling, falling back to
  their old box-key guess until tailnet's identity fingerprint lands in the resolve record - as
  expected, nothing further needed from app-design there.
- Net: 0.1.1's Vyre-code work is design-complete on my side. What's left (15/17 needing
  perspective/homography correction) is a decoder algorithm task, not render tuning - flagged to
  the lead as such rather than continuing to iterate blindly on geometry/palette.

## Now (28 Sep, skin-tone legibility fix, avatars locked)

- User's decision: "lock on avatars, but some of them were getting too dark skin colors and so
  they weren't clearly visible, so fix that and then lock it." Scoped: only the teammate family
  (round3b/original.js's character()) draws a real skin tone; person and assistant use an abstract
  gradient/mark, never a skin representation, so neither needed a change.
- Measured two failures with WCAG contrast on the actual hex values, not by eye: feature ink
  (fixed near-black) was 1.3-2.6:1 on the three deepest skin tones, and the head washed into its
  backdrop at both ends of the range - the four deepest tones against dark theme (1.15-3.94:1),
  the four lightest against paper theme (1.05-2.89:1), each in the theme where that end sits
  closest to the backdrop. The range itself stays exactly as it was; nothing removed or lightened.
- Fixed at the source in identity.js: featureInkFor(skinHex) picks dark or light ink per tone,
  rimFor(skinHex, theme) adds a thin edge ring only on tones that fail the floor in that theme,
  validatePalette() checks all 8 tones x 2 themes x 3 backdrops (24 combos) plus each tone's own
  ink, next to the existing validateGeometry(). 48/48 pass, worst case 3.68:1 (floor is 3:1).
  character() gained a theme param (default "dark", matching vyrecode2.js's own convention).
- Verified visually with a headless-Chrome contact sheet (temp Chrome profile, no visible window)
  across all 8 tones, both themes, both --panel and --hover backdrops, and in the full
  avatar-showcase in context - every tile reads clearly. Vyre-code ring untouched:
  validateGeometry() still passes at 8.5% margin / 7px gap clearance, matching 2b exactly.
- Locked: ADR 0043 gained section 5 with the full rationale and numbers; avatar.md gained a
  matching "Skin-tone legibility, locked" section. Committed 949d9e78.
- Found (git log, not yet coordinated when I started): native-core had already vendored the OLD,
  unfixed characters.js/identity.js at deck/vendor/vyrecode/ and built deck/js/avatars.js +
  avatars.test.js (13/13) against it, on their own branch (commits cdc3f257, 8820d6ce) - avatars.js
  itself says "THIS FILE IS THE ONLY IMPORTER... when app-design sends the locked files, swapping
  them is a change here and in the vendor folder only." Vendored the fixed files at that exact
  path (deck/vendor/vyrecode/{identity,characters,geometry,creature,vyrecode2}.js), converted from
  the scratchpad's CJS to ESM to match the repo's module type - verified all five load and run
  correctly under `node --input-type=module`. One integration note sent to native-core along with
  the sha: avatars.js:133 calls `character(seed, size)` without a theme, so it's currently getting
  the "dark" default always - should become `character(seed, size, theme())` (theme() already
  exists in that file, used for the Vyre-code ring) so the rim renders correctly in paper theme too.
- Next: none on this from my side unless native-core's re-run of avatars.test.js surfaces
  something. Contact sheet lives at (scratchpad, not committed - same convention every other
  round's preview/verify PNG used) round3b/contact-sheet-fix.png.

## Now (28 Sep, 5th family: project tiles, locked)

- User approved a 5th family: project tiles (a rounded square, a mark and a colour, never a face
  or creature), plus draft tiles for loose chats and a project-colour badge for teammates.
  identity.js gained PROJECT_COLORS (8 hues, tuned per-hue after a flat S/L left one hue at
  3.13:1); round4/project.js is the new file (projectTile(), teammateProjectBadge()).
- Reused the section-5 mechanism rather than inventing a second one: PROJECT_COLORS runs through
  the same validatePalette() (96 checks total now, 48 skin + 48 project, worst case 3.68:1).
  Draft tiles keep the true colour always (never swapped for rim ink) - a continuous rim-coloured
  line sits under the dash where needed, same add-not-replace principle the solid tile's own rim
  already uses. First draft implementation DID swap the colour when a rim was needed; caught it
  against the user's own "same colour" spec before locking, fixed to the add-not-replace version.
- Contact sheet (round4/contact-sheet-project.png, scratchpad, same convention as the skin-tone
  one): 8 colours x solid/draft x both themes x 20/24/32/40px, all legible down to 20px.
- Locked: ADR 0043 section 6, avatar.md's five-family table + new "Project tiles, locked" section.
  Committed e84bb767.
- Vendored at deck/vendor/vyrecode/ (native-core's own import path): identity.js and characters.js
  updated, project.js new, all ESM. Verified all six files load and run under
  `node --input-type=module`. Sent native-core the API: projectTile(seedBytes, {draft, theme,
  size}), teammateProjectBadge(color, theme), and character()'s new fourth projectColor param.

## Now (30 Sep, chat components contract + Capsule 0.2 + Glass theme)

- User's top-priority ask: design, once, the common things agents show in chat (diff, PR review,
  email, calendar, report, questions/survey, approval flows, checklist, progress, file/link
  preview, handoff, error/offline, artifact card) so every surface and every provider renders the
  same thing. Full contract in team/0.2/plans/app-design.md section 10; six new component docs
  (pr-review.md, email-thread.md, calendar.md, confirmation.md, file-preview.md, artifact-card.md)
  plus four extended (question-card.md's Survey variant, diff.md's Multi-file variant, pill.md
  reading link.health, banner.md pointing to pill instead of duplicating it) committed to
  work/app-design (c4093b41). Two emission mechanisms cover all thirteen, not a new one each:
  ADR 0030's ask.raised/answered kind enum for anything blocking, ADR 0033's renderer:<tool> slot
  for anything that isn't - verified against the real code/ADRs, not invented. Caught and fixed my
  own error before commit: a first pass put the C5 unreachable-box line in banner.md as a new
  variant; native-core had already committed C5 to the existing pill, so moved it there.
  Mockups: team/0.2/chat-components.html, screenshotted clean in both themes.
- Second ask, same session: Capsule 0.2 screens (ask/checking, corrections, provider chip,
  hand-off, selection rewrite, morning glance, computer-use pills + Esc, deep-Chrome control,
  compact chat components, offline) plus a new GLASS theme (translucent, vibrant, macOS-vibrancy-
  style: a fixed-alpha neutral tint blended over a blur, not a plain blur, which is what keeps
  text contrast anchored regardless of wallpaper). Computed real WCAG contrast across 4 sampled
  wallpaper tones (bright sky, warm dusk, dark night, deep forest) for 3 alpha options before
  picking one, not by eye: Option A (alpha .80, frosted, safe), Option B (alpha .62, deep glass,
  recommended - worst case 5.5-15.9:1 dark, 6.9-16.9:1 light, real margin over AA's 4.5:1), Option
  C (alpha .45, vibrant tinted, bold - bright-sky case only 4.69:1, flagged as too tight to ship
  as default). Reduced-transparency falls back to the plain opaque panel via one @media rule.
  Mockups: team/0.2/capsule-02.html, all 10 screens plus the 3 glass options over 4 wallpapers
  each, screenshotted and verified section by section (headless Chrome, ImageMagick crops - sips
  cropOffset turned out unreliable on this macOS version, switched tools rather than trust a bad
  crop).
- Both pages: real Vyre tokens as the base palette, no fixture or sample-world names (generic
  placeholders like "A. Chen", "Q3 renewal numbers" instead), no em dashes anywhere including in
  the HTML copy itself (caught and fixed 10 instances of the &mdash; entity before review).
- Sent to the lead: both file paths, ready for review.

## Now (30 Sep, computer-use oversight panel added to capsule-02.html)

- Added section 11 to capsule-02.html: the draggable computer-use oversight panel (plan with
  current-step highlight and in-place editing, a course-correct prompt, a live voice transcript,
  pause/resume/stop), the full 6-moment collaborative flow for a "build a GoHighLevel automation"
  job (agent drafts -> person tweaks -> runs step by step -> voice interjection mid-way -> plan
  updates -> continues), a compact collapsed state, Chrome's native "being debugged" bar
  coexisting with the panel (drawn as Chrome itself draws it, never restyled - restyling it would
  misrepresent what's actually in control), and the three vault extension moments (save login,
  API key detected, autofill), all in the Glass theme. Reuses plan-card.md's numbered step list
  rather than inventing a new one.
- Caught and fixed two real bugs before sending, not after: the flow captions were unreadable
  directly on some wallpaper gradients (fixed: white text + shadow instead of the plain --label
  grey, which assumed a near-black backdrop that isn't true mid-wallpaper); the vault moment
  bars had their action buttons in a separate div that visually overlapped the bar's wrapped text
  (fixed: buttons moved inside the same flex row as the bar, wrapping below on a narrow card,
  same one-row pattern banner.md already uses elsewhere).
- Re-screenshotted section by section after each fix (ImageMagick crops of a 900x9600 headless
  render) rather than trusting the first pass.

## Now (30 Sep, user approved Deep glass; save and pause for a usage-limit restart)

- User approved Option B, "Deep glass," for the Capsule, condition: the Capsule stays exactly
  what it is today. Same 680px width (Theme.width, Spotlight-sized), same bar height, every
  existing feature (app search and launch, files, contacts, dictionary, settings, clipboard
  history and snippets, calculator, commands) unchanged - Glass is a new skin on the launcher,
  not a redesign of it.
- Already done (section 11, capsule-02.html, committed c2e92cd2, before this pause): the
  computer-use oversight panel (plan/prompt/voice/pause/resume/stop), the 6-moment collaborative
  flow, the compact collapsed state, Chrome's "being debugged" bar coexisting, and the three vault
  moments (save login, API key detected, autofill). The lead's pause note listed these as "still
  due" - they are not; flagging here so the next session doesn't redo them, only verifies.

## Next

- **Still due, not started:** the main Capsule search at 680px in Deep glass, showing the
  existing launcher doing what it already does - app search and launch, file results, a command
  result, contacts/dictionary/calculator where they fit naturally in the result list, keyboard
  selection (the focused row), and the clipboard history view. This is the condition the user's
  approval came with (same width, same features, glass is only the skin) - the mockup has to
  actually show the familiar Capsule, not a new layout, or it doesn't prove the condition was met.
- **Still due, not started:** the primary CTA colour. Today's lime (#C6F36B) was chosen for the
  opaque panel; the user wants it reconsidered against the Deep glass backdrop specifically (it
  may read too flat/poster-like sitting on a blurred, vibrant surface) and wants 2-3 options shown
  before picking one - not a unilateral swap. Approach for next session: render the existing lime
  primary button on the Deep glass panel over 2-3 of the same sampled wallpapers already used for
  the theme itself, alongside 2 alternatives (candidates to consider: a warmer, less saturated
  lime that reads less "sticker" against blur/saturation; a neutral light-on-dark pill matching
  the panel's own vibrancy instead of an accent colour; a desaturated version of the existing
  lime) - compute real contrast for each against the glass panel's own effective background the
  same way the three glass alpha options were verified (worst case across sampled wallpapers, not
  eyeballed), and keep the lime exactly as-is everywhere else in the product (chat, setup, every
  non-Capsule surface) - this is scoped to the Capsule's Deep glass skin only unless the user says
  otherwise.
- Both items go into capsule-02.html alongside what's already there; screenshot headlessly,
  section by section, before sending.

## Session 6 (30 Sep, after restart)

- Done: team/0.2/cta-options.html (lime replacement options: A Ember, B Tide, C Bone, contrast checked on opaque and glass, both themes, glass rule = accent as fill or dot, neutral chip text, two-tone focus ring). Lead told. Tokens NOT changed; waiting for the user's pick. On pick: change lib/theme/tokens.json (+ generated files), core/config/palette.js and theme.js, deck css, site css, brand marks, docs/design/TOKENS.md and boards.
- Done: capsule-02.html section 12, the 680px Deep glass main search (apps, files, contacts, dictionary, calculator, commands, focused row, clipboard history), screenshotted and looked at.
- Next: apply the picked colour product-wide, then support building teams.

## Bone applied (30 Sep)

- The user picked C, Bone (no accent). Applied product-wide: tokens.json + generated files (gen-tokens --check clean), palette.js/theme.js, deck/site/docs CSS, brand marks, app icons, splash, og, docs screenshots (pixel-recoloured from lime and paper green, not retaken: retake with scripts/docs-shots on a CI runner when convenient), boards, specs. Glass rule: no chip wash, two-tone focus (chip.md); glass text contrast test in core/config/palette.test.js.
- test/no-lime.test.js fails on the old hex, its washes, the paper green and the word (history files exempt). Other UI teams: use the tokens only.

## Session 7 (30 Sep, relaunch after usage-limit restart)

- Reviewed launch's setup page (work/launch-onboard-fix 705f31c9, site/setup) against Design A and Bone: tokens only, no fixture names in the page, placeholders or labels. Posted 3 fixes in CHAT.md (10:40): `.lbl` back to sans sentence case, `.warn` to a `--hover` fill with no violet border, plain words (Tailscale network, server not box, no "relay" or "progress lines", label "Arrive").
- native-core land cards and project-page actions, and capsule-pro's oversight panel: not built yet in either worktree (checked native-core-0.2 4b19f800 and capsule-02-glass 62645bee), so nothing to review. Spec is chat-components.html and capsule-02.html section 11. Review each when their first commit lands.
- Next: re-grep launch after its fixes; review native-core land cards and capsule-pro's panel when they commit.

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

- New module core/appearance: settings appearance.theme and appearance.tokens (group
  "appearance"), tools appearance.check, appearance.resolve, appearance.tokens.get/.set, route GET
  /v1/appearance/theme (ETag), event appearance.changed {version, theme}.
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

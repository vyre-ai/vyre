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

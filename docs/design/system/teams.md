---
title: Spec lists by team
summary: Every open gap in the Design A v1 specs, sorted by the team that closes it, with the items to do first and the checks that say a team is done.
audience: builders
owner: app-design
status: draft
---

# Spec lists by team

This page sorts the Gaps sections of the [component specs](README.md) by team, so each team has one
list to work from. The specs stay the source of truth: when you close an item, tick it in the spec
Gaps list in the same commit, and this page follows.

The Capsule redesign spec (capsule.md) is being written now. When it lands, capsule-pro's list
gains its items.

How items are assigned:

- Deck items go to pwa (the deck shell, `deck/css`, `deck/js`, `deck/views`, Glass), unless the
  file is chat's (`deck/chat/`) or native-core's (the Settings view). An item that touches files of
  two teams is listed under both and marked shared.
- App items go to mobile. Capsule items go to capsule-pro.
- System items fix a board, `icons.txt` or a token, and go to app-design.
- One core item has no team yet (see the end).

## pwa

Owns the Deck shell: the rail, top bar, phone shell, sheets, Now, Find, Planner, Vault, Devices,
Glass, the shared CSS in `deck/css/deck.css` and the icons.

### Start here

1. Tokens, not hand typed values: drop the old `--r-2`, `--signal` and the `--scrim` and `--float`
   redefined in `sheet.css`; read `deck/css/tokens.css` ([button](components/button.md),
   [sheet](components/sheet.md), [icons](components/icons.md), [rail](components/rail.md)).
2. One button system: `.btn` and `.sb` fold into one button with the five variants, hold and busy
   ([button](components/button.md)).
3. Sentence case: `.btn` is mono caps with letter spacing; use Instrument Sans 13/18 weight 600
   ([button](components/button.md)).
4. 44 touch targets: the phone shell switches at 720, not 760, and `.ibtn` needs the 44 size
   ([phone shell](components/phone-shell.md), [icon button](components/icon-button.md)).
5. AA and disabled: no `opacity` for disabled, a quiet fill and `--label` ink instead
   ([button](components/button.md), [sheet](components/sheet.md)).
6. Status marks: the running ring, crossed circle and hollow done dot in `deck.css`, and the 18
   badge ([status mark](components/status-mark.md)).
7. Violet only for needs you: remove the beacon wash and rules in Glass, the top bar, desktop Now,
   held cards and failed marks ([glass frame](components/glass-frame.md),
   [top bar](components/top-bar.md), [needs row](components/needs-row.md),
   [card](components/card.md)).

### All open items

Agenda, `deck/views/planner.js`, `deck/css/views/planner.css` ([agenda](components/agenda.md))

- [ ] No hour grid, event blocks or now line; the agenda is rows.
- [ ] The firing banner labels the ring " · ring 2" in beacon, not "Ringing again · 2 of 4" in `--text-2`.
- [ ] Snooze has no duration in its label, and there is no Dismiss.
- [ ] No "Live" status; no missed banner copy "Missed while the box was down".

Ask card, `deck/js/need-sheet.js` ([ask card](components/ask-card.md))

- [ ] Phone sheet primary reads "Approve" and key hints read ⏎/esc; spec: "Allow once", A and D.

Avatar, `deck/css/deck.css`, `deck/css/sheet.css` ([avatar](components/avatar.md))

- [ ] `.initial` is 24 with a `--rule-strong` border, mono 11 weight 500; use the sans initial, no border, meta 12/16 weight 600.
- [ ] `.avatar` (the person) is 28, mono 11 with letter spacing, bordered; use 32 or 34 circle, sans, no border.
- [ ] `.nsh-tile` is 22 with radius 6; use 24 with radius 6.

Banner, `deck/css/views/planner.css` ([banner](components/banner.md))

- [ ] No shared banner: `.pl-banner` and chat's `.term-note` each draw their own, and the planner's banner uses a beacon border; use `--hover` fill and no border. Shared with chat.

Button, `deck/css/deck.css`, `deck/css/sheet.css` ([button](components/button.md))

- [ ] `.btn` is JetBrains Mono 12, weight 500, upper case with letter spacing; use Instrument Sans 13/18 weight 600, sentence case.
- [ ] No secondary, outline (plain `.btn` is it but unnamed), hold or busy; disabled uses `opacity: 0.45` and primary disabled keeps the lime fill.
- [ ] `.btn-ghost` ink is `--text-2`; use `--text`. Radius uses the old `--r-2`.
- [ ] A second system, `.sb` (min 46) and `.sb-primary` (54, 17/22) with opacity disabled; fold into the one button at 44 and 54.

Card, `deck/css/views/now.css`, `deck/css/views/planner.css` ([card](components/card.md))

- [ ] No shared card class: `.np-card`, `.pl-card`, chat's `.gate-card` and `.cv-tool` each define their own radius and padding; make one `.card` with `--radius-card`. Shared with chat.
- [ ] Held cards on main draw body rules in `--beacon-rule`: violet as a border, remove.

Chip, `deck/css/deck.css` ([chip](components/chip.md))

- [ ] `.chip` is 26 tall with radius `--r-1` and ink `--text`, no on state; use 28, round, `--text-2`, and `.chip-on`.
- [ ] `.tag` is mono 11 with a `--rule-strong` border; use sans 12 on a `--hover` fill.

Command bar, `deck/views/find.js`, `deck/css/views/find.css`, `deck/js/capsule.js`, `deck/js/commands.js` ([command bar](components/command-bar.md))

- [ ] Desktop has no ⌘K palette: ⌘K focuses a 420 px field in the top bar with a dropdown, and Find is a separate full page ("Find or ask").
- [ ] Desktop placeholder reads "Find or ask", not "Jump to anything, or ask juno".
- [ ] Phone switch is at 760 px (`PHONE_QUERY`), not 720.
- [ ] Vault codes never show in Find; the Layout board places codes in Find on the phone.

Device row, `deck/views/vault-places.js`, `deck/css/views/vault.css`, `deck/js/health.js` ([device row](components/device-row.md))

- [ ] Devices lists only vault autofill browsers (`vault.devices`), not the relay devices from `relay.devices.list`; no path, holds or trust columns.
- [ ] Remove is a confirm button "Revoke" / "Revoke now", not a hold; no Rename.
- [ ] The relayed dot in `deck/js/health.js` is amber; use `--label`.

Draft card, `deck/js/need-sheet.js`, `deck/js/editable.js` ([draft card](components/draft-card.md))

- [ ] No "Send at 9:00 tomorrow"; no D key on Discard. Shared with chat.
- [ ] Presence line wording "Face ID covers sends until 14:32, confirmed 6 min ago" (only on the phone sheet).

Form controls, `deck/css/deck.css` ([form controls](components/form-controls.md))

- [ ] `.input` is 40 tall on `--panel` with a 15 size; use 32 on `--bg` at 13 (40 is the large field). Focus has no ring.
- [ ] The toggle `.sw` is 34 x 20 with an on track of `--text`; use 32 x 18 and `--primary-bg`.
- [ ] `.seg` has a `--rule` border and 26 segments with `aria-pressed`; use the `--hover` container, 28 segments and radiogroup semantics.
- [ ] No stepper or select component (native `select.input` in settings).
- [ ] `.search` is 420 wide on `--panel` with a `--rule` border; use the field.

Glass frame, `deck/glass/` ([glass frame](components/glass-frame.md))

- [ ] The idle chip uses `--beacon-ink` text, border and `--beacon-wash`; spec is neutral.
- [ ] Read-only and hold banners use `--beacon-wash` (`.gl-banner`, `.gl-notice-hold`).
- [ ] Copy says "Someone has control from <surface>", not "Your phone has control".
- [ ] Error rows and messages tint violet (`.gl-msg-err`, `.gl-tr-err`, `.gl-danger`).
- [ ] Accent reads the raw `--signal` variable instead of `--focus`.

Icon button, `deck/css/deck.css` ([icon button](components/icon-button.md))

- [ ] `.ibtn` radius uses the old `--r-2`; switch to `--radius-button`. No 44 size, no filled round variant, no busy.

Icons, `deck/js/icons.js` ([icons](components/icons.md))

- [ ] Drawings differ from icons.txt for now, projects, memory, agents, vault, settings, search, plus, mic, send (points right, not up), file, copy, bell, clock, key.
- [ ] Missing planner, devices, x (has close), failed, chev-d (has chevron), more, stop, faceid, eye, hand, qr, box, wifi-off, refresh, drive, link, download, share, globe, shield, pause, play, cable, alarm, todo, unlock.
- [ ] Extra names not in the set (lock, watch, pin, mute, edit, lines, mail, branch, login, pass, ask): add to icons.txt through a design review or retire.
- [ ] `mark()` fills the dot with `--signal`, which the tokens no longer define; use `--mark-dot` and `--beacon-dot`.

Key hint, `deck/css/deck.css` ([key hint](components/key-hint.md))

- [ ] `.kbd` is mono 11 with padding 0 6 and radius `--r-1`; use 12/16, padding 0 5, min width 20, `--radius-chip`.
- [ ] Ask hints read "⏎" and "esc" where the design keys are A and D; lower-case "esc" should be "Esc".

List row, `deck/css/views/find.css`, `deck/css/views/planner.css` ([list row](components/list-row.md))

- [ ] No generic row: chat's `.thread-row` and `.fb-row`, `.pl-row` and `.fd-row` each set their own height, padding and type; make one `.li` with the variants. Shared with chat.
- [ ] Failed marks are violet in places; use the crossed circle in `--text-2`.

List, `deck/css/deck.css` ([list](components/list.md))

- [ ] `.rows` and `.section-head` have no sticky group headers, no filter chips with counts, no key footer; long lists page with "Show earlier" only.
- [ ] No skeleton rows (lists show "Loading devices." text); no slow-box line at 10 s.

Needs row, phone, `deck/js/need-rows.js`, `deck/js/now-phone.js`, `deck/css/views/now.css` ([needs row](components/needs-row.md))

- [ ] Kind line omits the kind (`thirdLine` is "agent · project"); no "asked by", no decided state; kinds limited to ask, draft, question, pair.
- [ ] An approve goes at once with no Undo; a draft's right swipe opens the sheet instead of committing Send with the Face ID glyph.
- [ ] Swipe is pointer events in JavaScript, not a scroll-snap strip.
- [ ] Title 16/21, detail 15/20, age 13; the tile has a `--rule-strong` border.

Needs row, desktop, `deck/views/now.js`, `deck/css/views/now.css` ([needs row](components/needs-row.md))

- [ ] A card per item with inline actions, not list and detail; no J, K, A, D keys.
- [ ] Time and error text in `--beacon-ink`, rules in `--beacon-rule`, gold `--recall-ink`: remove.

Authenticator code, `deck/views/vault-item.js`, `deck/css/views/vault.css` ([otp](components/otp.md))

- [ ] No next code; the code sits in a field row labelled "Code", not "Authenticator".
- [ ] Ring is 20 px, and seconds render "18s" without the space.
- [ ] Codes come from the box each period, not computed on the device, so offline shows nothing.
- [ ] Copy is an icon button with the tooltip "This vyred has no vault.copy yet" when missing.
- [ ] No phone Codes list with tap-to-copy rows.

Phone shell, `deck/js/app.js`, `deck/css/deck.css`, `deck/js/capsule.js`, `deck/js/sheet.js` ([phone shell](components/phone-shell.md))

- [ ] Switches at 760 px, not 720.
- [ ] The avatar opens a Settings sheet, not the Places sheet; there is no pin-a-fourth-page.
- [ ] Header gap is 12 and padding 0 12 0 16 (spec 14 and 0 16).
- [ ] Push and pop run 300 and 240 ms on their own curves, not `--motion-panel` and `--ease`.
- [ ] The Capsule hides on every pushed screen, including Planner.

Pill, `deck/js/reconnect.js`, `deck/js/pwa.js`, `deck/css/deck.css` ([pill](components/pill.md))

- [ ] The reconnect state draws as `.reach`, a full-width line above the view with a bottom rule; make it the floating pill.
- [ ] 60 s words read "Reconnecting since 14:32"; use "No answer from the box since 14:02 · Retry now".

Presence line, `deck/js/need-sheet.js`, `deck/js/person.js` ([presence line](components/presence-line.md))

- [ ] Wording "Face ID covers sends until 14:32, confirmed 6 min ago"; spec: "Face ID confirmed 12 min ago · covers sends until 15:02".
- [ ] No "Last Face ID 34 min ago" line in the lapsed state.
- [ ] The sign-in sheet's primary reads "Sign in with your passkey"; spec: "Sign in with Face ID" plus the code path button and the unlock list.

Rail, `deck/js/app.js`, `deck/css/deck.css` ([rail](components/rail.md))

- [ ] The rail is 216 px with text rows 34 tall at 14 px, not the 72 px icon rail.
- [ ] Order is Now, Projects, Memory, Agents, Chat, Vault, Settings; Planner and Devices are missing.
- [ ] The count is violet mono 11 px text, not the 18 px badge; no 99+ cap.
- [ ] Brand sits in the top bar (`.brand`, 216 wide) instead of the mark at the top of the rail.
- [ ] Uses raw `--r-2` radius and the old `--beacon-wash` elsewhere in the shell.
- [ ] No ⌘1 to ⌘9 place keys.

Sheet, `deck/js/sheet.js`, `deck/css/sheet.css`, `deck/js/need-sheet.js` ([sheet](components/sheet.md))

- [ ] Motion is 340 in and 240 out on a custom curve; use `--motion-sheet` and `--motion-panel` with `--ease`.
- [ ] The page behind scales to 0.94 over black; remove, the scrim is enough.
- [ ] `--scrim` and `--float` are redefined in sheet.css; read the tokens.
- [ ] Desktop is always the 560 centred card; no right sheet. Buttons are `.sb` at 46 and 54 with opacity for disabled; use the button spec.
- [ ] Title is 26/32; use 22/28.

States, `deck/css/deck.css`, `deck/js/empty-actions.js`, `deck/js/now-phone.js` ([states](components/states.md))

- [ ] No skeleton outside the phone Now card; loading is text.
- [ ] Offline is a full-width line (`.reach`), not the pill; no 2 s and 60 s stages.
- [ ] Long lists use "Show earlier", not "Load 40 more" with a count; no sticky group headers.
- [ ] Failed marks are violet in places (status marks); spec is the neutral crossed circle.

Status mark, `deck/css/deck.css` ([status mark](components/status-mark.md))

- [ ] No running ring, crossed circle or hollow done dot in `deck.css`; `.dot.recall` and relayed health dots use gold.
- [ ] Rail count is violet text, not a badge; `.needs-pill` is a violet wash.
- [ ] The phone tab bar badge is 16 tall, 10 px text; use 18 and meta size.

Stepper and checks, `deck/views/pair.js`, `deck/js/pair-steps.js`, `deck/css/pair.css`, `deck/js/phone-setup.js`, `deck/onboard/onboard.js` ([stepper and checks](components/stepper-checks.md))

- [ ] No laptop "Add your phone" sheet in Devices; no relay QR step and no optional Tailscale step.
- [ ] `phone-setup.js` is a three-step card on Now (install, notifications, passkey), not the five live checks.

Tabs, `deck/css/deck.css`, `deck/glass/index.js`, `deck/css/views/memory.css` ([tabs](components/tabs.md))

- [ ] No Session, Terminal, Files tabs or teammate tabs; `.seg` is used with `aria-pressed` or `role="group"` in places and `role="tablist"` only in Glass.
- [ ] `.seg` draws a `--rule` border, 26 tabs and `--hover` for the selected fill; use the `--hover` container and the `--panel` selected tab.
- [ ] `.mem-tab` in Memory is a third tab style (34 tall, text only); fold into these two.

Toast, `deck/js/now-phone.js`, `deck/css/views/now.css`, `deck/css/views/vault.css` ([toast](components/toast.md))

- [ ] Two toasts: `.np-toast` on Now and `.vt-toast` in the vault; make one shared toast.
- [ ] No in-place variant; an approve's toast has no Undo (the answer goes at once).
- [ ] Toast shadow is `--light-top`; use `--float`. Words 15/20; use the type steps.

Top bar, `deck/js/app.js`, `deck/css/deck.css` ([top bar](components/top-bar.md))

- [ ] Bar is 48 tall, flex not the three-column grid; brand and the box address sit on its left.
- [ ] No page title in the bar; views draw their own headings.
- [ ] The search field is 420 wide inside the bar, not the centred command bar trigger.
- [ ] The needs pill uses `--beacon-wash` fill and a pill shape; spec is text in `--beacon-ink` on no fill.
- [ ] No right-slot page primary with N.

### Done when

- `npm run tokens -- --check` passes and no Deck CSS file defines a value the tokens hold.
- `npm run design:audit` passes for every board you changed, and you looked at each PNG.
- The Deck tests pass (`node --test "deck/**/*.test.js"`).
- Every Deck item above is ticked in its spec, so no spec lists an open Deck gap on a pwa file.

## chat

Owns the chat view in the Deck: turns, tool rows, diffs, ask, question, plan and draft cards, the
terminal, the thread list, and the composer and mode chips (the composer is shared with
native-core).

### Start here

1. Tokens and one button system: Stop is ghost, make it secondary; the ask card's "Always in" is
   ghost, make it outline ([composer](components/composer.md), [ask card](components/ask-card.md)).
2. Sentence case and the type steps: the mono 11 caps step labels, turn footers, steer markers and
   tool meta become meta 12 sans ([question card](components/question-card.md),
   [turn](components/turn.md), [tool row](components/tool-row.md)).
3. Status marks: failed uses the crossed circle, not beacon ink; running is a spinner and a
   `--text-2` verb ([tool row](components/tool-row.md), [status mark](components/status-mark.md)).
4. Violet only for needs you: remove the beacon wash on the ask card, `.diff-del` and the terminal
   error dots ([ask card](components/ask-card.md), [diff](components/diff.md),
   [terminal](components/terminal.md)).
5. The words: "Edits allowed" and "Plan first", not "Accepts edits" and "Plan mode"
   ([mode chip](components/mode-chip.md)).
6. The plan card, which is not built at all ([plan card](components/plan-card.md)).

### All open items

Ask card, `deck/chat/ask-item.js` ([ask card](components/ask-card.md))

- [ ] `.cv-ask.ask-card` fills `--beacon-wash` (a violet wash); spec: `--panel` with `--rule`.
- [ ] Title weight 500; spec: 600.
- [ ] "Always in" is a ghost button; spec: outline.
- [ ] No per-button busy verb; all three disable with no spinner.

Avatar, `deck/chat/chat.css` ([avatar](components/avatar.md))

- [ ] `.av-agent` is 28 with `--r-2` and a border; `.av-person` is 28. Neither size is in the scale.

Banner, `deck/chat/term.css` ([banner](components/banner.md))

- [ ] No shared banner: `.term-note` draws its own; use the shared banner. Shared with pwa.

Card, `deck/chat/chat.css` ([card](components/card.md))

- [ ] No shared card class: `.gate-card` and `.cv-tool` define their own radius and padding; use the one `.card` with `--radius-card`. Shared with pwa.

Composer, `deck/chat/composer.js`, `deck/chat/core/composer-state.js`, `deck/chat/tray.js`, `deck/chat/pickers.js` ([composer](components/composer.md))

- [ ] No Attach, vault chip or Dictate; placeholder "Steer kit, or Alt+Enter to queue for after".
- [ ] Mode labels "Accepts edits" and "Plan mode"; ⇧Tab walks three modes and never Doesn't ask.
- [ ] Rewind offers three restores; spec: one list, the "Also undo file changes" checkbox, the hold.
- [ ] Todos pinned above the composer on the desktop; spec: side panel.
- [ ] Stop is ghost; spec: secondary.

Diff, `deck/chat/core/line-diff.js`, `deck/chat/lib/diff.js`, `deck/chat/chat.css` ([diff](components/diff.md))

- [ ] Removed lines strike through (`text-decoration: line-through`); spec: no strike.
- [ ] Removed text is `--label`; spec: `--text-2`.
- [ ] Added sign in the signal colour; spec: `--label` sign, colour only in the fill.
- [ ] Mono 12.5/21; spec: 12/20.
- [ ] Legacy `.diff-del` in `deck/chat/chat.css` uses the beacon colour and wash; remove it.

Draft card, `deck/chat/gate-item.js` ([draft card](components/draft-card.md))

- [ ] No "Send at 9:00 tomorrow"; no D key on Discard. Shared with pwa.
- [ ] Badge "Held for you" beside the title; spec: header dot and "Draft to send" label.

Form controls, `deck/chat/chat.css` ([form controls](components/form-controls.md))

- [ ] Two checkboxes: `.cv-chk` on is lime, the design is `--text`.

List row, `deck/chat/chat.css` ([list row](components/list-row.md))

- [ ] No generic row: `.thread-row` and `.fb-row` set their own height, padding and type; use the one `.li`. Shared with pwa.

Mode chip, `deck/chat/composer.js`, `deck/chat/core/composer-state.js` ([mode chip](components/mode-chip.md))

- [ ] Labels are "Accepts edits" and "Plan mode"; use "Edits allowed" and "Plan first". The order is default, acceptEdits, plan; use plan, default, acceptEdits, bypass.
- [ ] ⇧Tab never reaches Doesn't ask, and the box's `threads.mode` refuses bypass (ADR 0030); the 27 Sep decision needs a person-only path in core (proposed) and an ADR update.
- [ ] No inverse chip, no mode icons, no menu (the chip only cycles); the model chip shows the model only, not provider and auth.

Pill, `deck/chat/chat.css` ([pill](components/pill.md))

- [ ] `.cv-queued-row` is a dashed bordered box for a queued chat message; the offline queued line is the plain clock and words above.

Plan card, `deck/chat/core/grouping.js`, `deck/chat/core/tool-detail.js` ([plan card](components/plan-card.md))

- [ ] Not built. The plan text shows as an unfolded tool row with no approve controls; the ask of kind plan needs this card, the Needs row "kit has a plan to approve", and the mode choice.

Popover, `deck/chat/pickers.js` ([popover](components/popover.md))

- [ ] `.composer-menu` and `.cv-menu` rows use their own sizes; align to 28 and 30 dense rows.
- [ ] No mode popover with descriptions yet; mode labels read "Accepts edits" and "Plan mode".

Presence line, `deck/chat/gate-item.js` ([presence line](components/presence-line.md))

- [ ] The gate card has no presence line.

Question card, `deck/chat/question.js`, `deck/chat/lib/answers.js` ([question card](components/question-card.md))

- [ ] `.cv-q-chip` step label is mono 11 px caps tracked; spec: meta sans, sentence case.
- [ ] Question 15/23 at weight 500, labels 14/20 at 500; spec: read 600 and base 600.
- [ ] Card border `--rule-strong`, radius 10; spec: `--rule`, radius 12.
- [ ] Choice numbers mono 11 on the left; spec: kbd chip on the right.

Status mark, `deck/chat/chat.css` ([status mark](components/status-mark.md))

- [ ] Failed state words use `--beacon-ink` in `chat.css` (`.cv-state-*`).

Terminal, `deck/chat/term.js`, `deck/chat/term.css`, `deck/chat/lib/term-link.js` ([terminal](components/terminal.md))

- [ ] Key bar is one row of nine (Esc Tab Ctrl Alt ← ↑ ↓ → Paste); spec: two rows of seven with / | ~ - and Enter.
- [ ] Watch line reads "Watching at 120x40 · Take size"; spec: names the owner device.
- [ ] Connecting dot uses the gold `--recall`; error and blocked dots use `--beacon-dot`; spec: `--label` and the failed mark.
- [ ] xterm font 13 with line height 1.2; spec: mono 12/18.

Tool row, `deck/chat/core/grouping.js`, `deck/chat/core/tool-detail.js`, `deck/chat/chat.css` ([tool row](components/tool-row.md))

- [ ] `.cv-tool` is a bordered card (38 high, `--panel`, radius 8); spec: a borderless 28 line.
- [ ] Failed uses `--beacon-ink` and a beacon border; spec: crossed circle in `--text`.
- [ ] Running state word is lowercase in the signal colour; spec: spinner plus `--text-2` verb.
- [ ] Meta is 11 px; spec: 12.

Turn, `deck/chat/session.js`, `deck/chat/core/session-state.js`, `deck/chat/chat.css` ([turn](components/turn.md))

- [ ] Steer marker reads "Steered at step N" in mono 11 px in the signal colour; spec: "you steered here · after 3 steps · 14:32", meta sans, `--label`.
- [ ] Turn footer `.cv-turn` is mono 11 px; spec: meta 12 sans.
- [ ] `.cv-text` is 15/24; spec: 15/22.
- [ ] Thinking body border 2 px `--rule-strong`; spec: 1 px `--rule`.

### Done when

- `npm run design:audit` passes for the Session boards you changed, and you looked at each PNG.
- The chat tests pass (`node --test "deck/chat/**/*.test.js"`).
- Every item above is ticked in its spec, so no spec lists an open Deck gap on a `deck/chat/` file.

## native-core

Owns the Settings view in the Deck (`deck/views/settings-keys.js` and its CSS), the hub, and the
composer with chat.

### Start here

1. Chips only when they mean something: no source chip for a default value, and "Claude Code file"
   becomes the source itself ([settings row](components/settings-row.md),
   [chip](components/chip.md)).
2. Status marks and plain words: refusals say "Not saved" with the failed mark, not the raw error
   ([settings row](components/settings-row.md)).
3. The restart banner and the resting apply hints "Next session" and "After restart"
   ([banner](components/banner.md), [settings row](components/settings-row.md)).
4. A named Reset with Undo ([settings row](components/settings-row.md)).
5. The key id only in search results, not in mono under every label
   ([settings row](components/settings-row.md)).

### All open items

Banner ([banner](components/banner.md))

- [ ] No restart banner on the Settings page.

Chip, `deck/views/settings-keys.js` ([chip](components/chip.md))

- [ ] Source labels include "Default" and "Not set"; show no chip for a default value, and add the "Claude Code file" chip.

Settings row, `deck/views/settings-keys.js`, `deck/css/views/settings-keys.css` ([settings row](components/settings-row.md))

- [ ] The source chip is always shown, including "Default" and "Not set"; show it only when the value is not the default, and drop "Not set".
- [ ] "Claude Code file" is a second chip on every Claude-owned key, beside the source; it should be the source itself, with the row read-only and Open file.
- [ ] Reset is a bare "Reset" that does not name its target; no Undo after a reset.
- [ ] Apply hint is printed after a save as "Applied", "From the next session", "Restart vyred to apply"; use the resting hints "Next session" and "After restart" and print nothing for live keys.
- [ ] No "Saved", no reserved slot (meta and note lines grow the row), no restart banner.
- [ ] The key id is printed under every label in mono; show it only in search results.
- [ ] Refusals print the raw error; use "Not saved" with the failed mark.

### Done when

- `npm run design:audit` passes for the Settings boards you changed, and you looked at each PNG.
- The Deck tests for the Settings view pass (`node --test "deck/**/*.test.js"`).
- Every item above is ticked in its spec.

## mobile

Owns the app (`apps/app`, Expo) on the phone and tablet.

### Start here

1. Load Instrument Sans: labels render in the system font today
   ([phone shell](components/phone-shell.md)).
2. One button system: `Button` gains 28 and 54, hold, busy, leading icon and key hint, and screens
   stop rolling their own ([button](components/button.md)).
3. 44 targets: the 44 single and two-line rows, and `IconButton` at 44
   ([list row](components/list-row.md), [icon button](components/icon-button.md)).
4. Status marks: `StatusMark` gains the badge, count, status word, the cross for failed and elapsed
   time on running ([status mark](components/status-mark.md)).
5. One `Icon` component from the set, with react-native-svg ([icons](components/icons.md)).
6. Violet only for needs you: the ask card border stays neutral while open
   ([ask card](components/ask-card.md)).
7. The shell: header labels and page swipe instead of the tab bar, the floating Capsule and Places
   as a bottom sheet ([phone shell](components/phone-shell.md), [sheet](components/sheet.md)).

### All open items

- [ ] Agenda: no planner. ([agenda](components/agenda.md))
- [ ] Ask card, `src/session/Rows.tsx`: border turns `--beacon` while open; spec: neutral border. ([ask card](components/ask-card.md))
- [ ] Ask card, `src/session/Rows.tsx`: Allow once and Deny only; no Always in the project, no reason, no busy state. ([ask card](components/ask-card.md))
- [ ] Avatar, `src/ui/Row.tsx`, `src/ui/Screen.tsx`: the agent tile is a circle (`radius.full`) with `--text-2` ink at 32; it needs the rounded square and a shared `Avatar` component with the four sizes. ([avatar](components/avatar.md))
- [ ] Banner, `src/ui/NotifyBar.tsx`, `src/ui/SignInBar.tsx`: inline bars with their own styles; build one Banner with icon, fact, detail and one action. ([banner](components/banner.md))
- [ ] Button, `src/ui/Button.tsx`: four variants at 44 and 32 only; add 28 and 54, hold, busy, leading icon and key hint; ghost ink is `text2`; screens roll their own buttons. ([button](components/button.md))
- [ ] Card, `src/session/Rows.tsx`, `src/vault/views.tsx`: AskCard and TrustCard are inline styles; extract one Card with header and footer slots. ([card](components/card.md))
- [ ] Chip, `app/devices.tsx`: the devices badge is bordered with radius chip; no filter chips, no source chip. ([chip](components/chip.md))
- [ ] Command bar: no Find, no command bar, no Capsule. ([command bar](components/command-bar.md))
- [ ] Composer, `src/session/Composer.tsx`: text only; no chips, attach, prefixes, queued row, pills or rewind; input 16 not 17. ([composer](components/composer.md))
- [ ] Device row, `app/devices.tsx`: no holds line, no More, no Rename or Remove hold, no Update ready. ([device row](components/device-row.md))
- [ ] Device row: trust note reads "Presence follows"; name the proof ("Face ID follows"). ([device row](components/device-row.md))
- [ ] Device row: trust tags draw as outline chips; use the tag (fill `--hover`, no border). ([device row](components/device-row.md))
- [ ] Device row: no 40 tile and no right-hand path column; the path is a text line under the name. ([device row](components/device-row.md))
- [ ] Diff: not built; edits show as a tool row with no diff. ([diff](components/diff.md))
- [ ] Draft card, `app/need/[id].tsx`: fields are read-only; spec: edit in place. ([draft card](components/draft-card.md))
- [ ] Draft card: no presence line; no "Send with Face ID" state; sends from the Deck or the Capsule "for now". ([draft card](components/draft-card.md))
- [ ] Form controls, `src/session/Composer.tsx`: only the composer's text input exists (16 px); build the other eight at touch sizes. ([form controls](components/form-controls.md))
- [ ] Glass frame: no Glass view. ([glass frame](components/glass-frame.md))
- [ ] Icon button: no icon button; screens use `Pressable` with text. Build `IconButton` with 44 default and the icon component. ([icon button](components/icon-button.md))
- [ ] Icons: no icon component; build one `Icon` from the table with react-native-svg. ([icons](components/icons.md))
- [ ] Key hint: no key hints; add them for iPad and web builds with a hardware keyboard. ([key hint](components/key-hint.md))
- [ ] List row, `src/ui/Row.tsx`: one 86 tall three-line shape for everything (`ROW_HEIGHT`); add the 44 single and two-line variants and selected, focused states. ([list row](components/list-row.md))
- [ ] List row: rows sit on `--bg` with a bottom border, not in a card; the avatar is round, not a tile. ([list row](components/list-row.md))
- [ ] List, `src/ui/List.tsx`: no sticky group headers, no Load 40 more, no chips (virtualized above 100 rows is correct). ([list](components/list.md))
- [ ] Mode chip, `app/session/[id].tsx`: the mode is a text line under the composer and the header chip is "agent · provider · model · project"; build both chips and the mode sheet. ([mode chip](components/mode-chip.md))
- [ ] Needs row, `app/(tabs)/index.tsx`: kind line is "agent · project"; only gate and ask kinds; no decided state. ([needs row](components/needs-row.md))
- [ ] Needs row, `src/ui/SwipeRow.*.tsx`: commit at 40% of the row width, not 100 or a fling; reveal has no icon or Face ID glyph. ([needs row](components/needs-row.md))
- [ ] Needs row: rows sit on `--bg` full width, not in a `--panel` card. ([needs row](components/needs-row.md))
- [ ] Authenticator code: no vault codes. ([otp](components/otp.md))
- [ ] Phone shell, `app/(tabs)/_layout.tsx`: a bottom tab bar (Now, Chats, Agents) instead of the header labels and page swipe. ([phone shell](components/phone-shell.md))
- [ ] Phone shell, `app/places.tsx`: no floating Capsule; Places is a modal screen, not a bottom sheet. ([phone shell](components/phone-shell.md))
- [ ] Phone shell, `app/_layout.tsx`: Instrument Sans is not loaded, so labels render in the system font. ([phone shell](components/phone-shell.md))
- [ ] Pill, `src/state/connection.ts`: `toConnection` and the outbox list exist; no pill or queued line is drawn. ([pill](components/pill.md))
- [ ] Plan card: not built. ([plan card](components/plan-card.md))
- [ ] Popover, `app/session/[id].tsx`: no popover or picker; mode is plain text. ([popover](components/popover.md))
- [ ] Presence line, `src/state/needs-model.ts`: coverage is computed, nothing is drawn; sends go to the Deck or the Capsule. ([presence line](components/presence-line.md))
- [ ] Question card: not built; the ask card sends you to the Deck. ([question card](components/question-card.md))
- [ ] Rail: no rail at 720 and up; tablets get the phone tab bar. ([rail](components/rail.md))
- [ ] Settings row, `app/settings.tsx`: no settings rows; build the phone layout (44 controls, reserved line, stepper). ([settings row](components/settings-row.md))
- [ ] Sheet: no sheet; Places is a modal screen and Needs detail is a pushed screen; build the bottom sheet on Reanimated with the same detents. ([sheet](components/sheet.md))
- [ ] States, `src/ui/Screen.tsx`: `Empty` only; no skeleton, no offline pill (`useConnection` is unused), no decided state. ([states](components/states.md))
- [ ] Status mark, `src/ui/StatusMark.tsx`: no badge, count or status word; done uses a 1 px border (1.5); the failed mark is a slashed circle, not the cross; no elapsed time on running. ([status mark](components/status-mark.md))
- [ ] Stepper and checks, `app/pair.tsx`: pairing shows a status line only; no steps, checks or QR. ([stepper and checks](components/stepper-checks.md))
- [ ] Tabs: no tabs; build `Tabs` with the segmented and strip forms. ([tabs](components/tabs.md))
- [ ] Terminal: not built. ([terminal](components/terminal.md))
- [ ] Toast, `src/ui/UndoToast.tsx`: Undo text is `--focus` (lime); use `--text`, 600. ([toast](components/toast.md))
- [ ] Toast, `src/ui/UndoToast.tsx`: floating only; no in-place variant; no ⌘Z on the web build. ([toast](components/toast.md))
- [ ] Tool row, `src/session/Rows.tsx` RunRow: no icon, no elapsed timer, no detail; "Hide"/"Show" text instead of a chevron. ([tool row](components/tool-row.md))
- [ ] Tool row: status mark dot instead of the icon. ([tool row](components/tool-row.md))
- [ ] Top bar, `src/ui/Screen.tsx`: no desktop or tablet top bar; `Screen` draws a phone title only. ([top bar](components/top-bar.md))
- [ ] Turn, `src/session/Rows.tsx`: no author line (tile, name, time). ([turn](components/turn.md))
- [ ] Turn: your bubble is `--panel` with a `--rule` border; spec: `--hover` fill, no border. ([turn](components/turn.md))
- [ ] Turn: thinking reads "Thought · N characters" and never opens; spec: "Thinking · 8 s", expandable. ([turn](components/turn.md))
- [ ] Turn: steer marker reads "Steering" / "Steered at step N"; spec: "you steered here · after 3 steps · 14:32". ([turn](components/turn.md))

Files are under `apps/app/` on work/mobile.

### Done when

- `npm run tokens -- --check` passes and screens read `apps/app/src/theme/tokens.ts`, not typed values.
- `npm run design:audit` passes for the phone boards you changed, and you looked at each PNG.
- The app's own tests pass on work/mobile.
- Every App item above is ticked in its spec.

## capsule-pro

Owns the Capsule on the Mac (`local/capsule/native/Sources/`): the panel, the list of what waits,
the session panel, presence and the menu-bar item.

### Start here

1. Tokens, not hand typed values: `Theme.swift` maps tokens to old names and types its own sizes;
   read `Tokens.generated.swift` ([Capsule on the Mac](components/capsule-mac.md)).
2. One button system: `AgentButton` uses `Tokens` primary colours, `Radius.button` and the five
   variants ([button](components/button.md)).
3. Sentence case: "HELD FOR YOU", "WAITING ON YOU", "OFFLINE" and the mono caps section headers
   become sentence case ([ask card](components/ask-card.md), [list](components/list.md),
   [states](components/states.md)).
4. 44 targets: rows are 40 tall; use 44 ([list row](components/list-row.md),
   [needs row](components/needs-row.md)).
5. Violet only for needs you: the selected row has a violet left bar; use the `--hover` fill
   ([needs row](components/needs-row.md), [Capsule on the Mac](components/capsule-mac.md)).
6. Status marks: the ring for Pulse, the badge, neutral relayed health
   ([status mark](components/status-mark.md)).
7. The icon set as SwiftUI shapes instead of SF Symbols ([icons](components/icons.md)).

### All open items

- [ ] Agenda, `Host/Planner.swift`: the banner says "Missed: Timer"; no ring count. ([agenda](components/agenda.md))
- [ ] Ask card, `UI/AgentDeskView.swift` HeldCardView: buttons read "Allow" and "Deny"; no "Always in <project>", no reason line. ([ask card](components/ask-card.md))
- [ ] Ask card: label "HELD FOR YOU" in mono caps, tracked; spec: "Permission", sentence case. ([ask card](components/ask-card.md))
- [ ] Avatar: no avatar; the Capsule board draws 20 tiles with radius 5. ([avatar](components/avatar.md))
- [ ] Banner, `UI/AgentDeskView.swift` WaitingHint: a 30 tall hint line; banners are not drawn in the Capsule panel. ([banner](components/banner.md))
- [ ] Button, `UI/AgentDeskView.swift` `AgentButton`: primary is a `bone` (text) fill, radius 6, pressed at 0.8 opacity; use `Tokens` primary colours, `Radius.button`, the five variants and the states. ([button](components/button.md))
- [ ] Capsule on the Mac, `UI/Theme.swift`: maps tokens to old names and hand-types sizes (query 22, title 14, label 10.5 mono, rows 40); only colours, status and `Radius.card` come from tokens. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: placeholder reads "Search, calculate, ask, or @ a session". ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: list header is "WAITING ON YOU · n" in mono caps in the attention colour; the focused row has a violet left bar instead of `signalWash`. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: offline banner reads "OFFLINE" in caps, not "Works offline · 1 queued". ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: always dark; no `Tokens.paper`. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac, `UI/PresenceView.swift`: reads "Touch ID to approve exactly this." with no 30 min covered line. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: `AgentButton` primary is bone on graphite, radius 6, not lime `primaryBg`. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac, `Host/Panel.swift`: radius is `Tokens.Radius.card` (12), not `sheet`. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Capsule on the Mac: `Tokens.generated.swift` has no shadow tokens, so `--float` cannot come from it yet. ([Capsule on the Mac](components/capsule-mac.md))
- [ ] Card, `UI/AgentDeskView.swift` HeldCardView: hand-typed sizes and a caps mono label; use `Tokens.Radius.card` and the 12/600 sentence-case label. ([card](components/card.md))
- [ ] Chip, `UI/CapsuleView.swift`, `Extensions/sight/SessionPanel.swift`: chips are capsule-shaped with gold icons (`Theme.recall`); use the tag and filter shapes and neutral ink. ([chip](components/chip.md))
- [ ] Composer, `UI/CapsuleView.swift`, `Extensions/sight/SessionPanel.swift`: plain field; no steer, queue, Stop, modes or prefixes. ([composer](components/composer.md))
- [ ] Diff: not built. ([diff](components/diff.md))
- [ ] Draft card, HeldCardView: field keys in caps, tracked; label "HELD FOR YOU"; spec: sentence case. ([draft card](components/draft-card.md))
- [ ] Draft card: no scheduled send; no presence line under Send. ([draft card](components/draft-card.md))
- [ ] Form controls, `UI/CapsuleView.swift`, `UI/AgentDeskView.swift`: system `TextField` and `TextEditor` styling; no toggles, segments or steppers. ([form controls](components/form-controls.md))
- [ ] Icon button, `Extensions/sight/SessionPanel.swift`, `UI/CapsuleView.swift`: close and mic buttons are SF Symbols at 11 to 13 pt with no hover fill or focus ring; draw the set's icons in a 28 square with `Tokens` colours. ([icon button](components/icon-button.md))
- [ ] Icons: SF Symbols everywhere (xmark, chevron.down, sparkle.magnifyingglass, mic.fill); draw the set as SwiftUI `Shape`s from the same path data. ([icons](components/icons.md))
- [ ] Key hint, `UI/CapsuleView.swift` `KeyCap`: SF Rounded 10.5 semibold in `Theme.stone`, 17 square, filled `Theme.raised`; use JetBrains Mono 12, 20 tall, no fill, `Tokens` label ink. ([key hint](components/key-hint.md))
- [ ] List row, `UI/CapsuleView.swift` Row: 40 tall with hand-typed sizes (14, 12, 11.5); selected is a rounded raised fill with a 3 px lime capsule on the left; use 44, the type steps and the `--hover` fill. ([list row](components/list-row.md))
- [ ] List, `UI/CapsuleView.swift` SectionHeader: mono 10 caps with tracking; use 12/600 sentence case. ([list](components/list.md))
- [ ] List, `UI/AgentDeskView.swift` WaitingList: caps at 9 rows (`Theme.maxRows`) with no count or more. ([list](components/list.md))
- [ ] Mode chip: none; the session panel needs the provider chip at least. ([mode chip](components/mode-chip.md))
- [ ] Needs row, `UI/AgentDeskView.swift` WaitingRow: two lines, no kind line, a 7 dot for the tile, 40 tall; header "WAITING ON YOU" in caps. ([needs row](components/needs-row.md))
- [ ] Needs row: selected row has a 2 px violet left bar (violet as a border); use the `--hover` fill only. ([needs row](components/needs-row.md))
- [ ] Pill, `UI/AgentDeskView.swift` OfflineBanner: a 30 tall line with "OFFLINE" in caps and "vyred is not running on this Mac. Start it with vyre up."; use the pill words, sentence case, no caps label. ([pill](components/pill.md))
- [ ] Plan card: not built (proposed: the Needs row with Start building on `⌘⏎`, the card opening in Chat). ([plan card](components/plan-card.md))
- [ ] Popover, `UI/AgentDeskView.swift` ActionMenuView: caps title with tracking and a 2 px `Theme.signal` left bar on the active row; use the `--signal-wash` fill and a 12/600 sentence-case header. ([popover](components/popover.md))
- [ ] Presence line, `UI/PresenceView.swift`: only the proof prompt ("Confirm it's you", "Touch ID to approve exactly this."); no covered line under Send and no lapsed "Send with Touch ID" label. ([presence line](components/presence-line.md))
- [ ] Question card: not built. ([question card](components/question-card.md))
- [ ] States, OfflineBanner: reads "OFFLINE" in caps; no queued count; no skeleton. ([states](components/states.md))
- [ ] Status mark, WaitingRow, `UI/CapsuleView.swift`, `Host/MenuBarItem.swift`: waiting dot uses `Theme.attention` at 7 px; tool rows use SF Symbols; Pulse is a lime 7 px dot, not the ring; no badge; relayed health is not neutral. ([status mark](components/status-mark.md))
- [ ] Toast: no toast; add the floating variant under the Capsule's list for answers given there. ([toast](components/toast.md))
- [ ] Tool row, `UI/CapsuleView.swift` ToolRows: SF Symbols instead of the stroke set; no folding, no detail. ([tool row](components/tool-row.md))
- [ ] Turn, `UI/CapsuleView.swift`, `UI/AgentDirectView.swift`, `Extensions/sight/SessionPanel.swift`: three renderers; one turn view. ([turn](components/turn.md))
- [ ] Turn: author in mono caps; spec: sans 600, sentence case. ([turn](components/turn.md))
- [ ] Turn: no steer marker, no thinking row, no turn footer. ([turn](components/turn.md))

Paths are under `local/capsule/native/Sources/` on work/capsule-pro. The terminal spec lists the
Capsule as not used (it opens the terminal in the Deck); that is not an item to build.

### Done when

- `npm run tokens -- --check` passes and no Swift view types a size, colour or radius the tokens
  hold.
- `npm run design:audit` passes for the Capsule boards you changed, and you looked at each PNG.
- The Capsule tests pass (`local/capsule/native/Tests`).
- Every Capsule item above is ticked in its spec, and the items capsule.md adds.

## app-design (system items)

These fix the boards, `icons.txt` or the tokens, not a surface.

- [ ] Chip: the boards draw tags with radius 5; the token is `--radius-chip` (4). ([chip](components/chip.md))
- [ ] Form controls: the stepper is drawn twice (a `--hover` fill in Settings, a `--rule-strong` outline in Project settings); the spec takes the fill. ([form controls](components/form-controls.md))
- [ ] Icons: add minus and unlock to `icons.txt`; the Vault board draws the faceid frame without its face, which is not in the set. ([icons](components/icons.md))
- [ ] Key hint: the "Settings · account and project scopes" board draws ↵; use ⏎. ([key hint](components/key-hint.md))
- [ ] Mode chip: the composer chip radius 6 is not a token; add one or use `--radius-button`. ([mode chip](components/mode-chip.md))
- [ ] Tabs: the teammate phone strip is drawn 40 tall; the spec makes it 44. ([tabs](components/tabs.md))

Done when `npm run design:audit` passes on every changed board and each item is ticked in its spec.

## Not assigned

- [ ] Device row, core: `relay.devices.remove` and `relay.devices.trust` both ask for presence;
  Remove (a hold) and Stop trusting need no proof. Parked with relay; the summary should name the
  device, not its id ("Trust browser Chrome on alex's Pixel 8 fully").
  ([device row](components/device-row.md))

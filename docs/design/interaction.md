---
title: "Interaction: one language for all of Vyre"
summary: How Vyre streams, updates live, answers optimistically, and shows its work, on every surface, so the whole product feels like one system built with the same hand.
audience: builders, agents
owner: cohesion
status: draft
---

# Interaction: one language for all of Vyre

Every team's 0.1.1 plan is good on its own. Read side by side, they use three different languages
for the same moment: a live view (Glass's RFB stream), a batched push (federation's session sync,
explicitly not live), and a streamed answer with sources (memory-iq's IQ). This page names the one
language and points at where each rule is already specced, so a team builds against a citation,
not a rewrite. It does not repeat `docs/design/one-app/DIRECTION.md` (the smoothness bar, gestures,
the install path) or `docs/design/system/components/*` (the built card and control vocabulary); it
says which of those already answer a question, and adds only what neither covers yet.

## 0. The exact numbers and shared states (app-design, confirmed 2026-09-28)

Every rule below cashes out to these, so a team implements against numbers, not a feeling.
Motion tokens (`tokens.md`): tap 120 ms, panel 220, sheet 280, text reveal 150, hold 600, Undo
4000 ms, ease (0.25, 0.1, 0.25, 1). Reduced motion drops shine/spin/slide; a state change still
shows some way, since motion never carries information alone. Card and row states are one shared
vocabulary, not a per-component invention: hover (desktop, fill `--hover`), pressed (phone, no
transition, fill `--hover`), focus (2px `--focus` outline, offset -2), selected (fill
`--signal-wash`), swiping (phone only, the rule below), committed (row height to 0 over the tap
token, an Undo toast in its place) - plus the seven list-level states in `states.md` (empty,
loading, offline, error, many items, long names, decided). One thread runs through all of it:
violet is text-only, never a fill (a dot, a label, a count), lime is the one primary per surface
and never decorative, and nothing optimistic is silent - every reversible action gets an Undo,
every irreversible one gets a hold, never a confirm dialog.

## 1. Streaming: show progress under 100 ms, never a blank card

DIRECTION.md's bar already sets the number: first content under 100 ms switching places, streaming
gap under 50 ms p95. What's new here is naming who owes a stream and doesn't have one yet:
`memory.ask {stream:true}` (iq-everywhere.md's contract: `memory.thinking`/`memory.answered`) is <!-- terms: ignore -->
built on work/memory-iq but not yet the default path anywhere; the Capsule (Said.swift), chat and
the Deck/phone Find card all still show an answer whole or not at all. Command results through
`Render {kind}` (7 kinds, cohesion item 6, b7bbf5d8) should stream the same way once a command's
answer is itself slow (a search, a report) - today it renders once the whole payload lands.

## 2. Live updates without polling: events, not refresh

The pattern is: a module owns a fact, it emits a `*.changed` event on every write, a surface
subscribes once and never polls. Built: `sight.stepped`, `context.changed`, `waiting.changed`
(cohesion), `appearance.changed` (capsule-pro's theming item). The one place in the current plans
that inverts this on purpose is federation's session sync: a background push, batched, idle-only,
never faster than 60 s, explicitly contrasted with ADR 0021's live on-demand reads in
federation-plan.md itself. That's the right call for cost, not a mistake - but it needs its own
event (`link.synced {machine, at}` or similar) so a surface can show "synced 40 s ago" instead of
either polling or going silent. See seam 1 below.

## 3. Optimistic actions with Undo, confirms only where reversal is unsafe

DIRECTION.md already specs this for the phone (swipe commits on the frame, outbox, Undo 4 s) and
names the one hard rule: Face ID/Touch ID only to pair, release a secret, or send/post/pay/delete
outside (principle 6, "no nagging"). The gap is that this line hasn't been drawn consistently
outside the phone yet:
- `projects.attach` (cohesion item 19) is correctly confirm-not-optimistic: it moves real files and <!-- terms: ignore -->
  is person-only, no Touch ID, but always previews before one confirm - that's the pattern for "a
  real-world side effect that can't cheaply undo," and it's the right one.
- Vault's actions (item 3, vault's Next list) read as confirm-everything today. Revoking a grant,
  for instance, is cheaply reversible (re-grant) and belongs on the optimistic+Undo side; releasing
  a secret or deleting a `.env` file stays on the confirm+Touch ID side. The rule, not the mechanism,
  is what should travel: reversible and cheap -> optimistic with Undo; irreversible or secret ->
  confirm, and Touch ID only for the latter.

The swipe rule (`needs-row.md`, `layout.md`), exactly: a scroll-snap strip on the compositor, never
pointer-events JS. It commits at a full 100pt reveal, or a 0.5px/ms fling past 24pt; 40-100pt rests
open, under 40pt closes. Right is the row's primary action (Approve, Send - `--primary-bg` fill, a
check), left is the secondary (`--hover` fill). A presence-gated primary shows the Face ID or
fingerprint glyph in the reveal instead of committing blind - the swipe still happens, the biometric
step rides inside it rather than blocking it with a separate dialog. Every commit gets the Undo
toast (`toast.md`): 4 s, one at a time, in-place (takes the row's own 44pt slot) or floating (above
the Capsule or the safe area) when there is no row to hold it. Undo is always ghost styling, never
lime.

## 4. Keyboard first, one motion vocabulary, same gestures on phone and Deck

Already specced and built: DIRECTION.md principles 2-4 (one row/card/status model, quiet chrome),
`system/components/key-hint.md` (the shortcut chip, desktop only, 720px+ with a keyboard and a
fine pointer, never on phone - one chip per chord, modifiers first, no plus sign: "⌘K", never
"⌘"+"K"), `command-bar.md` (⌘K, and the phone's Find). The gesture set (row swipe = scroll-snap,
page swipe = the same trick) is one implementation for both phone and Deck already, per
DIRECTION.md's "gestures on the compositor" section - a team building a new swipeable row
(needs-row, device-row) should reuse that pattern and the swipe rule above, not invent a second
one. Glass's take-over/give-back and Vault's approve/deny are the two places a key-and-swipe pair
isn't confirmed built yet; both should read as "the same A/D, the same swipe" as `needs-row.md`,
not their own shape.

## 5. Voice where natural

Capsule-pro's voice surface (item T2, its polish list) and the phone's voice mention
(`docs/design/phone.md`) are the two built entry points. The rule for "where natural": voice is an
alternative input for the same action a key or a tap already does (dictate instead of type, "do
this" instead of clicking do), never a separate flow with its own confirmations or its own copy.
Windows' Tier D voice port (windows-plan.md) should inherit this rule rather than re-derive it.

## 6. Show the source, everywhere

Memory-iq's source chips (⌘1..⌘3, iq-everywhere.md) and its "Wrong?" correction label (quiet,
inline, no modal, `memory.correct`) are the built pattern for "here's my answer, here's where it
came from, here's how to fix it if it's wrong." The Answer card's confirmed shape (app-design,
not yet written into `result-card.md`): no header row, the answer text first; a plain meta line
("confidence 0.8 - from 2 sessions", never colour-coded, confidence is never a traffic light);
sources as chips (`--rule-strong` border, no fill, mono meta), tap opens the turn; abstain reads
"Not sure yet." plus what memory does know, in the same shell. Correct-in-place: quiet "Wrong?"
text (not a chip) after the meta line, expands in place - two ghost buttons and a prefilled field,
Enter sends - and after a fix, "you corrected this" with an untimed Undo (not the 4 s toast: this
card can sit unnoticed in a scrolled-past result, unlike a swipe commit). The same shape should
cover: sight's "what's on screen" strip (it already names the tool call and thread behind a step,
cohesion item 1); Render's command results (a table or card should always be one click from the
raw call it came from); and federation's session-sync status (name the machine and the time, never
just "synced"). "Show the source" is what stops a fast, cutting-edge surface from also feeling
opaque.

---

## Top 3 upgrades, by team

For each: what, why the user feels it, size (S/M/L), and whether it joins or replaces an item
already on that team's list.

**capsule-pro**
1. Cut over the Capsule's IQ answer to `memory.ask {stream:true}` with source chips, replacing
   Said.swift's own path. Same answer streams the same way in chat, the CLI and the Capsule. S,
   *joins* their existing item 2 (already blocked on memory-iq, just the top pick now).
2. Read `sight.now`/`sight.stepped` for the computer-use status strip instead of polling on its
   own. Watching an agent from the Capsule looks like watching it from Glass - one product, not
   two views of the same thing. S, *new*, sits beside item 6 (their live-check item).
3. Wire `suggest.query` into ⌘K. The Capsule's command bar completes live, the same as chat's
   composer already does. S, *new*.

**vault**
1. Render the `.env` import offer as a built action card (`ask-card`/`plan-card`), not a bespoke
   dialog. It's the one clearly interactive item on vault's list; today risk is it looks like a
   different app mid-flow. S, *joins* their existing item 3.
2. Emit a `vault.connections.changed` event on every grant/revoke so every open surface updates <!-- terms: ignore -->
   without a refresh, matching `waiting.changed`/`context.changed` elsewhere. S-M, *new*, underlies
   cohesion item 3 (connections), which vault owns.
3. Split vault's confirm rule per section 3 above: optimistic+Undo for reversible actions (revoke a
   grant), confirm+Touch ID kept only for secret release and delete. Today it reads as one flat
   "everything needs a dialog." M, *new*.

**glass**
1. Make the latency badge closed-loop (glass-plan.md Section 4 already names this gap: today it only
   reacts to link type at open). Continuous sampling, one event, live badge. S-M, *promotes*
   their own Section 4 item.
2. Native full screen on the phone and a native Mac window in the Capsule (Section 4, already listed,
   L) - this is the literal ask ("feels like my own screen"); reprioritize to top 2, not new scope.
3. Call `sight.frame` for the reconnect still and the resting-tile preview instead of a bespoke
   JPEG path (already agreed with cohesion 2026-09-28). S, *replaces* the implementation under
   their "reconnect without black flash" item, same goal.

**memory-iq**
1. Ship `stream:true` everywhere `memory.ask` is called. Already their own #1-ranked gap; this is <!-- terms: ignore -->
   the single biggest cross-surface interactive win in this whole pass. M, *promotes* their top
   item.
2. Roll the correction UI ("Wrong?", built) out to chat/pwa/mobile once they relaunch, so fixing a
   wrong answer is the same gesture everywhere it appears, not just where it landed first. M,
   *joins* their existing spec, execution only.
3. Ship the Deck/phone Find IQ answer card (spec sent, not built): a live, debounced answer above
   search hits, matching suggest's live-as-you-type elsewhere. S-M, *joins* their existing item.

**teammates**
1. Finish step 3 (the in-process MCP, `@role` routing) once ADR 0030 phase 3 lands, so summoning a
   teammate is a tool call, not a fallback CLI hop with a visibly different shape. M, *promotes*
   their already-planned step 3.
2. Put a teammate's current item and status into the one `waiting.list` (cohesion item 8) instead
   of a separate Agents-place tab; app-design's boards are approved but not consumed yet. S-M,
   *new*, uses already-approved design.
3. Surface notes-changed enforcement and compaction re-injection (step 2's remainder) as a visible
   "why I paused here" line in the transcript, not a silent internal refusal. S, *joins* step 2.

**federation**
1. Give session sync a status line ("synced from Alex's Mac, 40 s ago" / "syncing"), using the
   waiting/context vocabulary, even though the underlying push stays batched and idle-only for
   cost. S, *new* - see seam 1.
2. Make the cross-machine file-drag (the Architecture section, point 1, files router) commit optimistically with
   Undo, per section 3 above, instead of a plain success/fail. S, *joins* their item 1c (already
   blocked on cohesion).
3. Turn the VyreDrive credit line (the Architecture section, point 2, "copy pass only") into a live label sourced
   from cohesion item 19's `via` field on the moved-file event, not a static string. S, *joins*
   their already-scoped item.

**windows**
1. Adopt the interaction language (streaming, Render, sight, DIRECTION's bar) as acceptance
   criteria for Tier A/B from day one, not "the Mac app minus native bits" - nothing in
   windows-plan.md references any of it today. S to state now, large to retrofit later. *New*.
2. Build Tier C's native shell (Tauri) on `system/components/*` directly, not a reimplementation in
   a new toolkit. M, decision now, execution at 0.2. *New*.
3. Call out that `suggest` and `sight` (both built, server-side) already work unmodified once
   `vyred` runs under Tier B (WSL2) - a concrete "Windows already feels alive" milestone well
   before Tier C/D native work. S (it's already true; needs stating and testing). *New*.

**sessions + chat**
1. Ship `thread.status` (sessions emits, chat already listens - HANDOFF's own gap) so chat's nav <!-- terms: ignore -->
   updates live instead of on next open. S, *promotes* an already-half-built wire.
2. Build inline images (cohesion item 18: `sight.frame` stills at a step, and agent-made images) -
   the highest-visibility "cutting edge" item already spec'd for both teams. M, *joins* item 18.
3. Tie the phone push "a session waits on you" to the one `waiting.list` (cohesion item 8) instead
   of its own detection, so "waiting on you" means the same thing on the phone as everywhere else.
   S, *joins* their existing item.

---

## The seams: where two teams' plans would feel like two products

1. **Federation's session sync vs. everyone else's live events.** Federation is explicitly
   batched, idle-only, never faster than 60 s (federation-plan.md's own words), while sight,
   context, waiting and IQ are all event-driven. Left silent, a Mac session on a paired box would
   be the one place in Vyre that goes quiet instead of showing progress. **Fix, decided by the
   lead 2026-09-28:** federation's sync emits a "synced" status event, so nothing goes silent;
   every surface renders it through the same "show the source" line as everything else, section 6.

2. **Vault's confirm-everything vs. the rest of Vyre's optimistic+Undo.** DIRECTION.md's no-nagging
   rule (Touch ID only to pair, release a secret, or send/post/pay/delete outside) already draws
   the line; vault's current Next list reads as if every action sits on the Touch ID side of it.
   **Fix, decided by the lead 2026-09-28:** vault splits its confirms by reversibility - Touch ID
   stays only for pairing, secrets and anything sent outside; everything else is optimistic with
   Undo, per section 3.

3. **Glass's snapshot-at-open badge vs. sight's continuous events.** Every other "what's happening
   now" surface (context, waiting, sight.stepped itself) updates live; Glass's own latency badge
   only reacts once, at open. A Glass session would visibly go stale while everything around it
   updates. **Fix:** Glass subscribes to the same live-status pulse (glass-plan.md's own Section 4 gap,
   already named, just needs an owner and a date).

4. **Windows-plan's silence on the interaction language.** windows-plan.md is a careful, thorough
   tiering document that never mentions streaming, Render, sight, or DIRECTION.md's bar. Built as
   written, a Windows Capsule could ship functionally complete and feel like a different, flatter
   product. **Fix, decided by the lead 2026-09-28:** this page becomes the acceptance criteria for
   Windows Tiers A and B now, before any UI code is written, not a retrofit after.

5. **Memory-iq's streaming vs. capsule-pro's and chat's current blank-then-done answers.** Until
   `stream:true` lands everywhere it's called, a person moving from chat (which streams once IQ
   ships there) to the Capsule (still Said.swift, whole-answer) mid-conversation sees two different
   affordances for what should be one feature. **Fix, decided by the lead 2026-09-28:**
   `memory.ask {stream:true}` becomes the default everywhere in 0.1.1, one shared cutover date;
   memory-iq coordinates it. <!-- terms: ignore -->

---
title: "Onboarding v2: a step per import"
summary: Onboarding leads for 0.1.1. Every import and setup gets its own dedicated, interactive, skippable, resumable step, each ending in a small celebration, with a summary at the end. The step-shell every team's engine plugs into, the eight steps, their owners and sizes.
audience: builders, agents
owner: launch
status: draft
---

# Onboarding v2: a step per import

The user's direction (28 Sep): onboarding leads. Every import and setup gets its own dedicated,
interactive step, not a line item inside a bigger step. launch owns the whole flow, its order,
and each step's "wow"; the owner team named per step builds that step's engine (the data, the
tools, the events). Two of these already have their own design docs, linked below; this file is
the frame they sit inside, and the spec for the steps that do not have one yet.

## The step-shell (launch owns; every step plugs into it)

One shell, reused by all eight steps:

- **Skippable.** Every step has a visible "Skip for now" that never blocks the next step. A
  skipped step can be finished later from Settings or a `vyre` command (existing convention,
  `deck/onboard/onboard.js`'s current steps already do this for Tailscale, Claude and history).
- **Resumable.** Reloading, closing the tab, or a Mac and a phone both mid-onboarding: state
  lives on the box (`core/onboard/index.js`'s existing `onboard.status`), never only in the page.
  A step's own progress (a scan in flight, an import mid-stage) survives a reload too, by asking
  the owning module's own status tool (`import.status`, and the vault-import equivalent once it
  exists), not by the shell inventing its own copy of that state.
- **Progress, live.** Every step that does real work (a scan, an import, a connection) shows
  progress as it happens, not just a spinner: the existing `progressRow(label, state, note,
  since)` checklist-row component (todo/doing/done/failed, a spinner/check glyph, elapsed time)
  is the shape every step's "doing" state renders through, so a person options-checking a
  multi-source step (secrets, step 5) sees each source's own row advance independently.
- **A small celebration per step.** Not a modal, not confetti: a one-line, specific win in the
  step's own voice when it finishes ("Vyre now manages 14 keys", not "Done!"). Silent for a
  skipped step. Off under `prefers-reduced-motion` same as the rest of onboarding.
- **A summary at the end.** After step 8, one screen totalling what happened: sessions imported,
  keys imported, accounts connected, devices paired, what was skipped and where to finish it
  later. Read from each step's own final state, not tracked separately by the shell.

## Terminology

"Server" and "devices" (not "box"/"Mac") is scoped to this flow's own copy for 0.1.1, not a
repo-wide rename: as of this doc there is no other surface using it yet (checked before writing
any of this). Step 2 is where the wording is introduced; every later step that refers back to
"your server" or "this device" stays consistent with it.

## The eight steps

| # | Step | Owner(s) | Size | Status |
|---|---|---|---|---|
| 1 | Name Vyre, and set who you are | launch | S | mostly exists (`core/onboard`'s `you` step), terminology pass |
| 2 | Pair this device with the server | launch, tailnet | S | mostly exists (`name`/`tailscale` steps), terminology pass |
| 3 | Sign in to Claude, through the vault | launch, sessions, vault | S | mostly exists (`claude` step), wire to vault |
| 4 | Import your sessions: discover, choose, watch Vyre IQ learn | memory-iq (leads), federation | M | spec'd: `docs/design/import.md` (work/memory-iq) |
| 5 | Import your secrets, from several sources | vault (leads) | L | spec needed from vault; biggest of the eight |
| 6 | Connect accounts: Google and email, MCP servers | vault, connectors | M | spec needed |
| 7 | Your phone: pair it, swipe-to-approve | mobile | S | later, per the lead; stub/skippable for 0.1.1 |
| 8 | A tour of the Capsule: press &#8997;Space | capsule-pro | S | can reuse the landing page's Capsule demo pattern (`site/index.html`'s hero demo) as a starting shape |

### Step 4: Import your sessions

Full spec: `docs/design/import.md` on `work/memory-iq` (8702ab66). Three screens inside the step,
exactly as memory-iq specced them: **Discover** (`import.scan`, sources with counts/date
range/size/projects, dev and Vyre folders unticked with the reason, nothing leaves the device),
**Choose** (`import.plan {include, exclude}`, "N sessions, X MB, these folders, to \<server\>",
"Import these now" or "Keep them in sync", neither preselected, confirms with `import.start
{plan, mode}`), **Watch it fill** (`import.status` for the resume case, `import.progress` events
per stage; first searchable sessions show at once with a way to ask IQ right there). This step
replaces today's "Your history" step rather than extending it.

### Step 5: Import your secrets

Lead's spec (28 Sep): discover keys on the device, recognise their providers, show them masked
and grouped by project, one Touch ID for the batch, animate each key into the vault with its
connection created, end on "Vyre now manages N keys". Each source is its own card inside the
step: `.env` files, shell exports (`~/.zshrc` and the like), password managers (1Password,
Bitwarden, Apple Passwords), Chrome passwords, SSH keys, and the MCP and Claude settings env.
Asked vault for the discover/import tool shapes per source (mirroring memory-iq's
scan/plan/start/progress pattern) before designing the masked list and the animate-in; nothing
built against a guess yet.

### Step 6: Connect accounts

Google and email, MCP servers, through vault and connectors. Spec needed; likely close to
existing connectors flows, reframed as its own step with the shell's progress/celebration.

### Step 7: Your phone

Lead: "later". A stub for 0.1.1: shown, explained, skippable, no engine yet, so the step order
and the summary screen are correct once mobile's swipe-to-approve pairing lands.

### Step 8: A tour of the Capsule

Press &#8997;Space (the corrected default hotkey, `docs/work/launch-surfaces.md`). The landing
page's hero Capsule demo (`site/index.html`, `site/app.js`'s `.keys`/demo wiring) is sample-data
only and public-facing, but its shape, tabs (Typing/Recall/Held/Waiting) and the &#8997;Space
open/close handling are a reasonable starting point for capsule-pro's real, signed-in tour.

## Open items (tracked in `docs/work/launch-surfaces.md` "Needs from others")

- vault: tool shapes for step 5 and step 6.
- connectors: confirm step 6's scope (which of today's connector flows this step wraps).
- app-design: a board for step 5's masked/grouped list, the Touch ID moment, and the per-key
  animate-in; and for the step-shell's progress/celebration look, shared by every step.
- mobile: confirm step 7 is fine as a stub for 0.1.1.

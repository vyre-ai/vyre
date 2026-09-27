---
title: "Onboarding v2: a step per import"
summary: Onboarding leads for 0.1.1. Every import and setup gets its own dedicated, interactive, skippable, resumable step, each ending in a small celebration, with a summary at the end. The step-shell every team's engine plugs into, the nine steps, their owners and sizes, and how one onboarding serves every device.
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

One shell, reused by all nine steps:

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
- **A summary at the end.** After step 9, one screen totalling what happened: sessions imported,
  keys imported, accounts connected, drives synced, devices paired, what was skipped and where
  to finish it later. Read from each step's own final state, not tracked separately by the shell.

## Terminology

ADR 0038 (docs, status: draft as of this writing): "server" and "device" apply everywhere
user-facing, not only onboarding, no alias window on marketing surfaces. "Box" survives only as
the literal `vyre box <sub>` CLI form during 0.1.1's alias window (vyre server &lt;sub&gt; is the
new form, not yet shipped) and as the unrenamed `role: "box"` config value, neither of which this
flow's own copy
quotes except where it is literally showing real CLI output (step 2's pairing instructions, which
quote `vyre up`'s live menu text verbatim and must stay in sync with whatever that command
actually prints, not with this doc's wording).

## One onboarding for every device

The lead's decision (29 Sep), resolving federation's question about the second-device flow: one
onboarding-v2, not a second experience. A new Mac or PC runs the exact same nine steps.

- **Step 2 detects an existing server.** If this device finds one it can pair to, the step
  becomes "Add this device to your Vyre server" instead of the first-server flow. Steps already
  done at the server level (naming, the Claude sign-in) show as done and are skipped for this run.
- **Device-level steps run again for this device**: step 4 (import this device's own sessions),
  step 5 (import this device's own secrets), step 9 (the Capsule tour) all run fresh per device,
  since each device has its own history, its own local secrets and its own Capsule.
- **Add a device from the Deck.** Settings > Devices gets an "Add a device" entry: the one-line
  install command and a pairing code, so a person does not have to leave the Deck to start a
  second device's onboarding.
- **Windows.** Follows the windows teammate's guide (`docs/using/windows.md`, in progress); asked
  them directly rather than guessing at Windows-specific install steps.
- Only the upload wiring (federation's transport, `import.start`) waits on e2e's review; the
  design and the UI for all of this can proceed now.

## The nine steps

| # | Step | Owner(s) | Size | Status |
|---|---|---|---|---|
| 1 | Name Vyre, and set who you are | launch | S | mostly exists (`core/onboard`'s `you` step), terminology pass |
| 2 | Pair this device with the server (detects an existing server; see above) | launch, tailnet, federation | S | mostly exists (`name`/`tailscale` steps), terminology pass, existing-server detection to add |
| 3 | Sign in to Claude, through the vault | launch, sessions, vault | S | mostly exists (`claude` step), wire to vault |
| 4 | Import your sessions: discover, choose, watch Vyre IQ learn | memory-iq (leads), federation | M | built, provisional: `docs/design/import.md` (work/memory-iq); board: `Import.dc.html`/-paper (work/app-design, e7aab867, owed a revision for the real 5-stage shapes) |
| 5 | Import your secrets, from several sources | vault (leads) | L | board ready: `VaultImport.dc.html`/-paper (work/app-design, 19a96abd); tool shapes still needed from vault |
| 6 | Connect accounts: Google and email, MCP servers | vault, connectors | M | board available: `Connections.dc.html`/-paper (work/app-design, db3dbbfa), sent to vault; spec needed |
| 7 | Vyre Drive | federation (leads) | ? | new (lead, 29 Sep); federation drafting the options (see below); design once the lead brings back the user's choices |
| 8 | Your phone: pair it, swipe-to-approve | mobile | S | later, per the lead; stub/skippable for 0.1.1 |
| 9 | A tour of the Capsule: press &#8997;Space | capsule-pro | S | can reuse the landing page's Capsule demo pattern (`site/index.html`'s hero demo) as a starting shape |

### Step 4: Import your sessions

Full spec: `docs/design/import.md` on `work/memory-iq` (8702ab66). Built (`deck/onboard/onboard.js`
`history()`, provisional pending memory-iq's real tool shapes): **Discover** (`import.scan`,
sources with counts/date range/size, dev and Vyre folders unticked with the reason, nothing
leaves the device), **Choose** (`import.plan {include}`, "N sessions, X MB, from these folders,
to your server", a "Keep them in sync" checkbox unticked by default, a Fast/Gentle reading-pace
choice with neither preselected, and the note that Claude Code keeps sessions 30 days so import
now, Vyre never changes Claude Code's own settings; confirms with `import.start {plan, mode,
pace}`), **Watch it fill** (`import.status`, polled every 5 s since the loopback's event stream
carries only `onboard.*`, in three plain-language stages: Searchable now, Understood, The graph
growing; a question box wired to `memory.answer` as soon as the first sessions are searchable).
`import.start`'s `pace` field is new, not in memory-iq's original spec; flagged to them. This step
replaces today's "Your history" step rather than extending it, keeping the step's id and CLI
label ("Your history") unchanged so `test/journey.test.js`'s CLI-output assertion still holds.

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

### Step 7: Vyre Drive

New (lead, 29 Sep), added after connecting accounts and before the phone. federation is drafting
the options the user will decide between: what to sync, how (on demand, offline, server only),
where it shows up (the Finder sidebar, a Windows drive, the Capsule, the phone), agent access per
folder, receiving from the server, conflicts, and a "drag a file in and watch it appear on your
phone" delight moment. Not designed yet; waiting on the lead to bring the user's choices back,
then this section gets the same treatment as steps 4 and 5.

### Step 8: Your phone

Lead: "later". A stub for 0.1.1: shown, explained, skippable, no engine yet, so the step order
and the summary screen are correct once mobile's swipe-to-approve pairing lands.

### Step 9: A tour of the Capsule

Press &#8997;Space (the corrected default hotkey, `docs/work/launch-surfaces.md`). The landing
page's hero Capsule demo (`site/index.html`, `site/app.js`'s `.keys`/demo wiring) is sample-data
only and public-facing, but its shape, tabs (Typing/Recall/Held/Waiting) and the &#8997;Space
open/close handling are a reasonable starting point for capsule-pro's real, signed-in tour.

## Open items (tracked in `docs/work/launch-surfaces.md` "Needs from others")

- vault: tool shapes for step 5 and step 6.
- connectors: confirm step 6's scope (which of today's connector flows this step wraps).
- app-design: the step-shell's progress/celebration board (shared by every step); still owed.
- mobile: confirm step 8 is fine as a stub for 0.1.1.
- federation: step 7's drafted options, once the lead brings the user's decisions back; step 2's
  existing-server detection contract.
- windows: confirm `docs/using/windows.md` covers what step 2 needs to point a fresh Windows PC
  at for install, once that guide exists.

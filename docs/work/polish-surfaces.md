# polish-surfaces

Branch: work/polish-surfaces · Worktree: ../vyre-polish-surfaces · Owner session: polish-surfaces

Scope (lead, 2026-09-27): the Deck (desktop web and PWA), Glass in the Deck, and temp-dir hygiene.
Capsule items went to capsule-pro; Taildrop and Tailscale SSH went to tailnet.

## Done
- 4610865 Tests keep temp dirs under SCRATCH. Leaks fixed at the source (local.test.js never
  cleaned, frecency save timer re-made its dir, clipboard helper rebuilt after rm, ssh control dir).
  `VYRE_TMPDIR` for backup staging and thumbnails. tmp-guard also watches bare `vyre-*`, `vy-*`,
  `vssh-*`, `computerd-*`.
- dba1bc7 Phone tab bar gets Chat (5 tabs, fits 320 px). Now titles truncate on phone. Memory's first
  read no longer waits on fonts, and an error has Try again. Glass with no box: a pairing panel, no
  Take over. `--test-type` for the box's Chromium (needs an image rebuild). world.js: SCRATCH home,
  key-file vault, juno and kit, six fictional vault items seeded through a short-lived
  present-verifier vyred.
- 9e9b3de Chat lists real Claude Code sessions (projects.catalog + threads.list, one row per id),
  opens a recorded session from recall.thread and mirrors it live on session.indexed; phone Chat
  has projects, a header with Back, and a left-pointing back arrow.

## Doing
- PAUSED on the user's order (2026-09-27, Mac overloaded). Nothing of mine is running. Resume on the
  lead's go, on the test box, not the Mac.

## Next
- Rerun needed: 9e9b3de (Chat + recall) passed core/recall/module.test.js (5/5) and
  deck/chat/lib/sessions.test.js + core/recall/recall.test.js (31/31) before the merge of main
  (d1c31de). Rerun those, plus deck/test/memory.test.js and the agents/switchboard tests touched by
  the agents.list change, after the merge. The live mirror is unit-tested but not yet seen in a
  browser.
- Reshoot every Deck screen (deck/test/world.js + shoot.js), desktop and 390 px, dark and paper;
  fix what it shows; rebuild the gallery (team/gallery/build.py); tell the lead.
- Onboarding snags from e2e (work/e2e already fixed name check and #name styling in 4a1a4f7):
  1. Step 6 devices at 1280x900: the Mac column overflows (.devices, three 1fr columns plus a
     fixed 184px QR); "Download for Mac" hangs past the border.
  2. Step 6 with no address: the phone QR encodes 127.0.0.1:7300/now. Show "after Tailscale and
     your address" instead of a QR.
  3. Step 5 on a box: "No Claude Code sessions found" and "100% ranked by meaning" with 0 sessions;
     show the status why text ("Your Mac's sessions appear here when you connect your Mac").
  4. Step 1 "Your name" allows a display name (onboard.you, 60 chars) but NAME_RE rejects
     "Alex Rivera": split the display name from the address name, or label it as a short name.
  5. Last screen wording: JOURNEY.md says "Open Vyre", the page says "Open the Deck". Make them match.
- The old Vault layout on phone: check it after the reshoot (main's Vault already lists items).

## Needs from others
- computers: rebuild the computer image so `--test-type` takes effect; confirm the bar is gone live.

## Changed contracts
- recall: listens to `turn.completed` and `thread.started` (harness) and indexes that one session
  about 1.5 s later (`recall.soonMs` in config). New `Indexer.session(folders, id)`. No new tool or event.
- agents: `agents.list` rows also carry `instructions` (additive).
- test/fixtures/vyred-present.js compares real paths (macOS /private/var vs /var).
- deck/test/world.js: home under SCRATCH, file keystore, VYRE_NO_DIALOGS=1 (b983e7d).

## Perf
- No new timers or polls. Chat refreshes on events, debounced 500 ms; recall's per-session index is
  event-driven and stats only the transcript list.

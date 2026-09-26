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
- Full click-through reshoot of every Deck screen, desktop and phone, dark and paper; gallery rebuild.

## Next
- Fix what the reshoot finds (spacing, copy, focus rings).

## Needs from others
- computers: rebuild the computer image so `--test-type` takes effect; confirm the bar is gone live.

## Changed contracts
- recall: listens to `turn.completed` and `thread.started` (harness) and indexes that one session
  about 1.5 s later (`recall.soonMs` in config). New `Indexer.session(folders, id)`. No new tool or event.
- agents: `agents.list` rows also carry `instructions` (additive).
- test/fixtures/vyred-present.js compares real paths (macOS /private/var vs /var).

## Perf
- No new timers or polls. Chat refreshes on events, debounced 500 ms; recall's per-session index is
  event-driven and stats only the transcript list.

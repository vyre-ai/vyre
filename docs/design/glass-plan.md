---
title: Glass plan — true module, native screen, rc.2
summary: Audit of glass-live against 0.1.0-rc.1 (main), a plan for Glass as a clean swappable module, and a concrete "feels like your own screen" plan with cheap wins and tests.
audience: builders
owner: glass
status: draft
---

# Glass plan (28 Sep)

## 1. What's landed — none of it

`git cherry origin/main HEAD` marks all 21 commits on `work/glass-live` as `+` (not on main),
confirmed by content, not just SHA: `origin/main`'s `core/computers/driver/policy.js` and
`docker.js` have no `COMPUTERD_TOKEN_FILE`, no `.boot` seeding, no `URLBlocklist` /
`DownloadDirectory` / http(s)-only fencing. **Both HIGH fixes from the last e2e review
(4b88f1d9) are absent from 0.1.0-rc.1** — secrets still sit in the container's Env, and an
agent's CDP session can still dump cookies, navigate `file://`/`chrome://`, and download
unbounded. Reported to the lead already; this is an RC blocker independent of anything below.

Also not on main: the vault fill contract (`computers.fill.begin/end`, shielding during a fill),
idle hand-back (`computers.handback.*`, the 10 s warning), `computers.restart`/`limits`, the
tailnet egress gate hardening, and the native-Capsule-era copy/event fixes (`a8b9f0e`, `f2b8a1b`,
`ab983cb5`). `core/glass` and `deck/glass` DO exist independently on main (a smaller, older line
of the same module — `watch.js` 393 lines there vs 407 here) — main was never empty, but it's
stale relative to this branch by about three weeks of work, and this branch is stale relative to
main's newer neighbors (sight, Design A, the settings hub).

## 2. What's outdated on this branch

- **sight** (cohesion, landed on main): `sight.frame` gives a still JPEG of an agent's screen for
  the phone, one screen service shared by both Glass's live view and sight's stills. This branch
  still treats Glass's watch/relay path as the only screen source; it should sit behind the same
  service sight now defines so a still and a live stream are two views of one thing, not two
  pipelines.
- **Design A** (picked 27 Sep, `docs/design/one-app/DIRECTION.md`): home is "Needs you", Glass is
  a place you go to, violet is the sole attention colour, one tree/three shapes. This branch's
  copy and layout predate that call — `GlassWatch.dc.html`/`GlassTakeover.dc.html` boards need a
  pass against Design A's placement rules (top bar, card chrome, badge colour) and the Chat-place
  shell.
- **the settings hub** (`refactor(settings)` on main): modules now declare their own settings,
  the kernel checks and stores them. `computers.handback.*` in this branch predates that; it
  should become a glass/computers-declared setting, not its own ad hoc tool pair, to land inside
  the hub instead of beside it.
- **per-session socket / registry**: main's module loader (`core/modules/index.js`) is unchanged
  in shape, but PERSON_ONLY presence enforcement (`computers.takeover`, `glass.take`,
  `glass.release`) landed differently upstream than this branch assumed — reconcile against
  current `core/presence/index.js` before merging, not after.

## 3. "True module"

Glass is already close: `core/glass` talks to `computers` only through its providers
(`providers/computer.js`, `providers/box.js`), declares tools/events/views in `module.json`, and
`deck/glass` is a self-contained view tree with vendored noVNC. The frozen boundary edges that
still leak:

- **computerd `/fs` routes** are computers-image surface, not glass's own — contributed to the
  computers image rather than owned by glass. Fine as a documented contract, but it means glass
  can't ship or version independently of the computers image. Freeze the route shapes in
  `docs/work/computers.md` explicitly as glass's contract, the way vault's fill contract is now
  written down.
- **`computers.shield`/`computers.helper`** are computers tools glass calls; the vault fill
  contract adds a third caller (vault) to the same shield. That's the registry working as
  intended — but glass's `guard.js` (denied-path list) needs to stay equal to `link`'s copy per
  `docs/work/glass.md`'s "Needs from others", which is a manual sync today, not enforced by a
  test. Add a same-file/checksum test so drift fails CI instead of getting found in review.
- **presence** (`PERSON_ONLY`) is enforced in the module loader, not in glass itself — correct
  per the registry model, but `computers.takeover`/`glass.take` declaring their own `presence` at
  all (noted as removed in this branch's "Changed contracts") suggests glass used to duplicate a
  check the registry now owns. Confirm nothing in `deck/glass` still gates on a local presence
  check instead of trusting the tool call to fail closed.
- **event naming**: glass emits both `computer.*` and `glass.*` for the same take-over/hand-back
  (see `watch.js`'s `agentOf`/switch handling both). That's a real seam, not tech debt — computers
  owns the resource, glass owns the UI meaning — but two event families for one user action is
  the kind of thing that should be one internal event translated at the module boundary, not
  duplicated at every listener.

## 4. "Feels like my own screen" — concrete plan

**Already built, verify and extend rather than build from scratch:**
- Fullscreen (`watch.js:89`, `requestFullscreen`/`webkitRequestFullscreen` on the stage element)
  and pinch zoom (`pinchZoom(host, zoomView, ...)`, `Fit` reset button) exist today on Deck. Not
  yet: a native Mac window through the Capsule (Capsule is native-Swift now, no window chrome for
  Glass yet — this is real, new work), and fullscreen has not been verified on the phone
  (`deck/glass/phone.js`) or measured for correctness on resize.
- Quality/compression already adapts by device and link (`watch.js:34`, laptop 6/2, phone 5/4,
  slow link 2/6) — a latency-aware starting point exists; it is not closed-loop (doesn't react to
  measured fps/latency mid-session, only to link type at open).
- `scaleViewport: true`, `resizeSession: false` (watch.js:259-260) — fit-to-window is the current
  default; 1:1 pixel and retina scale are not implemented as an explicit toggle.

**New work, in priority order (reset 28 Sep per cohesion's binding interaction pass,
`docs/design/interaction.md` 5debc1bc — items 1 and 3 below are now top-2, not mid-list):**

1. **Close the latency badge's own loop** (S→M). Shipped 47d90b0c as an open-time snapshot
   (`link.latencyMs` from `glass.open`, read once at connect); every other "what's happening now"
   surface in Vyre updates live, so this is the one that goes stale mid-session. Needs continuous
   sampling and one event, not a bigger UI change — the render side is already there.
2. **Native full screen** (M): browser Fullscreen API is wired on Deck; extend to phone
   (`deck/glass/phone.js`) and verify iOS Safari's fullscreen restrictions (iOS Safari has no
   real element fullscreen in some contexts — may need a CSS "cover the viewport" fallback
   instead of the API). A Mac native window through the Capsule is L: needs a real window (not a
   panel/extension) hosting the same RFB canvas, which is new Capsule-native surface, not a
   Glass-side change alone — coordinate with capsule-pro. This is the user's literal ask ("feels
   like my own screen"); reprioritized to the top per cohesion/the lead.
3. **`sight.frame` for the reconnect still and the resting-tile preview** (S): already agreed with
   cohesion (2026-09-28) — call `sight.frame` right when the socket drops, show that as the frozen
   frame, swap to the live stream once `sight.watch`'s ticket reconnects; same call, small
   `maxWidth`, for the resting tile, refetched on the next `sight.stepped` rather than a timer.
   Replaces the "reconnect without a black flash" item below 1:1 — this is now that item's
   implementation, not a separate one.
4. **Fit and zoom** (S): the `Fit` button and pinch zoom exist; add a `1:1` toggle next to it and
   retina-aware canvas sizing (devicePixelRatio into scaleViewport math) — currently unclear if
   the canvas accounts for DPR, likely blurry on Retina today.
5. **Latency/fps targets + measurement** (S to define, M to instrument): propose p95 input-to-
   paint under 150ms on Tailscale-direct / 300ms over relay, sustained 24fps minimum during
   active use, under 5% dropped frames over a 10s window — matching the smoothness bar Design A
   already set for the rest of the app (`one-app/DIRECTION.md`'s 60fps/1% table is the sibling
   spec for page UI; Glass needs its own row in that same table, not a separate standard).
   Measure via RFB's existing frame timestamps plus a round-trip ping tool — the same sampling
   loop item 1 needs, shared rather than built twice.
6. **Input fidelity** (M): keyboard shortcuts through noVNC's domkeytable/keysymdef are vendored
   and presumably complete; clipboard is called out in `docs/work/glass.md`'s Next as
   "clipboard to the holder only while shielded" — still open. Two-way clipboard, IME support
   (noVNC's input layer is keysym-based, which is lossy for IME composition — needs explicit
   testing with CJK input), and scroll fidelity (trackpad vs wheel) are all unverified.
7. **Cursor** (S): confirm noVNC's cursor decoder is on (local cursor rendering vs remote-only)
   — cheap to check, meaningfully changes perceived latency since a local cursor never waits on
   the round trip.
8. **Audio** (not applicable today — Chrome-in-a-container has no audio pipeline in this design;
   skip unless a future computer type needs it).
9. **Instant take-over handoff** (S, mostly done): shield/unshield and holder events already
   exist; the "instant" feel is mostly about not re-negotiating the RFB session on take-over,
   which the code already avoids (take-over is a permission change, not a reconnect). Verify no
   visible stall today; if there is one, it's likely the passkey/Touch ID round trip, not video.

## 5. Cheap opportunities (S/M) — status 28 Sep

rc.2 was narrowed to 14f1824c only (the HIGH-fix merge); everything below is 0.1.1, built on
work/glass-live behind it.

- **Live latency badge** — done (47d90b0c): `latencyLabel(link)` in `deck/glass/watch.js`, a pure
  function with a unit test (`watch.test.js`), rendered next to the connection badge. It is an
  open-time snapshot today, not the closed loop cohesion asked for (item 1 above) — that part is
  still open.
- **1:1 zoom toggle, DPR-aware canvas sizing, sight.frame reconnect still** — written up but not
  yet coded. Blocker: `deck/glass` has no test harness that mounts `mountScreen` (only pure
  helpers extracted from `watch.js`/`input.js` are unit-tested; nothing exercises the RFB/DOM
  wiring these three touch). Landing them on inspection alone, in the same file that just carried
  the security-review take-over work, was judged too risky without either (a) a live check on
  testbox the way the isolation fixes got one, or (b) a browser-mounting test added first. Flagged
  to the lead 28 Sep; the resolution decides which of (a)/(b) happens before this code ships.

## 6. Tests that improve UX (measurable)

- **Latency budget test**: scripted RFB connect + input round-trip, assert p95 under the target
  in section 4.3, over both Tailscale-direct and relay paths (two runs, two budgets).
- **Frame-drop budget test**: capture N seconds of frame timestamps during a scripted
  mouse-drag, assert dropped-frame percentage under budget.
- **Fullscreen toggle test**: Deck and phone, assert the stage element enters/exits fullscreen
  and the canvas resizes to fill it without layout shift.
- **Resize/fit correctness**: resize the host window through 3-4 sizes, assert `scaleViewport`
  keeps the full remote desktop visible with no clipped edge and no letterboxing beyond the
  expected aspect-ratio bars.
- **Screenshot diff at Deck (1440) and phone (390)** widths, both themes — this branch already
  has the pattern (`docs/design/boards/*.dc.html` mockups); wire it to the live watch view, not
  just the static mockup, so regressions in the real RFB canvas surface, not only in markup.
- **Reconnect test**: kill the socket mid-session, assert the still-frame fallback shows within
  one frame interval and the black-flash duration is 0 (or under one frame).

## 7. Coordinate with cohesion — resolved 28 Sep

- **sight.frame reuse**: agreed. Glass calls `sight.frame {target: "agent:<name>", maxWidth}`
  directly for both the reconnect still (call it the moment the socket drops, show the still,
  swap to the live stream once `sight.watch`'s ticket reconnects — no separate JPEG path or
  polling loop of Glass's own) and the resting-tile preview (small `maxWidth`, refetched on the
  next `sight.stepped` for that target, not a timer). No changes needed on cohesion's side.
  Note the target format is `agent:<name>` (confirmed via `core/sight/sight.test.js`), not
  glass's own `computer:<name>` — the conversion happens at the call site.
- **Inline chat pictures**: item 18 in `docs/design/cohesion.md` (cohesion, sha baf5ec7c), now
  bound by the lead's interaction pass. Split as proposed: chat owns rendering (built once in
  chat-core), sessions passes image blocks through from the Agent SDK's own shape, sight owns the
  one capture path (`sight.frame`/`sight.stepped`) — glass is a second caller of that same path
  (the reconnect tile, and now chat's per-step thumbnail), not a second capture contract. The
  other inline-image source (files the agent made — Canva renders, saved screenshots, not a live
  screen) is explicitly unowned, open for 0.1.1, the lead's call.

## 0.1.1 build list

| Item | Size | Owner | Status (28 Sep) |
|---|---|---|---|
| Merge the two HIGH e2e fixes + fill contract onto main | — | glass (this session) | done, 14f1824c, sent to e2e for rc.2 |
| Live latency badge | S | glass | done, 47d90b0c |
| Close the latency badge's loop (continuous sampling, one event) | S/M | glass | top-2, cohesion's interaction pass |
| Native full screen: phone + Mac window in the Capsule | L | glass + capsule-pro | top-2, the user's literal ask |
| Reconnect still + resting-tile preview via sight.frame | S | glass + cohesion | agreed, needs a test path before coding |
| 1:1 zoom toggle | S | glass | blocked on test harness decision |
| DPR-aware canvas sizing | S | glass | blocked on test harness decision |
| Phone fullscreen + iOS fallback | M | glass | |
| Two-way clipboard while shielded | M | glass + computers | |
| IME-aware input testing/fix | M | glass | |
| fps/latency instrumentation + CI budgets | M | glass + e2e | shares the sampling loop above |
| guard.js/link denied-path sync test | S | glass | |
| Reconcile event families (computer.* vs glass.*) | M | glass | |
| Move handback settings into the settings hub | S | glass | |
| Re-skin Glass boards against Design A | M | glass + app-design | |
| A `deck/glass` browser-mounting test harness | M | glass | new, needed before item above three land |

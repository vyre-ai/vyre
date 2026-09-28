---
title: The native bar
summary: Budgets that say when Vyre chat is as quick as the terminal, and how the harness measures them.
audience: builders
owner: native-core
status: draft
---

# The native bar

Chat has to feel as quick as the Claude Code terminal. These budgets say what "quick" means, and the
harness in `deck/test/native-bar/` measures them. A budget that fails blocks the "native core"
milestone.

## Budgets

| # | What | Budget | How it's measured |
|---|---|---|---|
| 1 | Keystroke to paint in the composer | p95 under 16 ms of work per key, and under 33 ms to the next painted frame; no long task over 50 ms while typing | Chrome trace: `EventDispatch` (keydown/input) to the next `Paint`, 200 keys typed into a 40-row transcript and into a 2,000-row one |
| 2 | First streamed token painted | under 100 ms after the SSE event arrives | `performance.mark` on EventSource message, a MutationObserver on the live row, rAF after it |
| 3 | Box to screen for the first token | under 250 ms from the SDK `stream_event` to paint, on the tailnet | server stamps `t` on `thread.text`; the page subtracts (clocks synced by one round trip) |
| 4 | Steady streaming | characters per frame coefficient of variation under 2; p95 gap between visible updates under 250 ms | Paseo's gate: rAF sampler over the live row's text length, 6 s bursty fake stream |
| 5 | No layout shift while streaming | CLS 0 for rows above the live row; the viewport never jumps when you are scrolled up | `layout-shift` PerformanceObserver; scroll position check while scrolled up 400 px |
| 6 | Scrolling long transcripts | 60 fps (p95 frame under 16.7 ms) flinging through 2,000 rows | trace frames during a scripted wheel fling |
| 7 | Open a session | under 300 ms to the last 20 rows painted from cache; under 1 s from cold | navigation mark to paint |
| 8 | Reconnect | no blank, no duplicate row, no scroll jump; caught up within 1 s of the network coming back | drop the SSE socket mid-turn, restore, diff the DOM rows and scrollTop |
| 9 | Send | the user row paints in under 50 ms and never flickers or re-orders when the server confirms | mark on Enter, MutationObserver |
| 10 | Stop (Esc) | the turn shows stopped in under 100 ms | mark on keydown to state chip change |
| 11 | Main thread while idle | no timers faster than 60 s, 0 % CPU hidden (SPEC principle 8) | `scripts/perf-check` |

## Comparisons

The same script runs three ways and the numbers go side by side in this file:

- **Vyre chat** in Chrome (the harness).
- **Claude Code in a terminal**: keystroke echo and first-token latency measured with a pty harness
  that stamps bytes in and out (`node-pty`, fake Claude binary for determinism, a real one once).
- **Paseo** web app from `reference/paseo`, fed the same bursty fake stream.

## Where it runs

testbox, one headless Chrome, `nice -n 15`, only when `uptime` load is under 8, one run at a time.
The world uses a temp home and the fake Claude binary; no real sessions, no dialogs.

## Results

First run, 2026-09-27, testbox (load 3.5 to 6, so single runs are noisy), headless Chrome, loopback.
native-core is main's chat (bc51d601); vyre-chat is work/chat (fe1cc5eb). Re-run with
`node deck/test/native-bar/run.js --tree <tree> --label <name>` on testbox.

| # | Budget | main chat | work/chat | Terminal |
|---|---|---|---|---|
| 1 | key p95, 40 rows | 18.5 ms | 21.6 ms | 1.2 ms echo |
| 1 | key p95, 2,000 rows | 48.4 ms, long tasks to 69 ms | 36.6 ms | |
| 2 | first token, arrival to paint | 126 ms | 52 ms, pass | 3.3 ms |
| 3 | stream event to paint | 200 ms, pass | 120 ms, pass | |
| 4 | chars per frame CV / p95 gap | 3.89 / 284 ms | 1.1 / 44 ms, pass | |
| 5 | no jump while scrolled up | pass | 426 px jump | |
| 6 | fling p95 frame, 2,000 rows | 50 ms | 33 ms | |
| 7 | open cold / from cache | 1461 / 14 ms | 1043 / 16 ms | |
| 8 | reconnect catch-up, jump | 1584 ms, 41 px | 1563 ms, 738 px | |
| 9 | send to user row | 339 ms | 83 ms | |
| 10 | Esc to stopped | no Stop | 112 ms | |
| 11 | idle timers, CPU | pass, 0.5 % | pass, 0.4 % | |

Re-run, 2026-09-27 evening, testbox (load 3 to 6): native-core 62abf2cf (main 7880dfa6 merged,
chat's windowing in), then work/chat 553017a1 and work/pwa 2d150fdd for budgets 5 and 8.

| # | Budget | native-core 62abf2cf | work/chat 553017a1 | work/pwa 2d150fdd |
|---|---|---|---|---|
| 1 | key to paint p95, 40 / 2,000 rows | 24 / 24 ms, pass, worst work 5 ms | | |
| 2 | first token, arrival to paint | 54 ms, pass | | |
| 3 | stream event to paint | 130 ms, pass | | |
| 4 | chars per frame CV / p95 gap | 1.08 / 34 ms, pass | | |
| 5 | no jump while scrolled up | 3,467 px jump as the reply ends | 0 px, pass | 0 px |
| 6 | fling p95 frame, 2,000 rows | 67 ms (26 rows mounted) | | |
| 7 | open cold / from cache | 2,420 / 13 ms | | |
| 8 | reconnect catch-up, jump | 1,529 ms, 673 px (41 px bar) | 1,514 ms, 112 px (41 px bar) | n/a: the harness saw no reopen |
| 9 | send to user row | 102 ms | | |
| 10 | Esc to stopped | 75 ms, pass | | |
| 11 | idle timers, CPU | pass, 0.5 % | | |

Budget 1 now passes at 2,000 rows with windowing; the composer also stops laying out per key
(field-sizing, or one measure a frame). Event Timing rounds to 8 ms, so 24 ms is the floor it shows.

Budget 8 on pwa's fetch stream, work/pwa 15d02055, testbox at load 1.3 (2026-09-27 evening). The
harness now tees /v1/events/stream fetches and reads deck:stream, since that Deck makes no
EventSource. Sockets cut at the proxy for 2,500 ms: caught up 3,240 ms after the box came back
(the last retry went out 187 ms before it did, the next one 3.2 s later). No duplicate rows or
events and no blank frames, but the reader, scrolled up 300 px, was moved 3,254 px when the
reply finished (the jump chat fixed in 553017a1, not in this tree).

Budget 1's first method counted the wait for the next frame (0 to 16.7 ms), so it read high even on
an idle page; it moves to the Event Timing API (work per key, then time to the painted frame).

Why the rest fail, and who fixes it:
- 5 and 8 (work/chat): the scroll position jumps to the bottom when tool rows arrive while the
  reader is scrolled up; `following` is only updated in the scroll listener and races `grew()` and
  `toBottom()` (session.js), plus the window anchor (window-view.js). Fix: detach only on user
  intent (Paseo's stick-to-bottom). chat.
- 6: windowing still mounts and measures rows every frame at 8,000 px/s. chat.
- 8: the server says `retry: 2000` (core/daemon/index.js:421) and the Deck doesn't reconnect when
  the network returns; the offline bar is prepended and pushes the view 41 px (deck/js/pwa.js:71).
  Fix: reconnect on `online` and on reach, overlay the bar. pwa and resilience.
- 9: the user row is drawn at once only for steer or queue (composer.js:374); a plain send waits for
  the server. Fix: always draw the local row with a client id the server keeps. chat.
- 10: Stop tries `threads.interrupt`, which this tree lacks, then `threads.stop`, with nothing shown
  meanwhile. Fix: show stopping at once; sessions' interrupt. chat and sessions.
- 1 at 2,000 rows: `grow()` resets the textarea height on every key and lays out the timeline.
  chat.

Re-run, 2026-09-28 (post rc.2), testbox at load ~1: native-core-composer 434fc2d5 = main 57dc12c3
merged + chat's c4c657de (ADR 0038 strings) + pwa's b7a2b993 (reconnect backoff, c78b87c0 already
on main). `--only 5,8,9,10`.

| # | Metric | Value | Pass | Notes |
|---|---|---|---|---|
| 5 | CLS above the live row | 0.01 | no (was 3,467 px jump) | one 0.0088 shift while streaming; wheel-up anchor held at 360 px over 419 frames, 0 px scrollTop drift. The user-visible jump chat fixed in 553017a1 is gone; what's left is a near-zero CLS entry, not a jump. |
| 8 | reconnect catch-up | 1,679 ms | no (was 1,529-3,240 ms) | pwa's backoff (250/500/1,000 ms doubling) reopens the stream at 1,646 ms after restore, thread.finished at 1,679 ms, inside a 2.5 s outage recovered via backoff, not `online`. No duplicate rows/events, no blank frames. Anchor moved 106 px (scrollTop 78 px) 1,717 ms after the network came back, far below the old 673-3,254 px jumps, but still a jump, and still over the 1 s budget by ~680 ms. |
| 9 | send to user row | 7.8 ms | no (numeric pass, flagged on reorder) | row paints well under budget, but the row above it changed text once after Enter ("9.0k tokens" -> "you steered here - after 6 ste"), which the harness counts as a re-order/flicker. Looks like a steer-marker label updating on the previous turn's footer, not the user row itself: worth chat confirming intended vs a real flicker. |
| 10 | Esc to stopped | 71.4 ms | yes | first clean pass on this budget. |

Net: budgets 5 and 10 are effectively fixed (5 has a negligible residual CLS entry, not a jump);
8 improved by roughly 2x on both timing and jump size but the backoff schedule alone doesn't clear
1 s inside a 2.5 s outage; reconnecting on the `online`/visibility event in addition to backoff
would close the gap; 9 needs chat to confirm whether the previous-turn footer text change is
intended.

Budget 5's residual 0.0088 traced and fixed, 2026-09-28: a per-frame `getBoundingClientRect`
sampler on every `.cv-row` (temporary, not kept) caught the exact moment, always ~6.9 s into the
burst, in the same JS tick as `thread.finished`: turnRow's (blocks.js) "open" placeholder: an
empty `<div class="cv-turn">`, `display: none` while `:empty`, gets its footer text
("18 s · 4.2k tokens · $0.04") and switches to `display: block`, inserting a 26 px box where
there was none and pushing every row below it (the next headRow, tool cards) down by exactly that
much. No DOM mutation or font-load event lined up with the shift; the CSS collapse/expand did.
Fixed in chat.css: `.cv-turn` keeps `min-height: 26px` (its own padding + one line) at all times,
and `:empty` is `visibility: hidden` instead of `display: none`: the box is always there,
invisible until it has words. Re-run confirms CLS 0 (0 shift entries, was 1 at 0.0088), no
regression on 8/9/10, and deck/chat's 86/86 tests still green. sha: chat.css only, on
native-core-composer (native-core).

Budget 9's harness fixed the same day: chat's read (session-state.js's steer marker inserts a
sibling above the user row when Enter steers a running turn - by design, and never mutates the
turn-foot's own node) pointed at a real harness bug. The old check read
`previousElementSibling.textContent` by position each frame, so any sibling landing there -
steer marker or not - read as "the row above changed". Fixed: track the anchor (the row that was
above the user row the moment it first painted) by node reference, and only count it as a
re-order when that SAME node's own text changes; a new sibling arriving beside it isn't one.
Along the way the harness also tracked the user row itself by reference and flagged it "swapped"
on almost every frame (237 of 241) even though the matched text was always right - the window-view
recycles row DOM nodes on its per-frame remeasure (budget 6's own open finding), so node identity
on the user's own, already-content-matched row churns constantly and means nothing; dropped that
check, kept the content match (already proves the right words are on screen). Re-run: budget 9
passes (14.6 ms, 0 re-orders); 5/8/10 unchanged. sha: deck/test/native-bar/run.js only.

reviewer-2 found a blind spot in that fix, 2026-09-28: window-view recycles DOM nodes (budget 6's
own finding), so if it recycles the ANCHOR itself, not just the user's own row, the in-place-only
check (isConnected && text differs) goes silent - the anchor disconnects, isConnected is false,
so a real re-order (a different node with different words landing in that slot) was never caught.
Fixed: when the anchor is gone, look up whatever now sits at that position (a fresh
previousElementSibling lookup, off the current content-match) and compare ITS text to the
original baseline - same text there is a benign recycle (still excused), different text is a
real, visible re-order. Four scenarios run as controls (temporary CDP-injected DOM changes on
testbox, not kept):

| Scenario | What | Expected | Got |
|---|---|---|---|
| A: benign insert | a new sibling (a steer marker's shape) beside an untouched anchor | pass, 0x | pass, 0x |
| B: in-place mutation | the anchor's own node, same reference, text changed | fail, caught | fail, caught |
| C: replace, different text | the anchor node removed, a different node with different text in its slot | fail, caught | fail, caught (was pass, 0x before this fix - the blind spot) |
| D: replace, same text | the anchor node removed, an equal-text node put back (a benign recycle) | pass, 0x | pass, 0x |

Clean run (no injected scenario) unchanged: 0 reorders. sha: deck/test/native-bar/run.js only
(8c0b36ca).

Budget 8, re-run on pwa's be3f5554 (a fast reachability probe in follow()/down(): while a backoff
wait is pending it polls paths[0] + /v1/health every 150 ms and cancels the wait the moment it
answers, capped at 5 s): catch-up time is now 55-90 ms, down from 1,335-1,679 ms - the 1 s timing
budget is comfortably clear. What's left is the jump: 108-134 px while the reader is scrolled up,
same family as budget 5's now-fixed shift and the still-open chat TODO ("5 and 8: the scroll
position jumps to the bottom when tool rows arrive while the reader is scrolled up; `following`
races `grew()`/`toBottom()` (session.js) and the window anchor (window-view.js). Fix: detach only
on user intent."). Not re-attempted here - it's session.js/window-view.js, chat's.

Re-run 2026-09-28, native-core-composer merged with chat's head (work/chat cfc98f23, includes
017c981f's fling fix and 33b81bd1): `--only 6,7`, testbox load ~1.5-4.

| # | Metric | Value | Budget | Pass |
|---|---|---|---|---|
| 6 | fling p95 frame, 2,000 rows | 16.7 ms | < 16.7 ms | yes (1 dropped frame of 1,351, worst 33 ms) |
| 7 | open cold | 933.9 ms | < 1,000 ms | yes |
| 7 | open from cache | 6.7 ms | < 300 ms | yes |

Both clear on chat's tree - my own tree's 67 ms / 2,420 ms numbers (this file, above) were stale,
measured before chat's fling and cold-open fixes landed. Confirmed, not re-opened.

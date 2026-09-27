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

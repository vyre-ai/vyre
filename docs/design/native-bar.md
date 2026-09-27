# The native bar

Chat has to feel as quick as the Claude Code terminal. These budgets say what "quick" means, and the
harness in `deck/test/native-bar/` measures them. A budget that fails blocks the "native core"
milestone.

## Budgets

| # | What | Budget | How it's measured |
|---|---|---|---|
| 1 | Keystroke to paint in the composer | p95 under 16 ms, no long task over 50 ms while typing | Chrome trace: `EventDispatch` (keydown/input) to the next `Paint`, 200 keys typed into a 40-row transcript and into a 2,000-row one |
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

Not measured yet.

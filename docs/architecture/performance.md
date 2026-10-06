---
title: Performance
summary: Vyre's idle budgets, how scripts/perf-check holds vyred to them, and the numbers measured against them, with dates.
audience: builders, operators
owner: docs
status: stable
---

# Performance

Vyre runs all day on your own machines, so idle must cost almost nothing. The budgets are
principle 8 of the [Specification](spec.md#2-principles) ("Light by default"). A change that
breaks one is a bug, like a failing test. This page lists the budgets, how to check them, and
what was measured.

## The budgets

| What | Budget |
|---|---|
| vyred idle | under 0.5% of one core and under 150 MB resident; no polling faster than once a minute when nothing is happening |
| Lumen hidden | under 0.2% CPU, no GPU use, under 250 MB resident for all its processes |
| Lumen shown and idle | under 2% CPU; wakes in under 100 ms |
| Vyre app web build in a background tab | no timers faster than a minute; the event stream only |
| Heavy work (indexing, embedding, curation) | low priority, yields, pauses on battery and when you are active, never blocks a hook or Lumen |
| Memory that grows with the corpus | bounded and measured |

## Check vyred with scripts/perf-check

```
npm run perf-check          # or: node scripts/perf-check
```

It takes about 65 seconds and exits 0 when every budget holds, 1 when one breaks. CI runs it
after `npm test` (`.github/workflows/test.yml`), and `scripts/release-check.sh` runs it unless you
pass `--skip-perf`.

What it does:

1. Makes a throwaway `VYRE_HOME` (never your real `~/.vyre`) and seeds it with the fixture
   corpus plus a synthetic corpus of about 20,000 turns, so Recall has real work.
2. Starts a real vyred as a child process at lower priority (`os.setPriority`, best effort), with
   a timer hook (`scripts/lib/timer-hook.mjs`) that records every `setInterval` and `setTimeout`
   the process registers, including inside modules.
3. Waits for the startup indexing pass to finish, then samples CPU and resident memory every
   1.5 seconds for 60 seconds of true idle: no requests.
4. Deletes the temp home and stops vyred, pass or fail.

What it gates on:

| Check | Budget |
|---|---|
| CPU, p95 of the samples | under 0.5% |
| CPU, sustained: the highest mean over any 5 consecutive samples (7.5 s) | under 1% |
| Heap used after a full GC at the end of the idle window (`scripts/lib/gc-hook.mjs`, on every Node) | under 50 MB |
| RSS, settled: the highest of the last 8 samples, once they sit within 3 MB (the window runs on to 120 s until they do), on the Node the box ships | under 150 MB |
| RSS, startup peak: the highest in the first 30 s from spawn, indexing included, on the Node the box ships | under 200 MB |
| Fastest recurring timer (a `setInterval`, or a `setTimeout` seen 3 or more times) | 60 s or slower |

Mean and max CPU, mean and max RSS, and RSS after the GC are printed but do not gate. After the
startup indexing pass V8 keeps its heap (about 160 MB on the synthetic corpus) for some 20 s before
it gives it back and settles near 90 MB, so the idle budget reads the settled size and the startup
peak has its own budget. That holds on Node 22, the Node in `box/Dockerfile`. Node 24 does not give
the heap back while idle: the same commit settles at 186 to 260 MB with 74 to 111 MB of heap in
use that a GC would free, and only about 20 MB live. So the RSS budgets gate on the Node major the
box image ships and print as informational on any other, and the heap after a forced GC gates
everywhere, so a real leak still fails on every Node. The output also prints the host's load average,
so you can tell contention from a regression.

> [!WHY] Why p95 and a sustained window, not the maximum?
> One noisy `ps` sample on a busy machine should not fail the run. An earlier version gated on
> the maximum and failed on a single sample out of 40 while the mean was under 0.25%. The
> sustained check still catches a loop that costs 1 to 2% the whole minute, which p95 alone
> could miss.

The check turns off `recall.vectors` in its temp config. The embedding model downloads weights
on first use and then works in the background for minutes on a large backlog, which does not fit
a one-minute idle check and needs the network. Embedding cost is not covered by perf-check.

## Measured

All numbers are from the first audit, 26 Sep 2026, on a shared macOS development machine.

### vyred idle (perf-check)

On a host with load average 23.6 to 26.2 (other test suites running):

| Metric | Result | Budget |
|---|---|---|
| CPU p95 | 0.00% | under 0.5% |
| CPU sustained | 0.13% | under 1% |
| RSS mean | 55.6 MB | under 150 MB |
| RSS max | 100.8 MB | under 150 MB |
| Fastest recurring timer | none under 60 s | 60 s or slower |

An earlier run gated on raw max CPU and failed on a single sample out of 40 (0.7 to 2.7%, and
8.58% at load average 22 to 26) while the mean was 0.08 to 0.23%. That was host contention.

### What the audit changed

| Where | Found | Now |
|---|---|---|
| `core/watchers/index.js` | the scheduler ticked every 15 s | `TICK_MS` is 60 s |
| `core/recall/dense.js` | the vector index had no cap: 1,553 bytes a chunk, about 57 to 59 MB at 37,000 to 40,000 chunks | `maxChunks`, default 50,000 (about 78 MB), evicting the oldest sessions first |
| `core/recall/index.js` | a transcript scan every 5 minutes | kept: a stat-only pass over 600 sessions costs 8 to 70 ms |
| `core/memory/index.js` | suspected re-derive on every event | already debounced (`SETTLE_MS` 250 ms) and coalesced; about 2 s per 100,000 turns |
| `core/computers/index.js` | a sweep every 5 s whether or not a computer was in use | sweeps every `sweepMs` (5 s) only while something is checked out or waiting to freeze, else every `idleSweepMs` (60 s) |

The switchboard, gate, vault, learn and system modules and the Harness are driven by events
and hooks. The event stream's 15-second heartbeat runs only while a client is connected.
Since the audit, Recall also indexes one session about 1.5 s after a turn ends
(`turn.completed` or `thread.started`), so Chat can follow a terminal session. That work is
driven by events and does nothing while no session is running. The numbers above predate
it.

### Lumen

These numbers are for the Electron Lumen, since retired. The native Lumen
(`local/capsule/native`) is measured in CI by `scripts/capsule-native-check.mjs`, against
budgets of under 60 MB resident and under 0.1% CPU while hidden, and a wake under 50 ms.

| Measure | Result | Budget |
|---|---|---|
| Hidden RSS, all processes | 212 to 233 MB (238 MB with the hotkey helper) | under 250 MB |
| Hidden CPU, main process, vyred up | 0.061% | under 0.2% |
| Hidden CPU, main process, vyred down | 0.210% overall, settling near 0.18% after about 90 s | under 0.2% |
| Warm wake, `show()` to painted frame | mean 38.0 ms (34.5 to 39.6 ms, 5 samples) | under 100 ms |
| Warm open, end to end | 18 to 50 ms | under 100 ms |

Before the fixes, hidden RSS was 301 to 324 MB (the network service and GPU now run in the main
process, with no spare renderer), and hidden CPU with vyred down was 0.791% (a health check every
3 s and a stream reconnect every 1.5 s, now backed off to 60 s and 30 s while hidden). The
clipboard watcher (a Swift helper, polling the pasteboard every 750 ms) measured 0.016%.

Wake timing leaves out the hotkey's own double-tap window (about 450 ms, by design) and the
first show after launch (about 721 ms).

### The app and Glass

- `apps/app/screens/glass/state.ts` lets go of the screen when the tab is hidden, keeping the last
  frame, and asks for a fresh ticket when the tab is visible again.
- `core/glass/` has no timers. `core/computers/glass.js` sends a 30-second keepalive per open
  viewer, which exists only while someone is watching.
- `apps/app/screens/onboarding/SetupScreen.tsx` polls every 3 s while you wait on a step. That is a
  foreground wizard you are looking at, so it is outside the background-tab budget.

## Not measured yet

- Embedding and curation CPU, and pausing on battery.
- A quiet, dedicated CI runner baseline for perf-check.
- Lumen's hidden CPU budget covers all its processes together; the numbers above are per
  process.

## Where to go next

- [Specification](spec.md): principle 8 and the rest of the rules.
- [Testing](../contributing/testing.md): the test suite perf-check runs beside.

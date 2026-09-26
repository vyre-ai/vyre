# Performance audit — 2026-09-26

Budgets are set in `docs/SPEC.md` section 2, principle 8 ("Light by default"). This is the
first pass against them, done from `work/perf`. Numbers below are from this dev machine
(macOS, shared with other concurrent agent sessions — treat single-sample CPU spikes with
that in mind).

## `scripts/perf-check`

New script. Spins up `vyred` against a temp `VYRE_HOME` seeded with `test/fixtures/corpus.js`
plus a synthetic ~20k-turn fictional corpus, waits for startup indexing to finish, then
samples CPU/RSS for 60s idle and checks for any recurring timer under 60s. Wired into
`.github/workflows/test.yml` after `npm test`. `npm run perf-check` runs it locally.

Latest run on this machine:

| Metric | Result | Budget | Status |
|---|---|---|---|
| CPU (mean) | 0.08% | < 0.5% | pass |
| CPU (max, single sample) | 0.7-2.7% | < 0.5% | fail (see note) |
| RSS (mean) | 44-50 MB | < 150 MB | pass |
| RSS (max) | 49.5 MB (one outlier 112 MB) | < 150 MB | pass |
| Fastest recurring timer | none under 60s | >= 60s | pass |

The CPU-max failure is a single 1.5s `ps` sample out of 40, on a machine running several
other agent sessions concurrently — 39/40 samples read 0.00%. Needs a re-run on a quiet or
dedicated CI runner before trusting it as a hard gate; the script currently reports the raw
max rather than a smoothed statistic. Flagged to `release`, budget itself was not relaxed.

Confirmed with the host load: `perf-check` now prints `os.loadavg()` next to every result, and
runs the daemon under `os.setPriority(child.pid, 10)` (best-effort, non-fatal if unsupported)
so it doesn't compete with whatever else is on the box. Re-run at load average ~22-26 (several
other teammates' test suites running concurrently): CPU mean 0.23% (pass), CPU max 8.58%
(fail) — same shape as before, worse in magnitude at higher load, mean unaffected. This is
host contention, not a regression; re-check on a quiet machine before trusting the max budget.

`recall.vectors` is disabled in the perf-check's own daemon config — the embedder downloads
weights over the network and costs real background CPU that doesn't fit a 60-90s check.
Embedding-pipeline CPU/battery behavior needs a separate check later.

## Module audit

| Module | Found | Fix | Status |
|---|---|---|---|
| `core/watchers/index.js` | `TICK_MS` = 15s, tighter than the "no polling faster than once a minute idle" budget | bumped to 60s | fixed, 16/16 tests pass |
| `core/recall/dense.js` | dense vector index had no cap: 1,553 bytes/chunk, ~57-59 MB at ~37-40k chunks, unbounded growth | added `maxChunks` (default 50k, ~78 MB), recency-first eviction by session | fixed, 31/31 tests pass |
| `core/recall/index.js` | 5-minute scan interval for transcript indexing — the known concern | measured: stat-only pass over 600 sessions costs ~8-70ms, five orders of magnitude under the 5-minute period. Left as-is; fs.watch would add cross-platform unreliability and still need a poll fallback for a cost that's already negligible | no change, flagged to `followups` as "don't bother" with the numbers to back it |
| `core/memory/index.js` | suspected uncoalesced derive-on-every-event | already debounces (`SETTLE_MS`=250) with trailing-request coalescing; `derive()` only runs on real new data, yields per batch (~2s/100k turns) | no change needed |
| `core/switchboard`, `core/gate`, `core/vault`, `core/learn`, `core/system`, `harness/` | fully event/hook-driven; SSE heartbeat is 15s (only while a client is connected, standard keepalive); switchboard's text-flush/prune timers only run during an active stream | no changes | fine as-is |
| `modules/chat` (Mattermost poller) | `poll_ms` defaults to 2000ms (floor 250ms), hits the network every tick regardless of activity, per project channel, forever — 30x tighter than the idle budget | not fixed here — switching off polling to a websocket/webhook is a real design change. Flagged to `gate-chat` with exact numbers (own test suite already runs Chat at 60s, suggesting the shipped default was just never raised to match) | flagged |
| Capsule (Electron + Swift) | backgroundThrottling default (on), no GPU/animation while hidden, single renderer, uses SSE (not polling) against vyred, Swift hotkey uses a `CGEvent` tap (not a poll loop) — all compliant. Hidden RSS measured ~300-305 MB across main+gpu+network-util+renderer+hotkey processes, over the 250 MB budget by ~20%. CPU compliant (0.0-0.4% hidden, 0.0-0.3% shown-idle) | none applied — RSS reduction needs a Capsule-owned change (e.g. deferring window creation to first show, checking whether the GPU helper is avoidable while hidden) | flagged to `capsule` |

## Open follow-ups (sent to owning teammates)

- **followups** (recall/learning): recall's scan interval is fine as measured, no action needed;
  dense-index quantization (float32→int8, 1553B→~404B/chunk, a 4x cap-vs-memory win) is available
  whenever the eval harness on `work/recall` confirms retrieval quality holds.
- **switchboard**: no findings — audited, event-driven, nothing to fix.
- **gate-chat**: chat poller numbers above; recommend raising the shipped default toward 30-60s
  and/or making it adaptive rather than a flat 2s.
- **capsule**: hidden-state RSS ~300MB vs. 250MB budget, breakdown above; also no first-paint
  instrumentation exists yet to verify the <100ms wake budget.
- **deck**, **computers**: not yet audited in this pass.
- **release**: `scripts/perf-check` exists, `npm run perf-check`, ~65s runtime, exit 0/1 — ready
  to wire into `scripts/release-check.sh`; CPU-max flakiness noted above.

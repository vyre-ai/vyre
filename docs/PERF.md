---
title: Performance
redirect: architecture/performance.md
---

This page moved to [architecture/performance.md](architecture/performance.md).

## Heap detail (measuring, not gating)

`VYRE_PERF_HEAP_DETAIL=1 node scripts/perf-check` (the perf-idle workflow, input `detail`) prints, after the usual table, the heap each module kept after its own start (a forced GC before and after, `core/modules/perf-heap.js`) and a summary of the settled heap by kind and by constructor. `VYRE_PERF_DISABLE=computers` starts vyred with the named modules off, so one run with and one without shows what a module weighs. Nothing here changes the gate.

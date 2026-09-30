---
title: vitals (design)
summary: A first-party module showing how the server and every paired device are doing, without nagging or a new timer while nobody watches.
audience: builders
owner: tailnet
status: draft
---

# vitals (design)

Written 28 Sep 2026, for the lead before any code. New idea from the user, 0.1.1.

## Shape

One module, `vitals`, roles `["box", "local"]` (the same two link.js already runs under: it
collects on the server and on every paired Mac or Windows device, each into its own `vyre.db`).
There is no central collector reaching out to devices: each device samples itself, keeps its own
rollups, and answers when asked: matching link's "the box asks a paired Mac" shape
(`link.macs.call`) rather than inventing a push path.

```
does.tools:   vitals.status, vitals.summary, vitals.explain, vitals.advice, vitals.watch
watches.emits: vitals.sample, vitals.trouble
needs:        {}   (no vault items, no new grant)
```

No direct imports of computers' Docker driver or link's health code: vitals reaches both through
`ctx.call` (`computers.stats`, a small addition to the computers module below, and the existing
`link.health`), same as network.js reaches names.js only through its module boundary.

## What it collects, and how, without root

| Metric | Server (Linux) | Mac (Capsule) | Windows |
|---|---|---|---|
| CPU | `/proc/stat` deltas | `host_processor_info` (already how Capsule reads CPU today, reused) | `Get-Counter '\Processor(_Total)\% Processor Time'` |
| RAM | `/proc/meminfo` | `host_statistics64` | `Get-Counter '\Memory\Available MBytes'` + total from WMI |
| Disk | `statvfs` on `/work`, `/` | `statfs` on the home volume | `Get-PSDrive` |
| Network | `/sys/class/net/<if>/statistics` deltas | `netstat -ib` deltas, or reuse `link.health`'s peer for path/latency | `Get-Counter '\Network Interface(*)\Bytes Total/sec'` |
| Battery | none (report `null`, "no battery") | `IOKit` (`pmset -g batt` is a simpler first cut) | `Get-CimInstance Win32_Battery` |
| GPU | `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` if the binary exists, else `null, why: "no GPU"` | `ioreg -r -d 1 -c IOAccelerator` (no root) | `Get-Counter '\GPU Engine(*)\Utilization Percentage'` (no admin) |

Every read here is something the OS already answers to an unprivileged process. Nothing here asks
for a permission prompt (ADR 0014's "no nagging" rule is not tailnet-specific; it applies to any
new prompt vitals could otherwise add, so this must not add one).

**On the server, also a breakdown per agent's computer** (docker stats) **and per session**
(cgroups inside a computer, once glass-live's image change lands: see "Depends on" below).
`computers.stats { id }` is a new tool on the computers module (not vitals: it owns the Docker
driver), calling `DockerDriver`'s existing `request()` against `GET /containers/{id}/stats?stream=false`
and returning `{ cpu, ram, ramLimit, netRx, netTx }` for one container. vitals calls it once per
running computer each tick and tags the sample `scope: "agent:<name>"`. **Per shared-browser
context** is harder: docker stats is container-wide, so telling one Chrome context from another
inside the same computer needs computerd's own cooperation (a `GET /vitals` on computerd's
existing authenticated port, reading `/proc/<pid>` for the tagged renderer processes hands-chrome
already knows about). That is a real addition to computerd, owned by computers/glass, not
something vitals can get by reading `/proc` from outside the container. Proposing it as phase 2:
ship per-computer breakdown in 0.1.1, per-context once computerd exposes it.

## Cadence and cost

- **Idle** (nobody watching): one sample a minute, only to feed the rollup. No new setTimeout
  runs at startup; the first sample, and the once-a-minute timer, start only after the module's
  first `vitals.watch` or a rollup tick is due, the same "nothing runs until asked" shape as
  `link.health`.
- **Watched**: `vitals.watch { action: "open" }` marks one watcher; while count > 0, sampling
  runs at ~2 s, same rate Glass already paces a live viewer at. `vitals.watch { action: "close" }`
  (or the caller's stream closing) drops the count; at zero, cadence falls back to 1/min.
  Concurrent watchers share the same 2 s loop, never one per viewer.
- **Rollup and pruning**, once an hour boundary passes during whichever tick is running (the 1/min
  timer already ticks past it; no second timer): fold the last hour's minute rows into one hour
  row, then delete minute rows older than 24 h and hour rows older than 30 days.

```sql
CREATE TABLE vitals_minute (
  minute TEXT NOT NULL,             -- UTC "YYYY-MM-DDTHH:MM"
  device TEXT NOT NULL,             -- 'server', or a paired device's stable id
  scope  TEXT NOT NULL DEFAULT '',  -- '', 'agent:<name>', 'browser:<contextId>' (phase 2), 'session:<id>'
  cpu REAL, cpuMax REAL, ram REAL, ramMax REAL, gpu REAL, disk REAL,
  netRx REAL, netTx REAL, battery REAL,
  PRIMARY KEY (minute, device, scope)
);
CREATE TABLE vitals_hour ( -- same shape, hour TEXT "YYYY-MM-DDTHH", 30-day retention
  hour TEXT NOT NULL, device TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  cpu REAL, cpuMax REAL, ram REAL, ramMax REAL, gpu REAL, disk REAL,
  netRx REAL, netTx REAL, battery REAL,
  PRIMARY KEY (hour, device, scope)
);
```

The live 2 s samples themselves are never written to disk: only kept in memory for the open
watcher's sparkline: so a watched session costs one write a minute, same as idle.

## Tools

- `vitals.watch { action: "open"|"close" }`: owner-only (presence not required, a read); opens
  or closes one live subscription. Answers the current sample plus the in-memory 2 s buffer for
  sparklines.
- `vitals.status { device? }`: owner-only, full detail: every device's latest sample, its 24 h
  minute history, and (on the server) the per-computer/per-session breakdown. This is the one
  that could carry a process name or window title one day; for 0.1.1 it does not (see "Access"
  below), but it is the tool to gate if that ever changes.
- `vitals.summary { device? }`: any caller, including an agent about its own computer: aggregate
  numbers only (cpu/ram/gpu percentages, no per-process or per-window detail). An agent asking
  about a computer that is not its own gets the same shape with every field null, not a refusal
  (so an agent cannot use the shape of the error to learn another agent is even running).
- `vitals.explain { device? }`: a compact digest built for IQ, not raw numbers: top consumer by
  CPU/RAM over the last 15 minutes, any open `vitals.trouble` episode, and the trend (rising,
  falling, flat). IQ turns this into "why is the server slow" prose; it never has to read
  `vitals_minute` itself, matching every other module's "IQ calls a tool" contract.
- `vitals.advice`: owner-only, computed on demand (never a scheduled push, per the no-nagging
  rule): scans the last 7 to 30 days of hourly rollups for a pattern like the user's own example
  ("RAM hit 90% four times this week") and returns short strings, plain read, no action taken.

## Events

- `vitals.sample { device, scope, cpu, ram, gpu, disk, netRx, netTx, battery, at }`: every tick,
  fast or slow. This is the feed glass's concurrency cap and the computers pool's queue read from
  (`ctx.events.on("vitals.sample", ...)` on their side, never vitals reaching into their code): a
  pool deciding whether to start one more shared-browser context, or Glass deciding whether to
  queue a take-over, can watch the server's aggregate `cpu`/`ram` scope `""` without vitals
  knowing anything about pools or contexts.
- `vitals.trouble { device, scope, metric, value, minutes }`: only on a sustained breach (a
  metric over its threshold for most of the last 15 samples at the current cadence, whichever
  that is), once per episode, and again only after a recovery sample. vitals never decides how
  loudly to surface this: a watcher rule (`{ "on": "vitals.trouble" }`, the same shape hooks
  already uses for `hook.received`) is how the person chooses to be told, so vitals adds no
  nagging on its own: it only ever emits, at most once per episode.

## Surfaces

- **Deck Devices page**: live tiles with sparklines, one per device, plus the server's
  per-computer breakdown underneath. This needs a board from app-design; vitals hands it
  `vitals.watch`'s shape and nothing else. Not building the page myself.
- **IQ**: answers "why is the server slow" from `vitals.explain`, per memory-iq's existing
  tool-call contract.
- **Quiet alert**: a watcher on `vitals.trouble`, per the standing "no nagging" rule: the person
  sets up how (or whether) they want to hear it, same as any other watcher.
  `vitals.advice` for sizing suggestions, read on demand only.
- **Reusing `link.health`**: a device tile also shows the paired connection's path/latency
  straight from `link.health` (called, not duplicated) beside vitals' own throughput number :
  two different signals (connection quality vs. local resource use) shown together, not merged
  into one metric.

## Access

Person-level only, per the user's ask. `vitals.watch` and `vitals.status` refuse an agent caller
outright (same `owner()` guard pattern network.js and files/drive.js already use). `vitals.summary`
is the one tool an agent may call, and it is built to structurally exclude anything that could
carry a process name or a window title: not filtered after the fact, never fetched for that path
at all. `vitals.explain` and `vitals.advice` are person-level too (IQ answers on the person's
behalf, from the person's own query).

## Depends on / open questions

1. Per-shared-browser-context breakdown needs a `GET /vitals` on computerd, which is glass's or
   computers' code to add, not mine: same coordination shape as the tailnet-side wiring I'm
   already waiting on glass for. Proposing it lands after theirs, not blocking 0.1.1.
2. Windows' equivalent of Capsule's local collector: I've sketched the PowerShell/WMI calls above
   from documentation, unverified on a real Windows box. Coordinating with windows on where the
   collector lives (their device-role code, calling into a shared `vitals` local module the same
   way Capsule will) rather than vitals reimplementing anything Windows-specific twice.
3. Threshold defaults for `vitals.trouble` (what counts as "sustained trouble") and for
   `vitals.advice`'s "hit 90% four times" style rule: proposing config `vitals.thresholds` with
   sane defaults (RAM/CPU 90% for 10 of 15 samples; disk 90% flat, no sustain window since it
   rarely flaps) rather than hard-coding, but want the lead's sign-off on the numbers before I
   ship a default someone has to live with.
4. GPU reads above are from documentation, not run against real hardware yet (no GPU on the test
   box). Will verify against a real Mac and, once one exists, a real Windows device before calling
   this done, per "Verify on first real run" practice from ADR 0014.

## What ships in 0.1.1

The module itself (schema, rollup/prune, all five tools, both events), the server-side collector
(Linux, docker stats via `computers.stats`), the Capsule collector (Mac), `link.health` reuse in
the tile data, and the watcher-driven quiet alert. Windows' collector ships with whatever windows
is already building for the device role. The Devices page itself waits on app-design's board.
Per-shared-browser-context breakdown and phone collection are explicitly out, tracked above.

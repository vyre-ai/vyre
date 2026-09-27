---
title: Agent browsers -- three levels, a reach ladder, one registry call
summary: Replacing one-computer-per-agent with three levels (none, a shared headless browser with per-agent contexts, a small desktop pool), a browse.task reach ladder, and Glass watching any of it live. User-approved direction, 28 Sep.
audience: builders
owner: glass-live
status: draft
---

# Agent browsers

Sent for the lead's review before any build, per direction. Owner: glass, since this replaces and
extends `core/computers` (mine) and adds a new module (`browse`, proposed) that sits in front of
it, `core/hands-chrome` and `core/glass`.

## Why this replaces one-computer-per-agent

Today `computers.checkout` gives an agent a whole desktop -- Xvnc, a window manager, Chrome inside
it -- whether the agent needed a GUI app or just wanted to read a web page. That is the right tool
for a handful of cases and a wasteful one for most: `hands-chrome`'s tools (`chrome.snapshot`,
`chrome.click`, `chrome.type`, `chrome.screenshot`) already drive Chrome through the accessibility
tree, never the screen, so most of what a computer buys an agent -- an X server, a compositor, VNC
-- goes unused. The new model asks the cheapest question first (does this even need a browser?
does it need a full desktop, or just Chrome?) and only pays for more when the cheaper thing
actually fails.

## Three levels

Configured per install (a setting, below), and an agent's `browse.task` reads whichever is on to
know its own ceiling.

### 1. No computer (default)

API and connector work (Gmail, Calendar, a CRM -- whatever's already a module), plus a plain
`fetch` for public pages. No Chrome, no desktop, nothing checked out. This is most of what most
agents do most of the time, and it is what `computers: off` in config already gives you today.

### 2. Shared browser

One headless Chrome (no display, no Xvnc), reached the same way today's per-agent Chrome is --
`computerd`, `--remote-debugging-pipe`, `core/computers/image/computerd/cdpmux.js` fencing the
agent's CDP session (HIGH 1/MEDIUM 4 just landed there apply unchanged). The difference: instead
of one Chrome process per agent's own container, this is one Chrome process, one `docker-api`
computer, and each agent gets its own `Target.createBrowserContext` -- its own cookies, its own
logins, its own downloads, invisible to any other agent's context.

**What changes in `core/computers` / `cdpmux.js`, concretely:**
- The pool gains a `browser` kind of computer alongside today's per-agent `desktop` kind: no Xvnc,
  no window manager, `computerd` starts headless Chrome once and keeps it running (idle-paused,
  below) rather than once per checkout.
- `computerd`/`cdpmux` need a `browserContextId` per agent, not per client-connection: first use
  calls `Target.createBrowserContext {disposeOnDetach: false}` and remembers the id against the
  agent's name (in the same sqlite `computers` keeps its rows in); every later session for that
  agent reuses it. This is new state cdpmux does not have today (today's "a browser session per
  client" is about CDP sessions, not `Target`'s own context concept) -- the main new mechanism
  this level needs.
- Every `Target.createTarget` an agent client sends is forced to that agent's own
  `browserContextId` (refused or rewritten if it names a different one, the same shape as today's
  URL fence); target discovery (`Target.setDiscoverTargets`, auto-attach) is filtered to that
  context too, so one agent's client never learns another context's target ids exist.
- Context profiles persist on disk (one folder per agent under the browser computer's volume) so
  logins survive a Chrome restart, the same way `~/.chromium` already survives a per-agent
  computer's restart today.
- **`hands-chrome` itself should need no change.** It already asks `computers.endpoint` for where
  an agent's Chrome answers and holds one CDP connection per agent; if `computers.endpoint`
  resolves a browser-only agent to the shared computer's cdpmux (same URL and token shape it
  returns today) with that agent's context already the one `Target.createTarget` lands in,
  `chrome.open`/`chrome.snapshot`/`chrome.click`/`chrome.type`/`chrome.screenshot` all keep
  working unmodified. This is the reuse principle made concrete: the shared-browser work is
  computers/cdpmux's problem, not hands-chrome's.
- Vault-injected logins: a site's saved credentials go into the agent's context before it
  navigates there (cookies or a fill, whichever the vault item is), through the same fill
  mechanism the private sign-in flow already uses (`core/computers/fill.js`, ADR 0028) -- never
  typed by the model, never visible to it, matching how a person's private sign-in hides the page
  from the agent today.

### 3. Computer pool

What exists today, narrowed: 1 or 2 full desktops (configurable), borrowed for GUI apps or a
take-over, the agent's own work (files, state) living outside the computer so a wipe-and-return
loses nothing real. `computers.checkout` becomes a borrow with a queue (below) instead of an
implicit "you get your own, always" the pool silently grows to cover.

**Borrow/return, concretely:**
- `computers.checkout` (existing tool, changed behaviour): when every desktop is busy, it waits
  (as it already can -- "Waits up to 30 s when every screen is held", `computers.checkout`'s
  description today) but now against a real priority queue rather than just the existing 30s wait,
  since with 1-2 desktops shared across every agent that ask contention, not a rare case.
  Priority: a person's own take-over request preempts an agent's queued borrow; among agents,
  FIFO unless the lead wants something fancier later.
- On return (`computers.release`, or the ladder's own step budget running out): the desktop's
  agent-owned state -- its Chrome profile, its Downloads, anything under `/home/agent` -- is wiped
  (not just frozen, as today's idle freeze does) and the desktop goes back into the pool paused,
  ready for the next borrow. The agent's own project files were never on the desktop to begin
  with (per the design brief: "the agent's work lives outside the computer") -- this needs
  `hands-desktop`/`chrome`'s actions to write results back through the normal files/threads path,
  not onto the desktop's own disk, which may already be true (worth confirming against
  `hands-desktop.act`'s actual file-write paths before building, not assumed here).

## Glass, for both levels

Glass keeps its promise -- the person can always watch any agent's Chrome, live -- through two
different mechanisms depending on level, both landing in the same `deck/glass` UI:

- **Level 2 (shared browser, headless):** `core/glass/providers/` gains a `browser` provider
  alongside today's `computer` one. Instead of a VNC ticket, it opens `Page.startScreencast` on
  the agent's own tab inside its own context, running only while a person is actually watching
  (the existing "a hidden tab disconnects... visible again, a fresh glass.open" rule in
  `deck/glass/watch.js` already tears down when nobody's looking; this extends the same rule to
  mean "and no screencast runs," not just "no VNC socket"). Take-over: input goes back through the
  same CDP session as `Input.dispatchKeyEvent`/`dispatchMouseEvent` on that tab, not a synthetic
  X server -- there is no X server at this level. `deck/glass/watch.js`'s `mountScreen` would need
  a second code path alongside its noVNC one (a `<canvas>` painted from screencast frames instead
  of an RFB decode) -- real new work, not a small one, and the reason this is L in the build list.
- **Level 3 (desktop pool):** exactly what exists today -- the VNC relay, `core/glass/glass.js`,
  no change.

Screencast works headless (it is Chrome's own frame capture, not a screen grab), which is why
"headless by default" (the lead's addition) does not cost Glass anything at level 2.

## Settings

One setting, "Agent computers": **Off / Browser only / Browser + desktops**, mapping to levels
1/1+2/1+2+3 -- an agent's `browse.task` never climbs past what's on. A second, independent
switch, "Glass viewing": on/off, gating whether the screencast/VNC machinery runs at all (someone
who never watches Glass shouldn't pay screencast's small per-tab cost, or keep a desktop's VNC
warm). Both belong in the settings hub (`docs/adr/0035-settings-hub.md`), each module declaring
its own per that ADR.

**Real numbers, not estimates.** Before the settings copy claims anything ("uses about N MB
idle"), measure it on testbox the way `docs/work/glass-live.md`'s perf-checks already do (CPU p95,
RSS mean/max, idle and active, host load noted) for: headless Chrome idle with zero contexts, one
context idle, one context active (a real page loaded, chrome.snapshot polling), and a desktop
idle/active for comparison. This needs the level-2 code built first; it is a build-phase task, not
something to estimate here.

## Idle-pause and concurrency

- **Shared Chrome idle-pause:** the browser computer, not just an individual context, shuts down
  after N minutes with zero agents using it (config, a sibling to `computers.handbackIdleMin`'s
  existing pattern) -- the whole point of "shared" is that it costs nothing when nobody's
  browsing. Per-context idle already has a cheaper answer: an unused `BrowserContext` with no open
  targets costs Chrome almost nothing on its own, so context-level pausing is not needed
  separately from the whole-process idle-pause.
- **Concurrency cap:** a ceiling on simultaneously-open contexts, sized from free RAM at startup
  (measure a real context's RSS delta first, per the measurement task above, then
  `cap = floor(free_ram * safety_margin / per_context_mb)`, config-overridable). Past the cap, a
  new `browse.task` queues the same way a level-3 borrow does when every desktop is busy.

## The reach ladder

One registry call, **`browse.task`**, any module or agent uses instead of reaching for
`chrome.open`/`computers.checkout` directly. It climbs exactly one rung further only on a rung's
own clear failure signal, never speculatively:

1. **Connector or API** -- Gmail, Calendar, a CRM, whatever module already covers the site.
2. **Plain `fetch` + a reader** -- public pages, no login, no JS needed to see the content.
3. **Headless context, DOM + accessibility-tree snapshots** -- `chrome.snapshot`/`chrome.click`/
   `chrome.type` against a level-2 context; never a screenshot at this rung.
4. **Screenshot + vision** -- only for canvas-drawn UI or a widget the accessibility tree can't
   describe; still level 2, just a different `hands-chrome` tool (`chrome.screenshot`).
5. **A borrowed desktop** -- level 3, for a non-web app or a site that needs a real window
   (native file pickers, some payment widgets).
6. **Hand off to the person** -- CAPTCHA, 2FA, a payment page, anything the Gate would hold
   anyway. `browse.task` stops, notifies (the same "needs you" surface as any other held item),
   and the person takes over in Glass; the trace (below) is what they see to pick up where the
   agent left off.

**Failure signals that climb a rung** (not "this would probably work better," an actual signal):
empty or JS-only content at rung 2, a bot-detection page, a login wall, or an action whose
before/after page state didn't change the way it should have (next section).

## Verify every action

"Clicked" is never enough. After every `chrome.click`/`chrome.type`/equivalent, `browse.task`
checks the page changed the way the step expected -- a new element present, a URL change, a
snapshot diff at the target node -- before calling the step done. A click that produced no visible
change is treated as a failure signal (retry once, then climb or stop), not silently accepted.
This is `browse.task`'s own logic, layered on top of `hands-chrome`'s existing per-action
`chrome.acted {agent, action, summary, ok, why?}` event, not a change to that event's shape.

## Budgets and loop detection

Step and wall-clock caps per `browse.task` call (config, sane defaults TBD once level 2 exists to
measure against), and loop detection: the same action-on-the-same-target repeating with no state
change past N times stops the task and reports rather than continuing to retry. "Stop and report"
means a `browse.task` result the caller (an agent's own reasoning, or a module) sees as a clear
failure with why, not a silent timeout.

## A trace per run

Every `browse.task` run keeps: the action log (`chrome.acted`/`desktop.acted` events already
emitted, just collected under the run's id), a DOM/accessibility snapshot at each step, and a
screenshot at key steps (not every step -- rung 3's whole point is not needing screenshots for the
common case, but a person replaying the run in Glass needs to see it, so key transitions get one).
Replayable in Glass whether or not anyone watched live -- this is close to what `sight.steps`
already gives Glass for a desktop-level agent's computer (`core/sight`'s `sight_steps` table,
`sight.steps` tool); `browse.task`'s trace should very likely reuse that table and event
(`sight.stepped`) rather than inventing a parallel one, since sight already exists exactly to
answer "what did the agent just do" for Glass. Worth a short conversation with cohesion before
building this piece specifically -- flagged, not decided here.

## Credentials

Vault logins are injected into a level-2 context (cookies, or the existing fill mechanism) before
the agent's browsing starts, never typed by the model and never returned in any `chrome.*` result
or `browse.task` trace. This is the same rule the private sign-in flow already enforces for a
person signing in on an agent's screen (ADR 0028) applied to level 2's own logins, not a new rule.

## Site recipes (memory-iq, coordinated 28 Sep)

memory-iq proposed keeping one recipe per site (landmarks, login shape, pitfalls, which rung
worked) so a `browse.task` run starts from what worked last time instead of rediscovering a site
cold every run. Answering their two questions:
- **`browse.finished` fits.** `browse.task` is the one place that knows the site, the rung it
  landed on, the steps it took and whether it worked -- exactly what memory-iq's proposed event
  needs, and it's a natural companion to the trace above (the trace is the detailed record for a
  person; `browse.finished` is the compressed lesson for memory). One thing to tighten before
  building: "steps" in the event should stay landmarks and actions only, as memory-iq specified
  (never typed values, secrets, cookies or query-string URLs) -- worth memory-iq and I agreeing on
  the exact landmark shape (a CSS selector? a role+name pair? both, with a preference order?)
  before either side builds against it.
- **The module name is `browse`.** `browse.task` calls `memory.recipe {site}` <!-- terms: ignore --> before starting a
  level-2 or level-3 run and uses it as a hint (never a decision, per memory-iq's own trust rule),
  and emits `browse.finished` when the run ends. `glass` stays the viewing/take-over surface; it
  never emits this event.

## Reuse, not a second path

Every piece of this reuses what exists rather than building parallel machinery:
- `computerd` and its hardened CDP proxy (`cdpmux.js`, HIGH 1/MEDIUM 4 just landed) run Chrome for
  both level 2 and level 3 -- headless for level 2, inside Xvnc for level 3, same binary, same
  fence.
- The pool (`core/computers/pool.js`) gains a `browser` kind of computer alongside `desktop`,
  not a second pool.
- Vault injection reuses the fill mechanism (ADR 0028), not a new credential path.
- `hands-chrome`'s tools work unchanged at level 2 (see above) -- the DOM/accessibility-tree
  actions an agent takes are identical whether the tab lives in a shared context or a per-agent
  desktop's own Chrome.
- Glass's level-3 path (VNC) is untouched; level 2 is new work but sits beside it in the same
  `deck/glass` UI and `core/glass` module, not a parallel viewer.
- The trace likely reuses `core/sight`'s existing steps table and `sight.stepped` event (flagged
  above, not decided) rather than a second "what did the agent just do" record.

## Open questions for the lead

1. **Priority in the level-3 queue**: FIFO among agents, a person's take-over always preempts --
   good enough for 0.1.1, or does budget/priority need to be per-agent-configurable sooner?
2. **Where `browse.task` lives**: a new `core/browse/` module (this doc assumes so, since it spans
   connectors, hands-chrome, computers and memory, and none of those is the natural owner of the
   ladder itself) -- confirm before I scaffold it.
3. **The trace vs. `sight`**: reuse `sight_steps`/`sight.stepped`, or does `browse.task`'s trace
   need fields sight's schema doesn't have (a DOM snapshot, specifically -- sight's is screen
   pixels, not DOM)? Worth resolving with cohesion before building, not guessing here.
4. **Landmark shape** for both the trace and memory-iq's recipes -- selector, role+name, or both.

## Slice 1, built (28 Sep): Chrome gets its own uid

Ahead of the rest of this doc, and independent of the reach ladder or the shared-browser level:
today's single-agent-per-container Chrome ran as the same uid as computerd, Xvnc and the AT-SPI
bus (vyre, 1001) -- meaning a Chrome exploit landed in a process that could read `/var/lib/vyre`'s
secrets (`.boot`, the VNC password) and vyre's own trusted X cookie by path. Chrome now runs as a
fourth uid, `browser` (1002), with nothing of vyre's reachable to it:
- `core/computers/image/Dockerfile`: `browser` (1002) and a `vyre-bus` group (1003, vyre and
  browser both members). `/var/lib/vyre` moves from 0700 to 0711 (traversable, not listable or
  readable by anyone but vyre) so browser can reach the one subdirectory it owns:
  `/var/lib/vyre/browser` (0750, group agent), pre-made at build time with its final ownership
  already on it -- `chromium/` (0700 browser:browser, the profile) and `downloads/` (2750
  browser:agent, so the real agent can still read what Chrome downloads).
- `entrypoint.sh`: an `as_browser()` helper; browser gets its own untrusted X cookie (never the
  agent's, never vyre's trusted one); vyre chgrp's its own D-Bus session-bus socket directory to
  `vyre-bus` (an owner may hand a file to any group it belongs to, no CAP_CHOWN needed) so browser
  can still reach AT-SPI; a second one-time migration (vyre's old `chromium/` to browser's new
  one, the same shape as the existing agent-to-vyre migration, since vyre cannot chown an
  existing volume's directory to browser without CAP_CHOWN either); computerd's own setpriv call
  keeps CAP_SETUID/CAP_SETGID in its ambient set (everything else it starts still gets none) --
  the one thing it needs beyond running as vyre, to hand Chrome a different uid than its own.
- `computerd/index.js`: `CHROME_UID`/`CHROME_GID` (spawn's own `uid`/`gid` options -- omitted
  entirely, falling back to today's behaviour, when either is unset: a fake-binary test or a
  hand-run computerd never needs this), `CHROME_HOME`/`CHROME_XAUTHORITY` so Chrome's environment
  never carries vyre's HOME or vyre's trusted cookie.
- `cdpmux.js`: the downloads default moves to `/var/lib/vyre/browser/downloads`.
- `core/computers/image/isolation.test.js`: Chrome's uid check now expects 1002, not 1001; a new
  test (`docker exec -u 1002:1002`) confirms browser cannot read `.boot`, the VNC password, or
  vyre's own X cookie, and can reach its own profile.
- Targeted tests (testbox, 502 across two runs): 494 pass, 0 fail, 22 skipped (Mac-only Chrome
  binary, and isolation.test.js's live-container checks, which need a real computer container and
  are not run in this pass -- see Next).

**Not yet true**: "other agents' profiles" from the task brief doesn't apply to slice 1's own
architecture, since today's model is still one whole container per agent (no sharing within a
container to isolate). That guarantee is level 2's own job (per-agent `BrowserContext`s inside one
shared Chrome process, above) and should be checked again once that's built.

**Next**:
1. A throwaway-stack build and run (this repo's own precedent for computers-image work: written
   by inspection first, checked live once a stack exists) -- `docker build`, `isolation.test.js`
   with `VYRE_COMPUTER_CONTAINER` set, specifically: Chrome's uid, the two new isolation checks
   above, and that AT-SPI/`chrome.snapshot` still works (the vyre-bus group access is the one
   mechanism here never exercised by a unit test, only reasoned about).
2. computerd's own residual: its process keeps CAP_SETUID/CAP_SETGID in its ambient set for its
   whole life, not just the moment it spawns Chrome (Node has no built-in way to drop a
   capability from a running process, and re-exec would lose the live Chrome pipe fds). Bounded by
   the container's own capability set (nothing but SETUID/SETGID exists to gain, and DAC_OVERRIDE
   is not among them, so even a compromised computerd cannot bypass file permissions to read
   vyre's own secrets some other uid it might switch to) but worth the reviewer's own read.
3. Send the reviewer and e2e the head sha with what's above; not merged anywhere yet.

## Build list (once the rest of this design is approved)

| Item | Size | Depends on |
|---|---|---|
| `core/browse/` module skeleton, `browse.task` tool (rungs 1-2 only: connector/API, fetch+reader) | M | this doc approved |
| Level 2: `browser` computer kind, per-agent `Target.createBrowserContext`, cdpmux context-scoping | L | pool.js changes |
| `computers.endpoint` resolves a browser-only agent to the shared computer transparently | S | level 2 above |
| Vault injection into a level-2 context | M | ADR 0028's fill mechanism |
| Rung 3-4: `browse.task` calling `chrome.snapshot`/`chrome.click`/`chrome.type`/`chrome.screenshot` with verify-every-action | M | level 2 above |
| Glass `browser` provider: screencast watch + CDP-input take-over in `deck/glass` | L | level 2 above |
| Idle-pause for the shared browser, concurrency cap from free RAM | S | level 2 above, real measurements |
| Rung 5-6: desktop borrow/queue, handoff-to-person | M | existing pool, a real queue |
| Budgets, loop detection, stop-and-report | S | browse.task skeleton |
| Trace per run (pending the sight question above) | M | resolved with cohesion |
| `browse.finished` + `memory.recipe` integration <!-- terms: ignore --> | S | memory-iq's landmark-shape answer |
| The two settings ("Agent computers", "Glass viewing") in the settings hub | S | levels 2/3 built enough to gate |
| Real memory/CPU numbers on testbox, settings copy written from them | S | level 2 built |

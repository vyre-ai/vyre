# glass-live

Branch: work/glass-live · Worktree: ../vyre-glass-live · Owner session: glass-live teammate

## Scope
Make an agent's computer and Glass (watch, take over, Chrome, files) work on the user's real box.

## Done
- Root causes found and fixed, with tests:
  1. Deck "Give <agent> a computer" called `agents.update { agent }`; the tool required `name`.
     Tool takes either; Deck sends `name`. (3ca86bd)
  2. Glass never connected over https://<you>.vyre.run: the names HTTPS listener had no upgrade
     handler, so the WebSocket went to the router and got 404 (confirmed on the live box with a
     bogus ticket, read-only). `ctx.upgrader` + `names` onUpgrade. (16026c7, ba10a10)
  3. The Deck's computer panel read fixture-only fields; `computers.restart` / `computers.limits`
     did not exist. Real panel, real tools. (3ca86bd, 16026c7, 21ed26c)
  4. Lifecycle: a container that exits on boot was marked running (the live "probe" run's
     vncpasswd failure), and the later freeze failed forever. Boot check + freeze-to-stopped.
- Reproduced end to end on a throwaway stack (/srv/vyre-glass, project vyre-glass, label prefix
  run.vyre.glass, own networks): give a computer from the Deck, set limits and restart, Glass
  noVNC stream live, take over (via a throwaway module, presence exempt) with typed input
  reaching the computer, hand back (input dropped, hands resume), Chrome to the Google sign-in
  page, Files tab, idle release, freeze, thaw, vyred restart reconcile, stop and start.
- `test/deck-contract.test.js` guards Deck-to-tool calls.
- Tests (the test box, targeted): 372 run, 365 pass, 0 fail, 7 skipped (computers, computerd, glass,
  names, modules, switchboard, daemon, dockerproxy, hands-chrome, deck glass, deck-contract).
- perf-check (the test box, host load 6.9): CPU p95 0.00%, RSS mean 116.4 MB, max 149.7 MB, no timer
  under 60 s. The only new wait is the boot check (250 ms steps, only while a computer starts).
- Throwaway stack torn down (containers, volumes, networks); /srv/vyre-glass keeps compose.yml.
- c006e55 merged to main (d3ed622); docs told (27 Sep).
- No passkey for the owner's take-over, hand-back or Sign in privately (user rule, 27 Sep).
  `PERSON_ONLY` in presence; agents, tailnet guests and Claude's sessions still refused.
  Tests (testbox, targeted, 14 files): 186 run, 180 pass, 0 fail, 6 skipped.
- Merged main with e2e's 61692fd (agents.update person-only, no presence): Deck "Give a
  computer" asks for no passkey; Settings' passkey note no longer names Glass take-over.
  Tests after merge (15 files): 187 run, 181 pass, 0 fail, 6 skipped.

## Doing
- Idle hand-back (lead's go, 27 Sep): built and tested (below). Pushed work/glass-live; app-design told.
- Nothing in flight. Waiting for the next live-box deploy (the lead says when).
- 27 Sep: docs told 71503ab is on main (apply the no-passkey glass.md/presence.md text).
  app-design sent notes on the one-app Agents board: drop Face ID on private sign-in, "Fill a
  login" only in Sign in privately, no 5 min idle hand-back exists (offer to build it), no 4-viewer
  cap (the cap is 2 screens), plus missing take-over/hand-back states.

## Next
1. After the live box is redeployed, two read-only checks only (no agents or computers made):
   `ssh <test-box> docker exec vyre-vyre-1 vyre call computers.limits '{}'` must not say
   no_such_tool, and a WS upgrade with a bogus ticket to
   https://<owner>.vyre.run/v1/streams/computers/glass?ticket=bogus must not be 404 (expect 403
   or a 101 then close). Send docs any label changes.

- Idle hand-back: keyboard.js input-idle timer (renew(agent, surface, input)), config
  computers.handbackIdleMin (0/2/5/15, default 5), tools computers.handback.status/set, event
  computer.idle-warning, 10 s countdown chip in the take-over bar, Settings choice. Tests
  (testbox, 10 files): 123 run, 123 pass, 0 fail. perf-check (host load 8.9 at start): CPU p95
  0.00%, RSS mean 112.5 MB, max 156.2 MB (over the 150 budget; this change adds nothing while
  idle, not re-run under lower load yet), no timer under 60 s.

## Needs from others
- docs: `computers.handbackIdleMin` is not explained on any page yet; glass.md needs the idle
  hand-back (off/2/5/15, 10 s warning, the thread line).
- presence/security: tools with a `callers` list (e.g. agents.delete) are refused to the real
  Deck over the tailnet, because `callerKind("tailnet:<login>")` is `tailnet:<login>`, not
  `deck`. Not changed here.
- e2e: a Glass-over-tailnet journey (headscale stack) would cover the listener path in a browser.

## Changed contracts
- `computers.handback.status`, `computers.handback.set {minutes}`; event `computer.idle-warning`;
  `computer.handed-back` why `idle` with `idle_ms`. Keyboard deps `idleMs`, `schedule`.
- Deck Settings (not ours): a "Glass hand-back" row in Network.
- `agents.update`: `name` no longer required in the schema; `name` or `agent` names the agent.
- New tools `computers.restart {agent}`, `computers.limits {agent, cpus, memory_gb}`.
- `computers.get` / `computers.list` rows add `screens`, `cpus`, `memory_gb`.
- Inspection (driver) may carry `exitCode`. Pool config `computers.bootMs` (default 30000).
- Module context: `ctx.upgrader(policy)` returns `(req, socket, head, caller) => void`.
- Migration 4 on computers_computers: `cpus REAL`, `memory_mb INTEGER`.
- presence (core/presence/index.js): `computers.takeover` and `computers.giveback` left
  HUMAN_ONLY; new export `PERSON_ONLY` (those two plus `glass.take`, `glass.release`).
  `computers.takeover`, `computers.giveback` and `glass.take` no longer declare `presence`.
- Deck Settings (deck/views/settings.js, not ours): the passkey note names Gate and vault, not Glass.
- registry (core/modules/index.js): a `tailnet-guest:` caller is refused PERSON_ONLY tools.
- harness rules (core/harness/rules.js): `vyre call <PERSON_ONLY tool>` is denied like the floor's list.

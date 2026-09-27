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
- Nothing in flight. Uid split, freeze and untrusted X are validated; computers.fill waits on vault.

## Done (27 Sep, after the testbox freeze)
- Targeted tests green on testbox: computerd + hands-chrome 44 (38 pass, 6 Mac-only skipped),
  driver + dockerproxy 43/43, fill/shield/keyboard/pool 60/60, computers/glass/deck 50/50,
  shield + docs 55/55.
- Throwaway stack /srv/vyre-glass with image vyre/computer:glass-uid (never :0.1):
  isolation.test.js 6/6 on a live computer (uids, no CDP reach, no environ/ptrace/token, 401s,
  frozen while shielded, untrusted X). hands-chrome over the pipe (open, snapshot, screenshot),
  hands-desktop (screenshot, AT-SPI tree), VNC banner. Fill path at computerd: shield + freeze,
  agent 423, fill token CDP + new context + Input.insertText, then socket cut, token 401, agent
  resumed and sees the tab. Found and fixed: no kill binary (freezer), DevTools policy blocked CDP,
  fluxbox wallpaper dialog, box/Dockerfile checkout build (.dockerignore, 37370a18). Torn down.
- Live box (9efbddc0) read-only checks: computers.limits exists; Glass WS upgrade with a bogus
  ticket is 403, not 404.

## Contract: computers.fill.begin / computers.fill.end (for vault, ADR 0028 decision 3)

Built and tested on work/glass-live (core/computers/fill.js, computerd /shield); the vault's
vault.agent.fill wiring comes after the native core.

computers.fill.begin {agent, origin}
- Internal. Only caller `module:vault` (anything else: `denied`; non-modules see no_such_tool).
- `origin` is for the event and log only. The vault checks the page's origin on its own CDP session.
- Thaws or starts the agent's computer (without taking a screen).
- Raises the shield, reason "fill", then returns. By the time it returns:
  - the agent's hands are refused ("a sign-in is being filled on this computer"), reads included;
  - every agent CDP socket is closed, and new agent sockets get 423;
  - every process of the agent's uid (1000) is SIGSTOPped (no screenshot, no X input, no focus
    grab). Chrome, computerd, Xvnc and fluxbox are uid 1001 and keep running.
- Returns `{ fill, cdpUrl, token, expires }`. Use it like hands-chrome's Cdp:
  GET `${cdpUrl}/json/version` with `Authorization: Bearer <token>`, then the returned
  webSocketDebuggerUrl with `?token=<token>`. The token opens /cdp only, for this fill only.
  It is never in an event, a log line or an error.
- Refusals (`error.code`): `busy` (a person holds the keyboard, a person is signing in privately,
  or another fill is open; the message says which), `no_computer`, `no_driver`, `failed` (for
  example, computerd did not answer: nothing is left shielded).
- Hard limit 60 s (`expires`). Past it computers ends the fill with why "expired": the socket is
  cut, the shield comes down, and the agent continues.

What the vault does in between (validated at computerd on the throwaway stack):
- `Target.createBrowserContext {disposeOnDetach: false}` (or the context dies with the socket),
  `Target.createTarget {url, browserContextId}`, `Target.attachToTarget {targetId, flatten: true}`,
  check the origin, focus fields, `Input.insertText`, submit, wait for navigation (or 20 s),
  clear any password field left in the DOM.
- Only flattened sessions. Refused on any CDP client: Browser.close/crash,
  Target.sendMessageToTarget, exposeDevToolsProtocol, setRemoteLocations, attachToBrowserTarget.

computers.fill.end {agent, fill, target?}
- Only `module:vault`. Drops the fill token (computerd cuts the vault's socket if still open),
  lowers the "fill" shield, and SIGCONTs the agent's processes. Returns `{ agent, ended: true }`;
  a second end, or a wrong fill id, is `{ ended: false }`.
- `target` (the signed-in tab's targetId) goes into the event, so the agent's hands can pick it.

What the agent sees
- During the fill: its tools answer "a sign-in is being filled on this computer"; its own
  processes are stopped; its CDP sockets are closed. It never sees a field value.
- After: its processes continue, its hands reconnect, and the new tab (in the fill's browser
  context, already signed in) appears through auto-attach and Target.getTargets. The vault's
  `vault.agent.fill` result to the agent is `{filled, origin, navigated}` (ADR 0028), plus the
  targetId if vault chooses.

Events (never a value, a username or a token)
- `computer.fill-began {agent, fill, origin}`
- `computer.fill-ended {agent, fill, why: "done"|"expired"|"stopped", target?}`
- `computer.shielded` / `computer.unshielded` carry `reason: "fill"`.

A take-over (computers.takeover, glass.take) during a fill is refused `busy`; a person's shield
and a fill's never replace each other.

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

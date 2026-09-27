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

## Doing
- Nothing in flight. Branch pushed at c006e55 (boot-failure reason in Glass, 4001 close + Retry),
  waiting for the integrator to merge.

## Next
1. When c006e55 is on main, SendMessage docs: they hold the new boot-failure text in
   docs/work/docs.md "Pending page changes" until then.
2. After the live box is redeployed, two read-only checks only (no agents or computers made):
   `ssh <test-box> docker exec vyre-vyre-1 vyre call computers.limits '{}'` must not say
   no_such_tool, and a WS upgrade with a bogus ticket to
   https://<owner>.vyre.run/v1/streams/computers/glass?ticket=bogus must not be 404 (expect 403
   or a 101 then close). Send docs any label changes.
3. New user rule (lead, 27 Sep): no passkey for the owner taking or handing back the keyboard.
   Touch ID/passkey only for pairing, vault secrets, and sending, posting or paying outside. So
   take computers.takeover and computers.giveback out of presence HUMAN_ONLY for the owner
   (core/presence/index.js is presence's file: change it through its contract and list it under
   Changed contracts), keep the agent-caller refusal in ownSurface/surfaceOf, and drop the
   passkey step from deck/glass/takeover.js for the owner. Check Sign in privately follows the
   same rule. Tests, then tell docs (glass.md says both need a passkey).

## Needs from others
- presence/security: tools with a `callers` list (e.g. agents.delete) are refused to the real
  Deck over the tailnet, because `callerKind("tailnet:<login>")` is `tailnet:<login>`, not
  `deck`. Not changed here.
- e2e: a Glass-over-tailnet journey (headscale stack) would cover the listener path in a browser.

## Changed contracts
- `agents.update`: `name` no longer required in the schema; `name` or `agent` names the agent.
- New tools `computers.restart {agent}`, `computers.limits {agent, cpus, memory_gb}`.
- `computers.get` / `computers.list` rows add `screens`, `cpus`, `memory_gb`.
- Inspection (driver) may carry `exitCode`. Pool config `computers.bootMs` (default 30000).
- Module context: `ctx.upgrader(policy)` returns `(req, socket, head, caller) => void`.
- Migration 4 on computers_computers: `cpus REAL`, `memory_mb INTEGER`.

# Homes: create a space, its home unit, the VPS driver

Three pure modules. Everything impure is injected, so every rule is testable with fakes and no cloud call.

- `homes.js`: `createSpace`, `resume`, `submitCode`, `cancel`, `status`, `addServer`, `submitServerCode`, `serverInstall`, `assessThisComputer`, `planMoveHome`, and `createSpaceFlow(deps)` which binds them.
- `home-unit.js`: `homeUnit(space, options)`, `verifyUnit(compose)`, `sharedBetween(a, b)`.
- `vps.js`: a DigitalOcean driver: `createDroplet`, `waitActive`, `destroy`, `estimateMonthly`, `cloudInit`, `redact`.

## Steps

validate, rootkey, claim, owner, home, unit, workspace. State lives in the injected store under `space-create/<spaceId>`, written before and after every step. `resume` re-runs the first step that is not done. Events: `space.create.step` (spaceId, step, state, optional plain reason and code), `space.pairing.state`, `space.create.done`, `space.create.cancelled`, `space.vps.created`, `space.vps.destroyed`. No event carries a key, a code, a token or a secret.

## Pairing

waiting_for_code, matched, home_ready, with timed_out and locked as dead ends (resume starts a new code). Default 5 tries and 10 minutes (`deps.pairingOptions`). The server is not the home until the numbers match, and nothing after the home step runs before then. A VPS prints the prompt on its console and in its message of the day; the person opens the console, types the code, as for any server.

## What the injected parts must do

- `names.claimSpace` is idempotent for the same name and root public key (a repeat after a crash returns ok).
- `homeHost.apply` replaces the unit's files as a whole. The unit's secrets are made once per apply and never stored here, so an apply that half-worked must be cleared by the host before the retry (Postgres keeps the first password).
- `keys.hold` overwrites. The private half goes only there.
- The VPS token is passed per call (`ctx.vpsToken`), never stored. Resume and cancel ask for it again.

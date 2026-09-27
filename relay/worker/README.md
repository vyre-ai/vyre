# relay/worker

The Vyre relay as a Cloudflare Worker with one Durable Object per route id (ADR 0026, section 2).
It speaks exactly the protocol of the Node relay in `relay/node/server.js`, so the box's
`core/relay/link.js` works against either unchanged.

- `index.js`: the Worker (`/health`, request checks, optional per-address limiting) and
  `RouteRelay`, the Durable Object. No dependencies; WebCrypto only.
- `fake-cf.js`: a small fake of the Workers runtime for tests, including simulated hibernation.
- `worker.test.js`: the Node relay's behaviours, each run with a live object and with the object
  rebuilt after every event, plus `link.js` end to end.

## Hibernation

No timers, no alarms, no state in instance fields. Each socket's role lives in its attachment,
frames buffered for a device the box has not picked up yet live in `ctx.storage` (split into parts
under the 128 KiB value limit, at most 64 frames per waiting connection and 8 waiting connections
per route, deleted on delivery), and a text `ping` is answered at the edge. An idle route costs
nothing.

## Tests

```sh
node --test relay/worker/*.test.js
```

The tests also check that the constants repeated in `index.js` equal `core/relay/wire.js`.

## Deploy

Only after the lead approves:

```sh
cd relay/worker
npx wrangler deploy
```

Then set the route `relay.vyre.run/*` and, if wanted, the `DEVICE_LIMITER` rate limiting binding
(both are commented in `wrangler.toml`). `RELAY_LIMITS` (a JSON object) can override the limits,
for tests only.

## Cost

See the Cost section of `docs/adr/0026-relay.md`: an idle box costs nothing, and a heavy user is
well under a dollar a month on Workers Paid.

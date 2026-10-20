# Vyre hooks

Webhooks from the public internet. Some services only report by webhook: a payment processor, a form service, a code host. This module lets one of them reach a watcher on the
server, and does nothing else. The design is ADR 0014, part 10.

A delivery that arrives is checked against the sender's own signature, stored, and announced as the event `hook.received { route, id, bytes, at }`. It never calls a tool, never
reaches the Gate, and reads nothing from the vault except its own route's secret. A watcher listening for that event reads the body.

**The way in from the internet** is the box's public address, served by the Wink public gate: `POST https://<name>.vyre.run:7443/hooks/<route>`. The gate carries exactly that
shape (a POST, no query, a JSON or form body of at most 256 KB with its length declared) to this listener, and nothing else on the box answers on that port: every other path,
method or shape is the same 404 and reaches nothing. The signature is checked here, at the home. The address exists once the box has its name and its public port is reachable from
outside (or `wink.publish` says it is); until then a route is stored and verified, and reachable from the server itself only. `vyre hooks status` says which, and prints the address to
give the sender.

## A Flow's own address

A Flow whose trigger is "A webhook is called", "A form is submitted" or "A person signs up" (a web trigger with `address: true`) needs none of the steps below. When an owner or an admin turns the Flow on,
the hooks module opens one route for it, bound to it by its id: `https://<server address>/hooks/<flow-name>-<token>`. The token is 32 random bytes the Vault makes and keeps as `hooks-<route>`; a delivery
carries it in the address, or posts to `/hooks/<flow-name>` with `Authorization: Bearer <token>`. It is compared in constant time and never logged. Their yes when they turn the Flow on covers opening the
route and turning the listener on. Turning the Flow off closes it, and turning it on again opens the same address. `hooks.flow` gives the address to the person (never to an agent), `hooks.flow.renew` makes
a new token so the old address stops working, `hooks.flow.test` sends a test through the listener that starts nothing, and `hooks.flow.sign` adds a signature check (hmac-sha256, github, stripe) for a
sender that signs. A form post (form-encoded) reaches the Flow as its fields, JSON as it is; either is untrusted outside data.

## Turn it on (a route opened by hand)

Off by default (`hooks.enabled` in `config.json`). Off means there is no listener at all.

1. `vyre hooks on`. vyred listens on `127.0.0.1:7310` (`hooks.port`), plain HTTP, loopback only.
2. Put the sender's signing secret in the vault and let this module use it:

   ```
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   ```

3. Open the route. Each needs a person, and each needs a signature scheme:

   ```
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   ```

4. `vyre hooks status` shows the routes and whether the internet can reach them.
5. `vyre hooks close northwind-orders` answers 404 on the route at once.

## What it accepts

Only `POST /hooks/<name>` for a route that is open right now; anything else is a bare 404. A JSON or form body of at most 256 KB, read within 5 seconds, and a per-route rate limit.
A request that fails its signature is refused and never stored. The secret appears in no log line, event, error, tool result, response or config.

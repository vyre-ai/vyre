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

## Turn it on

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

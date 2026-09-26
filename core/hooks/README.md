# Vyre hooks

Webhooks from the public internet, through Tailscale Funnel. Some services only report by
webhook: a payment processor, a form service, a code host. This module lets one of them reach a
watcher on the box, and does nothing else. The design is ADR 0014, part 10.

A delivery that arrives is checked against the sender's own signature, stored, and announced as
the event `hook.received { route, id, bytes, at }`. It never calls a tool, never reaches the Gate,
and reads nothing from the vault except its own route's secret. A watcher listening for that
event reads the body.

## Turn it on

Off by default (`hooks.enabled` in `config.json`). Off means there is no listener at all.

1. `vyre hooks on`. vyred listens on `127.0.0.1:7310` (`hooks.port`), plain HTTP, loopback only.
   tailscaled shares the box's network namespace, so it reaches loopback; nothing else outside
   the box does.
2. Put the sender's signing secret in the vault and let this module use it:

   ```
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   ```

3. Open the route. Each needs a person, and each needs a signature scheme:

   ```
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   ```

4. Publish it with Funnel. Vyre prints this and never runs it. On a Docker box, run it in the
   tailscale container (`cd /srv/vyre && docker compose exec tailscale ...`):

   ```
   tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders
   ```

   Port 8443, never 443: vyred binds 443 on the tailnet addresses itself.

5. `vyre hooks status` shows the public address to give the sender,
   `https://vyre.tail0000.ts.net:8443/hooks/northwind-orders`, and anything that does not line up.

## Schemes

| Scheme | Header | Signed |
|---|---|---|
| `hmac-sha256` | the one you name | hex HMAC-SHA256 of the raw body |
| `github` | `X-Hub-Signature-256` | `sha256=` and the hex HMAC-SHA256 of the raw body |
| `stripe` | `Stripe-Signature` | `t=<seconds>,v1=<hex>` over `<t>.<raw body>`; more than 5 minutes off is refused |

A body seen before on the same route is answered 200 and not stored or announced again, which
covers a sender's retries and a replay of a scheme with no timestamp.

## Limits

Only `POST /hooks/<name>` for an open route; everything else is a bare 404. JSON or form bodies,
at most 256 KB, read within 5 seconds. 30 requests a minute per route, 120 across all of them.
The newest 500 deliveries are kept, for at most 7 days. Kept headers are an allowlist: content
type, user agent, and the provider's event and delivery ids.

## A watcher on a route

A watcher runs on the event with `on` and `where`; for `hook.received`, `where` must name the
route. The runtime reads the delivery (`hooks.delivery`) and hands it over as `hook.delivery`,
so the watcher stays in its sandbox.

`~/.vyre/watchers/northwind-orders/watcher.json`:

```json
{ "name": "northwind-orders", "project": "northwind-bakery",
  "on": "hook.received", "where": { "route": "northwind-orders" }, "emits": "order.received" }
```

`~/.vyre/watchers/northwind-orders/watch.js`:

```js
export default async function watch({ hook, emit, log }) {
  if (!hook) return log("no delivery: a dry run without an event");
  const order = JSON.parse(hook.delivery.body);
  log("order", order.order, "for", order.pickup);
  emit({ id: String(order.order), title: `Order ${order.order}: ${order.items.join(", ")}`, at: hook.at });
}
```

Dry-run it on a real delivery from `vyre hooks` (its id), then turn it on:
`watchers.test { name: "northwind-orders", event: { route: "northwind-orders", id: "hd_..." } }`,
then `vyre watchers create northwind-orders`.

## Close

`vyre hooks close northwind-orders`. vyred answers 404 on the path at once. Funnel keeps
forwarding it until you run the command it prints:

```
tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off
```

When the last route closes, it also prints `tailscale funnel --https=8443 off`.

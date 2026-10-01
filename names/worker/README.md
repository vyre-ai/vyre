# names/worker

The Vyre name directory: a Cloudflare Worker at `names.vyre.run` with one Durable Object. It holds
the only vyre.run DNS credential, so a box never sees one (plan section 3.1, and 3.6c for the
same-site rules). A box authenticates with its relay route key (ADR 0026, Ed25519).

- `index.js`: the Worker (request checks, signature check) and `Directory`, the Durable Object.
  No dependencies; WebCrypto only.
- `fake-dns.js`: a fake Cloudflare DNS API (a `fetch`) for tests.
- `worker.test.js`: everything below against `relay/worker/fake-cf.js` and the fake DNS.
- The box side is `core/names/directory.js` (the signed client) and `core/names/service.js`.
  `core/names/rules.js` holds the name rules both sides share; the test checks the two copies match.

## Endpoints

All JSON. Success is `{ "data": ... }`, failure `{ "error": { "code", "message" } }`.

| Call | Does |
| --- | --- |
| `POST /v1/names/claim {name}` | Binds the name to the caller's route for good. Returns a one-time 128-bit recovery code (only its hash is stored). |
| `POST /v1/names/point {name, ip}` | Sets the A record (100.64.0.0/10). The tailnet's IPv6 address is refused (`ipv4_only`): resolvers that filter DNS rebinding drop it. Everything else is refused, IPv4-mapped and private ranges included. |
| `POST /v1/names/acme {name, token}` | Sets `_acme-challenge.<name>` TXT, for a name the route holds. `{own: true, token}` writes under `<routehash>.acme.vyre.run` instead, for the person's own domain. |
| `DELETE /v1/names/acme {name}` or `{own: true}` | Clears it. |
| `POST /v1/names/recover {name, code, next}` | A 72-hour pending rebind to the caller's route. `next` is the hash of the new recovery code the box chose. |
| `POST /v1/names/recover/cancel {name}` | The current owner's route cancels it. A box that is online does this by itself. |
| `POST /v1/names/code {name, next}` | The owner replaces the recovery code (and cancels a pending recovery). |
| `POST /v1/names/release {name}` | Gives the name up. A name that was ever pointed becomes a tombstone forever. |
| `GET /v1/names/mine` | This route's name, state, pending recovery, notices, and its own-domain zone. |
| `GET /v1/names/check?name=` | `ok`, `taken`, `reserved`, `invalid`, or `mine` (when signed). |

Every call but `check` carries `x-vyre-route`, `x-vyre-pub`, `x-vyre-ts`, `x-vyre-nonce` and
`x-vyre-sig`: an Ed25519 signature over `vyre-names-v1`, the route, the time, the nonce, the method,
the path and query, and the sha256 of the body. The route id must be the hash of the key, the clock
within 60 seconds, and a nonce is good once.

## Rules

- **Names:** 3 to 32 characters, letters, digits and single dashes, starting with a letter; no
  `xn--`, no leading or trailing dash. Reserved words and brands are checked after folding
  lookalikes (rn to m, 0 to o, 1 to l, and i to l so `login` and `log1n` meet), with dashes removed,
  and a brand as a dash-separated part (`my-paypal`) is refused too.
- **Limits:** one name per route, 5 claims per address a day, a global daily ceiling
  (`GLOBAL_CLAIMS_PER_DAY`, a warning is logged when it is hit), 10 ACME writes per route a day,
  5 recover attempts per name and 20 per address a day, right or wrong.
- **Never reassigned:** a name that was ever pointed is a tombstone forever after release. Only a
  recovery code moves it. A name claimed and never pointed lapses after 7 days (checked on access
  and by the hourly sweep).
- **Recovery:** the rebind waits 72 hours. The old route cancels it with no click if its box is
  online (`core/names` does this on its hourly look). Each attempt is logged on the name and adds a
  notice the owner's devices read from `mine`. A wrong code and an unknown name answer the same.
- **Browsers:** a POST or DELETE with any Origin other than `https://names.vyre.run`, or marked
  cross-site, is refused; a box sends none. Nothing here serves user content, sets or reads a
  cookie, answers CORS, or publishes a wildcard record.
- **DNS fence:** the Worker touches only A, AAAA and TXT records, only inside the zone.

## CAA on the vyre.run apex (document only, do not add yet)

Before any CAA record goes on the vyre.run apex, find out which certificate authorities Cloudflare
uses for the zone's edge certificates (the relay, names and phone hosts are served by Cloudflare).
Either confirm Cloudflare adds its own CAA entries for its edge certificates, or add them by hand.
Adding a CAA that lists only `letsencrypt.org` would stop Cloudflare renewing the edge certificates
if it issues them from another CA. Done check: every Cloudflare-served vyre.run host still renews
with CAA in place. This Worker adds no CAA records and never touches that type.

## Tests

```sh
nice -n 15 node --test names/worker/*.test.js core/names/directory.test.js
```

## Deploy

Only after the lead approves. Nothing here has been deployed or has called Cloudflare.

```sh
cd names/worker
npx wrangler secret put CF_API_TOKEN   # Zone.DNS edit on vyre.run only
npx wrangler secret put CF_ZONE_ID
npx wrangler deploy --dry-run          # should list the DIRECTORY object and NAMES_LIMITER
npx wrangler deploy
```

`ZONE`, `ORIGIN` and `GLOBAL_CLAIMS_PER_DAY` are plain vars in `wrangler.toml`. The migration `v1`
creates `Directory` as a SQLite-backed class (Free plan). `names.vyre.run` is a Worker custom
domain, so Cloudflare makes its DNS record and certificate. The cron trigger runs the sweep hourly.
`NOW` and `CF_FETCH` in the environment exist for the tests only and are never set in production.

## Left for 0.3

ZeroSSL overflow (`/v1/names/eab`, a CA list), the Public Suffix List filing, and the Let's Encrypt
rate-limit request.

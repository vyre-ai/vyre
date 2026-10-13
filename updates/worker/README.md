# updates/worker

The weekly update list for vyre.run. A person gives a name and an email and ticks the promise "One email a week with what
changed in Vyre. Never more. Unsubscribe any time." This Worker keeps one row for them, and removes it again from a signed link.
It sends nothing.

- `index.js`: the Worker. No dependencies; WebCrypto only.
- `consent.js`: the promise and its version. The site prints `CONSENT_TEXT`; each row stores `CONSENT_VERSION`.
- `wrangler.toml`: the route, the KV binding, the rate limiter. No account id, no secret.
- `worker.test.js`: signup, validation, rate limit, duplicates, logging, unsubscribe, and the site/config checks.

## Routes

| Route | Does |
|---|---|
| `POST /api/updates` | Takes `{ name, email, consent, source? }` as JSON, or the plain HTML form. Answers `{ data: { ok: true } }` or `{ error }`; the plain form gets a small HTML page. |
| `GET /api/updates/unsubscribe?t=TOKEN` | A page with one button. Opening it removes nobody, so a mail scanner that follows the link does no harm. |
| `POST /api/updates/unsubscribe?t=TOKEN` | Deletes the row. A mail client's one-click unsubscribe (`List-Unsubscribe-Post`) lands here too. |

The Worker is attached to those paths on the `vyre.run` zone as routes. The site (Cloudflare Pages) answers everything else, and
the form posts to its own origin, so there is no CORS.

## What a row holds

KV key `s:<id>`, where `id` is the first 32 characters of base64url HMAC-SHA256 of the lowercase address under `UPDATES_SECRET`.
The key list shows no address. The value:

```json
{ "email": "ada@example.com", "name": "Ada Lovelace", "created_at": "2026-10-14T09:00:00.000Z",
  "consent_version": "2026-10-14.1", "source": "/updates/", "confirmed_at": null }
```

The same address signing up twice changes nothing and gets the same answer, so the form cannot tell a stranger who is on the list.
`confirmed_at` is null for every row; see "Before the first email" below.

## Unsubscribe links

`token = id + "." + base64url(HMAC-SHA256(secret, "unsub\n" + id))`. The check is constant-time. A sender builds the link
`https://vyre.run/api/updates/unsubscribe?t=<token>` with `subscriberToken(secret, id)` from `index.js`, and lists rows with
`env.UPDATES.list({ prefix: "s:" })`. Leaving deletes the row; nothing is kept about it.

## Limits and logs

- Per-address limit, as the relay does it: `UPDATES_LIMITER`, 5 a minute per `cf-connecting-ip`, never a global one (GHSA-25xh-w9j7-7v28).
- Bodies over 4 KB, other content types and cross-site posts are refused. A filled hidden field (`website`) gets a success answer and stores nothing.
- No console call anywhere in `index.js` (a test checks it) and `[observability] enabled = false`, so Cloudflare keeps no request log.
  The address is in KV and in memory for the length of the call, nowhere else.

## Before the first email

Three things are open and belong to the owner, not to this Worker:

1. Who sends. Nothing here sends. The privacy page promises to name the sending service before the first email.
2. Confirmation. A stranger can type someone else's address. Recommended: the first mail to a row is a confirmation, and only a row
   that clicked it (`confirmed_at` set) gets the weekly mail. The row already has the field.
3. Every email needs `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers pointing at the link above.

## Tests

```sh
node --test updates/worker/worker.test.js
```

(The last test reads `site/updates/index.html`, so run `node scripts/gen-site.mjs` first.)

## Deploy

Only after the lead has the owner's go. Deploy this Worker before the site that carries the form, or the form posts into a 404.

```sh
cd updates/worker
npx wrangler kv namespace create UPDATES      # prints an id: put it on the `id =` line in wrangler.toml
printf %s "<32+ random characters>" | npx wrangler secret put UPDATES_SECRET
npx wrangler deploy --dry-run                 # should list the KV binding, the limiter, and the two vyre.run routes
npx wrangler deploy
```

What the owner approves, exactly:

1. A new Workers KV namespace `UPDATES` on the Cloudflare account (the only storage; holds the names and emails).
2. A new secret `UPDATES_SECRET`, 32+ random characters, only in Cloudflare. If it is ever replaced, every stored id and every
   unsubscribe link already sent stops matching, so it is set once.
3. Two Worker routes on the `vyre.run` zone: `vyre.run/api/updates` and `vyre.run/api/updates/*`. They go in front of Pages for those paths only.
4. A new rate limiter namespace `28001` (this account's own number; the relay uses 26xxx, the name directory 27xxx).
5. The Cloudflare token the deploy uses needs Workers Scripts edit, Workers KV Storage edit and Workers Routes edit on the `vyre.run` zone.
   The existing relay token has the first; check the other two.

After the deploy, one real test: post a signup from `https://vyre.run/updates/`, see the row in the KV namespace, open the unsubscribe
link built with `subscriberToken`, press the button, see the row gone.

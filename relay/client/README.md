# relay/client

The device side of the relay (ADR 0026): what the Expo app (the web build at app.vyre.run, iOS and
Android) imports to reach a box through `relay.vyre.run`, and what the tests drive in Node 22+.
Plain ES modules, no npm dependencies, `Uint8Array` only.

The app takes the folder as source (a path alias or a copy; it is not in the npm package):

```js
import { pair, connect } from "<repo>/relay/client/client.js";
import { webCrypto, indexedDbKeyStore } from "<repo>/relay/client/webcrypto.js";
import { nobleCrypto } from "<repo>/relay/client/noble.js";
import { createPaths } from "<repo>/relay/client/paths.js";
```

## Crypto provider

The Noise handshake runs on an async provider:

| Where | Provider | Device key |
|---|---|---|
| Web (browser, the web build) | `webCrypto()` on `crypto.subtle` (X25519, AES-GCM, SHA-256, HMAC) | a `CryptoKey` made **non-extractable**: page code can use it, never read it |
| iOS and Android (Hermes has no WebCrypto X25519) | `nobleCrypto({ x25519, sha256, hmac, gcm, randomBytes })` with `@noble/curves`, `@noble/hashes` and `@noble/ciphers` injected by the app | raw 32 bytes, kept in `expo-secure-store` |
| Node 22+ (tests) | `webCrypto()` | as on the web |

The repo does not depend on @noble; see the top of `noble.js` for the imports.

## Key store

`{ get(): Promise<KeyPair | null>, set(keyPair): Promise<void> }`, where a key pair is
`{ privateKey, publicKey: Uint8Array(32) }` and `privateKey` is whatever the provider made (a
`CryptoKey` on the web, bytes with @noble). `pair()` makes the key on first use and stores it.

- `indexedDbKeyStore()`: the web. The `CryptoKey` structured-clones into IndexedDB and stays non-extractable.
- `memoryKeyStore()`: tests, or a session that should forget its key.
- Native (the lead's choice: @noble, key in secure-store; the Secure Enclave cannot hold X25519):

```js
import * as SecureStore from "expo-secure-store";
import { base64url, fromBase64url } from "<repo>/relay/client/bytes.js";

const crypto = nobleCrypto({ x25519, sha256, hmac, gcm, randomBytes });   // randomBytes from vyre-signer
const keyStore = {
  async get() {
    const raw = await SecureStore.getItemAsync("vyre.relay.key");
    return raw ? crypto.importKeyPair(fromBase64url(raw)) : null;
  },
  async set(k) {
    await SecureStore.setItemAsync("vyre.relay.key", base64url(k.privateKey),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
};
```

  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps the key out of backups and off other devices, so a
  restored phone pairs again rather than carrying the old device's identity.

## API

```js
// Scan: the QR's URL (https://vyre.run/pair#...). Store the result; it holds no secret.
const box = await pair(scannedUrl, { name: "alex's phone", presenceKey, keyStore, crypto });
// -> { relay, route, box, name, device, presence }

const conn = connect({ ...box, keyStore, crypto });   // WebSocket defaults to globalThis.WebSocket
// The hosted web app also passes about: { kind: "web", release, manifest } to pair() and connect().
conn.onstate = s => {};                               // "connecting" | "open" | "offline"
const res = await conn.fetch("/v1/tools/notes.add", { method: "POST", body: JSON.stringify({ text: "hi" }) });
res.status; res.headers.get("content-type"); await res.json();   // or text(), or for await (const c of res.body)
const ev = conn.events("/v1/events/stream?since=latest", { onEvent: e => {}, lastEventId });  // e: { id, event, data }
ev.lastEventId;  ev.close();
const ws = conn.socket("/v1/streams/term/juno");      // WebSocket-shaped: onopen, onmessage, send, close
conn.close();
```

What it does for you (ADR 0029): reconnects with a fresh handshake, backing off 1 s to 60 s with
jitter; sends a text `ping` at most every 60 s and treats two missed `pong`s as a stall; does
nothing while `document.visibilityState` is hidden and reconnects at once on return (React Native:
pass `visibility: { hidden(), on(fn) }` built on AppState); resumes event streams with
`Last-Event-ID` and drops ids it already applied; treats 45 s of silence on a stream as dead; adds
`Idempotency-Key: <uuid>` to every non-GET that has none, and sends a request whose response was
lost to a dropped channel once more, with the same key, on the next channel. A socket does not
survive a reconnect: open a new one on close.

## Paths

`createPaths({ paths: [{ kind: "direct", base: "https://<box>.<tailnet>.ts.net" }, { kind: "relay", ...box, keyStore, crypto }] })`
gives the same `fetch`, `events` and `socket`, plus `current`. Direct is used once it answers a
probe within 1.5 s; a transport error moves to the relay at once (the request keeps its key); on
the relay, the better path is probed every 60 s while visible and the connection moves back.
Event streams move with it and resume from their cursor.

## Scan-to-pair with a compact ticket ("Wink", ADR 0045)

A Vyre code (the avatar's scannable ring) has room for only 72 bits, nowhere near a full offer
(a 256-bit box key, a route id, a secret, a name). So it carries only an 8-byte ticket, and the
phone resolves the actual offer from the relay rather than reading it off the code.

**Confirm before you pair.** `resolveTicket()` looks the ticket up and verifies it, but does not
pair, it hands back who the box says it is, so a screen can show "Pair with alex's box
(a1b2 c3d4)?" and let the person confirm before anything happens. The MAC proves the relay's
answer is unmodified from whatever the box minted; it does **not** prove it is the person's own
box, someone hands you a code for THEIR box, you scan it, the MAC still checks out. Reading the
name and fingerprint first, and only then calling `pairOffer()`, is the only thing that catches
that (reviewer, 28 Sep). `pairTicket()` chains both calls for a caller that genuinely does not
confirm.

```js
import { resolveTicket, pairOffer, keyFingerprint } from "<repo>/relay/client/client.js";

// ticket: the 8 raw bytes the Vyre code encoded. relay: the ws:// or wss:// base the app already
// knows to ask (there is no room in the code to carry it; a self-hosted relay is out of scope for
// this path, fall back to a full QR there).
const { offer, name, fingerprint, handle } = await resolveTicket(ticket, { relay, crypto });
// Show "Pair with {name} ({fingerprint})?" and wait for the person, THEN:
const paired = await pairOffer(offer, { name: "alex's phone", keyStore, crypto });
// -> exactly what pair() returns: { relay, route, box, name, device, presence }
// handle: the box's claimed <handle>.vyre.run, or null if it hasn't claimed one, redirect there
// after pairing if you want a friendlier address than the relay/route.

// The one-call form, for a caller that skips the confirm step:
// const paired = await pairTicket(ticket, { relay, name: "alex's phone", keyStore, crypto });
```

`resolveTicket` does every step through verification:

1. Derives four values from the ticket, each a `sha256` of a distinct tag plus the ticket bytes,
   matching `core/relay/wire.js`'s `ticketDerive` byte for byte: a locator (tag `vyre-pair-loc`),
   the pairing secret (tag `vyre-pair-sec`), a MAC key (tag `vyre-pair-mac`) and a record key
   (tag `vyre-pair-enc`). **The raw ticket itself never leaves the device**, only the locator goes
   to the relay.
2. `POST {relay's http(s) origin}/v1/pair` with `{ "loc": "<base64url>" }` in the body, never in a
   URL (so it is never in an access log). One request, and single-use either way:
   - `200 { record, mac }`, `record` is the sealed record exactly as the box handed it to the
     relay, base64url of AES-256-GCM ciphertext plus tag (the relay never sees it in the clear),
     and `mac` is `hmacSha256(macKey, record)` over those exact characters, as base64url.
   - `404`, the ticket does not exist, already expired (5 minutes), or was already resolved once.
     These three cases are deliberately indistinguishable: show one generic "this code expired or
     was already used, scan again" message.
   - `429`, too many attempts (per IP and globally); back off and let the person try again.
   - `400`, a malformed request (this library only sends well-formed ones; a real 400 means a
     version mismatch worth logging).
3. Verifies `mac` against `hmacSha256(macKey, utf8(record))` itself, **before parsing or trusting
   anything in `record`**. A mismatch means the relay (or someone controlling it) tried to answer
   with a substituted identity; `resolveTicket` throws and nothing is ever offered for pairing.
4. Opens `record` with AES-256-GCM under the record key (a 12-byte zero nonce, since each key
   seals exactly one record, and the AD `"vyre-pair-record\n1"`); a failure is `bad_record`.
   Parses the JSON inside (`{ v: 1, name, handle, identity, relay, route, box, exp }`), refuses one whose own `exp`
   has already passed (the MAC only proves the record is unmodified, not that it was fetched in
   time), and sanitises `name` and `handle` the same way a box's own name is sanitised in a Touch
   ID prompt (control characters, bidi overrides, capped) before either reaches the UI. `handle`
   is additionally validated as a real subdomain shape; anything else becomes `null` rather than a
   sanitised-but-wrong string.
5. Computes `fingerprint` via `keyFingerprint`, below.

`pairOffer(offer, o)` then runs the exact same handshake `pair()` runs from a QR offer, with the
ticket-derived secret as the pairing secret, and returns the same shape `pair()` does.

`keyFingerprint(box, crypto)` gives the same short fingerprint (`base32(sha256(box)).slice(0, 8)`,
shown as two groups of 4) the box's own Touch ID prompt already shows for `relay.join`, so a
"pairing with alex's box (a1b2 c3d4)" screen on the phone reads identically to what the person
sees on the box's own screens.

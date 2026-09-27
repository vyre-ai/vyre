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
- Native: write one on `expo-secure-store` (base64url the private bytes).

## API

```js
// Scan: the QR's URL (https://vyre.run/pair#...). Store the result; it holds no secret.
const box = await pair(scannedUrl, { name: "alex's phone", presenceKey, keyStore, crypto });
// -> { relay, route, box, name, device, presence }

const conn = connect({ ...box, keyStore, crypto });   // WebSocket defaults to globalThis.WebSocket
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

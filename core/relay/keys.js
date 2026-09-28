// @ts-check
// The box's relay keys: box.key (Noise static, the QR carries its public half) and route.key
// (proves the route to the relay). One small interface so moving where these live — into
// vyre-core's `_vyre` service user (ADR 0040), off the person's own uid — is a swap of this file,
// not a rewrite of core/relay/index.js's pairing logic, which only ever calls loadKeys(root).
//
// Today: ~/.vyre/relay/keys.json (0600), made on first use, never leaves the box. That file sits
// on the person's own uid, so a process running as them (including a prompt-injected model) can
// read or replace it — the reason relay-on-a-Mac is not enabled by default until vyre-core holds
// this instead (docs/work/tailnet.md "Needs from others").

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keyPair } from "./noise.js";
import { newRouteKey } from "./wire.js";

/** The box's relay keys, made on first use. */
export function loadKeys(root) {
  const dir = path.join(root, "relay");
  const file = path.join(dir, "keys.json");
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    const box = keyPair(Buffer.from(k.box, "base64url"));
    const routePriv = Buffer.from(k.route, "base64url");
    const routePub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), routePriv]), format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" }).subarray(-32);
    return { box, route: { priv: routePriv, pub: Buffer.from(routePub) } };
  } catch (e) {
    if (/** @type {any} */ (e).code !== "ENOENT") throw new Error(`relay keys unreadable (${file}): ${/** @type {Error} */ (e).message}`);
  }
  const box = keyPair(), route = newRouteKey();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, box: box.priv.toString("base64url"), route: route.priv.toString("base64url") }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { box, route };
}

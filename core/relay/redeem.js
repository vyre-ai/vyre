// @ts-check
// redeem: this Vyre becomes a device of someone else's box, over the relay, from a one-time
// pairing code (ADR 0026 section 6). Runs relay/client/*, the same cross-platform library the
// Expo app runs, with a Node-native crypto provider and a file-backed key store (nodecrypto.js)
// so this device's identity survives a restart the same way core/relay/keys.js already persists
// the box's own key.
//
// One redemption, not a kept-open connection: this runs the pairing handshake and returns what
// the box said (its name, this device's id, whether presence enrolled), then closes the channel.
// Staying connected afterward is connect()'s job (relay/client/client.js), not wired in here yet
// (docs/work/tailnet.md "Doing").

import fs from "node:fs";
import path from "node:path";
import { pair } from "../../relay/client/client.js";
import { deviceKeyFor } from "./devicekey.js";

/**
 * @param {string} url the pairing URL a box's relay.pair.start (or onboard.join{action:"relay"}) minted
 * @param {{ root: string, name?: string, tailnet?: boolean, coreKeys?: any }} o `coreKeys`: vyre-core's key store, which then holds this device's key
 */
export async function redeem(url, { root, name, tailnet = false, coreKeys }) {
  const paired = await pair(url, { ...deviceKeyFor(root, coreKeys), name, tailnet });
  // What connect() needs later (no secret in it), so the tailnet join (ADR 0046) can reach this
  // box again after a restart. A new pairing replaces the old record whole.
  const box = path.join(root, "relay-device", "box.json");
  fs.mkdirSync(path.dirname(box), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${box}.tmp`, JSON.stringify({ relay: paired.relay, route: paired.route, box: paired.box, device: paired.device, name: paired.name }), { mode: 0o600 });
  fs.renameSync(`${box}.tmp`, box);
  return paired;
}

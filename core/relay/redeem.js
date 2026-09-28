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

import path from "node:path";
import { pair } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";

/**
 * @param {string} url the pairing URL a box's relay.pair.start (or onboard.join{action:"relay"}) minted
 * @param {{ root: string, name?: string }} o
 */
export async function redeem(url, { root, name }) {
  const file = path.join(root, "relay-device", "key.json");
  return pair(url, { crypto: nodeCrypto(), keyStore: fileKeyStore(file), name });
}

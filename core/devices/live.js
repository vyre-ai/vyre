// @ts-check
// Dial a space server over the relay and hold the channel, so this computer stays live there.
// The space address is a https origin. Its directory record carries the relay, the route and the box key. Nothing here adds a field to devices.signin.
// The hello is the unlocked identity's chain key over this server's box (relay/client/chainhello.js). The server admits a device that key's list names (core/relay/chain-admit.js).

import path from "node:path";
import { idDirectory, memorySeen } from "../../lib/identity/directory.js";
import { fileIdentityStore } from "../spaces/identity.js";
import { chainHello } from "../../relay/client/chainhello.js";
import { connect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";

const refuse = (message, code) => Object.assign(new Error(message), { code });
const UNREACHABLE = "This computer could not find that space's server.";
const DENIED = "That space's server did not admit this computer.";

/** @type {Map<string, { close(): void }>} */
const open = new Map();

/** Close every channel this process is holding. Called when the devices module stops. */
export function closeDials() {
  for (const conn of open.values()) { try { conn.close(); } catch { /* already closed */ } }
  open.clear();
}

/** @param {string} server */
function labelOf(server) {
  let host = "";
  try { host = new URL(server).hostname.toLowerCase(); } catch { return ""; }
  if (host.endsWith(".vyre.run")) host = host.slice(0, -".vyre.run".length);
  return host;
}

/**
 * @param {any} ctx
 * @param {{ server: string, username: string }} info
 * @returns {Promise<{ device: string, live: true }>}
 */
export async function dialLive(ctx, info) {
  const base = ctx && ctx.config && ctx.config.names && typeof ctx.config.names.directory === "string" ? ctx.config.names.directory : "";
  const name = labelOf(info.server);
  if (!base || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(name)) throw refuse(UNREACHABLE, "unreachable");
  /** @type {any} */ let resolved;
  try {
    resolved = await idDirectory({ base, seen: memorySeen(), timeoutMs: 8000 }).resolve(name);
  } catch { throw refuse(UNREACHABLE, "unreachable"); }
  const route = resolved && resolved.ok && resolved.kind === "space" && resolved.payload && resolved.payload.route;
  const relay = route && typeof route.relay === "string" ? route.relay : "";
  const id = route && typeof route.route === "string" ? route.route : "";
  const box = route && typeof route.box === "string" ? route.box : "";
  if (!/^wss?:\/\/[^\s/]+$/.test(relay) || !/^[a-z2-7]{26}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(box)) throw refuse(UNREACHABLE, "unreachable");
  const root = ctx && ctx.paths && ctx.paths.root;
  if (!root) throw refuse(UNREACHABLE, "unreachable");
  const store = fileIdentityStore(path.join(root, "spaces"));
  const st = store.status();
  if (!st.exists || !st.id || !st.eid) throw refuse(UNREACHABLE, "unreachable");
  const who = String(info.username || "").toLowerCase();
  const crypto = nodeCrypto();
  const key = `${root}\n${info.server}`;
  const prev = open.get(key);
  if (prev) { try { prev.close(); } catch { /* already closed */ } open.delete(key); }
  /** @type {ReturnType<typeof connect>} */
  let conn;
  try {
    conn = connect({
      relay, route: id, box, name: who || "a computer", crypto, keyStore: fileKeyStore(path.join(root, "devices", "relay-key.json")),
      about: { kind: "app" }, backoff: { min: 200, max: 400 },
      chainHello: (/** @type {Uint8Array} */ devicePub) => chainHello({
        sha256: (b) => crypto.sha256(b), devicePub, box, identity: String(st.id), entry: String(st.eid), name: who,
        sign: async (m) => new Uint8Array(await store.sign(Buffer.from(m))),
      }),
    });
  } catch { throw refuse(UNREACHABLE, "unreachable"); }
  open.set(key, conn);
  try {
    await conn.ready(AbortSignal.timeout(12000));
  } catch {
    const denied = Boolean(conn.lastError);
    try { conn.close(); } catch { /* already closed */ }
    open.delete(key);
    throw refuse(denied ? DENIED : UNREACHABLE, denied ? "denied" : "unreachable");
  }
  const device = conn.reply && typeof conn.reply.device === "string" ? conn.reply.device : "";
  if (!device) {
    try { conn.close(); } catch { /* already closed */ }
    open.delete(key);
    throw refuse(DENIED, "denied");
  }
  return { device, live: true };
}

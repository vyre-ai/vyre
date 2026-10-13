// @ts-check
// Pair this device to a server its person's other devices use, with no typed code (design B). The relay client dials the pinned box with a chain hello (relay/client/chainhello.js) signed by this device's chain
// key; the server admits a device the identity chain lists, and the reply names the device it made. The Noise handshake fails if the server does not hold `box`, and the hello travels inside it. Every outside
// thing comes in as a port so Node tests it against a fake connection. The caller saves the pairing (afterPaired).
import { isPinned } from "./space-list.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ id: string, name: string, relay: string, route: string, box: string }} e
 * @param {{ who: { id: string, eid: string, sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array } | null, crypto: { sha256: (b: Uint8Array) => Promise<Uint8Array> }, keyStore: any, about: any, name: string,
 *   connect: (o: any) => { ready: () => Promise<any>, reply: any, close: () => void }, chainHello: (o: any) => Promise<any> }} d
 */
export async function chainPair(e, d) {
  if (!isPinned(/** @type {any} */ ({ kind: "server", ...e }))) throw fail("unpinned", `${e.name} has no key to check. Pair it with a code from that server.`);
  if (!d.who) throw fail("no_identity", "Choose your Vyre name on this device first.");
  const who = d.who;
  const conn = d.connect({
    relay: e.relay, route: e.route, box: e.box, name: d.name, crypto: d.crypto, keyStore: d.keyStore, about: d.about,
    chainHello: (/** @type {Uint8Array} */ devicePub) => d.chainHello({ sha256: d.crypto.sha256, devicePub, box: e.box, identity: who.id, entry: who.eid, sign: who.sign, name: d.name }),
  });
  try {
    await conn.ready();
    const device = conn.reply && typeof conn.reply.device === "string" ? conn.reply.device : "";
    if (!device) throw new Error("no device");
    return { relay: e.relay, route: e.route, box: e.box, name: e.name, device, presence: null };
  } catch (x) {
    const why = x instanceof Error && x.message ? x.message : "refused";
    throw fail("refused", `${e.name} did not let this device in (${why}). Add this device from one you already use, then try again.`);
  } finally { try { conn.close(); } catch { /* already closed */ } }
}

// @ts-check
// Pair a server the person's list names, by the identity chain and no typed code (design B). Dial it with the relay client carrying a signed chain hello (relay/client/chainhello.js); the Noise handshake itself
// proves the server holds the pinned box key first, so the hello goes only to that server. A server that admits this device answers with the device id; one that does not (an older server, a person it does not
// hold) closes the connection, and the answer here is a plain refusal that says to pair with a code. Never a hang: the dial is closed after `timeoutMs` either way.

const PIN_MIN = 32;
const NOT_READY = "That server did not admit this device. Pair it with a code from that server.";
const refusal = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ connect: (o: any) => any, crypto: any, keyStore: any, about: any, deviceName: () => string,
 *   chainHelloFor: ((devicePub: Uint8Array, box: string) => Promise<any>) | null, timeoutMs?: number }} d
 * @returns {(e: { relay: string, route: string, box: string, name: string }) => Promise<{ relay: string, route: string, box: string, name: string, device: string, presence: null }>}
 */
export function makeChainPairer(d) {
  const timeoutMs = d.timeoutMs ?? 15_000;
  return async (e) => {
    if (typeof e.box !== "string" || e.box.length < PIN_MIN) throw refusal("server_not_ready", "That server has no pinned key on your list, so it is not connected by itself. Pair it with a code from that server.");
    if (typeof d.chainHelloFor !== "function") throw refusal("no_identity", "Choose your Vyre name on this device first, then connect your servers.");
    const chainHelloFor = d.chainHelloFor;
    const conn = d.connect({ relay: e.relay, route: e.route, box: e.box, name: d.deviceName(), crypto: d.crypto, keyStore: d.keyStore, about: d.about, backoff: { min: 300, max: 600 }, chainHello: (/** @type {Uint8Array} */ pub) => chainHelloFor(pub, e.box) });
    let timer;
    try {
      await Promise.race([conn.ready(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); })]);
      const device = conn.reply && typeof conn.reply.device === "string" ? conn.reply.device : "";
      if (!device) throw new Error("no device id");
      return { relay: e.relay, route: e.route, box: e.box, name: e.name, device, presence: null };
    } catch (err) {
      throw Object.assign(refusal("server_not_ready", NOT_READY), { cause: String(/** @type {Error} */ (err).message || err).slice(0, 120) });
    } finally { clearTimeout(timer); try { conn.close(); } catch { /* closed */ } }
  };
}

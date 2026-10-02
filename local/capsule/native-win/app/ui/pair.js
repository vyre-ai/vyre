// Pair this computer with the person's own server. A bundled local page: the only kind that may
// call the shell's commands and run the relay client. The device key stays in Rust (DPAPI); the
// client asks the shell for DH results only (relay/shellkey.js).
import { shellDeviceKey } from "./relay/shellkey.js";
import { resolveTicket, pairOffer } from "./relay/client.js";
import { fromBase64url } from "./relay/bytes.js";

const invoke = window.__TAURI_INTERNALS__.invoke;
const RELAY = "wss://relay.vyre.run";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN = {
  ticket_gone: "This pairing ran out of time or was already used. Start again.",
  rate_limited: "Too many tries. Wait a minute and start again.",
  bad_record: "The answer for this pairing did not check out, so nothing was paired.",
  pair_failed: "The server would not pair. Start again.",
};
const say = (e) => PLAIN[e && e.code] || (e && e.message) || String(e);

export async function startPairing({ onSeed, onWaiting, onError, onDone, onEnd }) {
  try {
    const seed = await invoke("begin_pair");
    onSeed(seed);
    const bytes = fromBase64url(seed);
    const until = Date.now() + 5 * 60 * 1000;
    let found = null;
    while (!found) {
      if (Date.now() > until) throw Object.assign(new Error(), { code: "ticket_gone" });
      try { found = await resolveTicket(bytes, { relay: RELAY }); }
      catch (e) {
        // Not there yet: the Deck has not made the ticket. Any other answer (a 409 contested,
        // a failed check, a rate limit) is a failed pairing and is said so.
        if (e && e.code === "ticket_gone") { await sleep(3000); continue; }
        throw e;
      }
    }
    onEnd();
    onWaiting(found.name);
    await invoke("offer_pair", { name: found.name, fingerprint: found.fingerprint, handle: found.handle, address: found.address ?? null });
    for (;;) {
      const st = await invoke("pair_status");
      if (st === "confirmed") break;
      if (st === "cancelled") throw new Error("Pairing was cancelled.");
      await sleep(1000);
    }
    // The app's presence key goes in the pairing, the only time the server takes one: it is what lets the server check the app's own word later
    // (that this PC's local helper may join it). The reply says whether the server took it.
    const presenceKey = { public_key: await invoke("presence_key_pub"), alg: -7 };
    const link = await pairOffer(found.offer, { name: "this computer", about: { kind: "app" }, presenceKey, ...shellDeviceKey(invoke) });
    await invoke("finish_pair", { link });
    onEnd();
    onDone();
  } catch (e) {
    onEnd();
    await invoke("cancel_pair").catch(() => {});
    onError(say(e));
  }
}

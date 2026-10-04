// The person session of a device paired over the relay (vault's presence.person.pair-grant / pair-challenge / start-paired, core/presence/person.js).
// After the pairing the server holds ONE one-use grant for this device (a challenge good 10 minutes). The device asks for the challenge over its own paired channel, signs
// `paired-start\n<device id>\n<challenge>` with the SAME private key whose public half the owner confirmed at pairing (this browser's P-256 key, personKey()), ES256 as raw
// 64 bytes (r||s, what WebCrypto emits), base64url, and trades it for a bearer token. The token is kept where webPerson reads it; every request after carries
// `authorization: Vyre <token>` and a signed x-vyre-proof (person.ts), and the token rotates before 30 days (presence.person.rotate, not here yet).

import { noteRenewed } from "./notice.js";
import { b64url } from "./person.ts";

/** One tool call over the paired channel: the relay client's connection, injected so Node tests it with a fake. */
export type ChannelCall = (tool: string, input: Record<string, unknown>) => Promise<{ data?: Record<string, unknown>; error?: { code?: string; message?: string } }>;

/** The text the device signs to start its session. */
export const pairedStartMessage = (device: string, challenge: string) => `paired-start\n${device}\n${challenge}`;

/** Ask for the challenge, sign it with the device key, trade it for the token. Resolves { token, id, expires }; rejects with the server's words. */
export async function startPaired(o: { device: string; call: ChannelCall; privateKey?: CryptoKey; sign?: (message: Uint8Array) => Promise<Uint8Array>; label?: string }): Promise<{ token: string; id: string; expires: number }> {
  const ch = await o.call("presence.person.pair-challenge", {});
  const challenge = ch.data && typeof ch.data.challenge === "string" ? ch.data.challenge : "";
  if (!challenge) throw new Error(ch.error?.message || "The server did not give this device a challenge.");
  // The key is the one reported at pairing (the server checks the signature against it): a browser's WebCrypto key (`privateKey`), or a phone's hardware key (`sign`, the Secure Enclave
  // or the Android Keystore key, raw 64 bytes r||s; see paired-key.native.ts).
  const msg = new TextEncoder().encode(pairedStartMessage(o.device, challenge));
  if (!o.sign && !o.privateKey) throw new Error("startPaired needs the device key");
  const sig = o.sign ? await o.sign(msg) : new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.privateKey as CryptoKey, msg));
  const r = await o.call("presence.person.start-paired", { sig: b64url(sig), ...(o.label ? { label: o.label.slice(0, 64) } : {}) });
  const d = r.data;
  if (!d || typeof d.token !== "string") throw new Error(r.error?.message || "The server would not sign this device in.");
  const expires = Number(d.expires ?? 0);
  noteRenewed(); // a session was made or renewed: any failure notice goes away (src/auth/notice.js)
  return { token: d.token, id: String(d.id ?? ""), expires };
}

/** The channel call over the relay for a pairing just made: a short-lived connection of the relay client (browser and phone). */
export async function channelCall(p: { relay: string; route: string; box: string; name: string }, pairOptions: Record<string, unknown>): Promise<{ call: ChannelCall; close: () => void }> {
  const mod = (await import("@vyre/relay-client/client.js")) as unknown as { connect: (o: unknown) => { fetch: (path: string, init: unknown) => Promise<{ json: () => Promise<any> }>; close: () => void } };
  const c = mod.connect({ relay: p.relay, route: p.route, box: p.box, name: p.name, ...pairOptions });
  return {
    call: async (tool, input) => {
      const r = await c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      return (await r.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code?: string; message?: string } };
    },
    close: () => { try { c.close(); } catch { /* closed */ } },
  };
}

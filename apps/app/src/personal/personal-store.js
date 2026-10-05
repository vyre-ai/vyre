// @ts-check
// The person's sealed Personal records on the phone: Planner items, notes and to-dos kept as ciphertext in the person's own storage on a team (Cloud) Space's server, opened here with the person's own key.
// It is memory's kernel/store/sealed.js, unchanged, over RemoteBackend and the spaces.storage.* tools (core/memory/identity); this file only opens it:
//   1. read the identity home's manifest (identity/<id>/manifest.json) from the same storage, and unwrap the identity memory key (IMK) with THIS device's agree key (the device's one async step: the key stays in its keystore);
//   2. open the sealed store over a RemoteBackend, with the IMK, the Personal types and the owner's cap.
// The server sees object names, ciphertext and shas. The IMK lives only in this process and is wiped on lock.
import { unwrapWithDevice } from "../../../../lib/keywrap.js";
import { RemoteBackend } from "../../../../core/memory/identity/remote-backend.js";
import { spacesTransport } from "../../../../core/memory/identity/spaces-transport.js";
import { openSealedStore, sealedPrefixes, PERSONAL_TYPES } from "../../../../kernel/store/sealed.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const aadOf = (/** @type {string} */ id, /** @type {string} */ what) => `vyre-identity-home/${id}/${what}`;
const manifestName = (/** @type {string} */ id) => `identity/${id}/manifest.json`;

/**
 * The app's tool call as the transport wants it: `{ data }` on success, a thrown error otherwise (spacesTransport unwraps `data`; the app's `tool` already returns the data itself).
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<any>} tool
 */
export const asTransportCall = (tool) => async (/** @type {string} */ name, /** @type {any} */ input) => ({ data: await tool(name, input) });

/**
 * The identity memory key, from the manifest in the person's storage and this device's agree key. Throws `unknown_key` when the manifest holds no wrap for this device (the person's other device must add it
 * first), `not_found` when the person has no identity home on this server.
 * @param {{ get(name: string): Promise<Uint8Array | null> }} transport @param {string} identity @param {{ holder: string, ecdh: import("../../../../lib/keywrap.js").Ecdh }} agree
 * @returns {Promise<Uint8Array>}
 */
export async function identityKey(transport, identity, agree) {
  const raw = await transport.get(manifestName(identity));
  if (!raw) throw fail("not_found", "no identity memory is kept on this server");
  /** @type {any} */ let m;
  try { m = JSON.parse(new TextDecoder().decode(raw)); } catch { throw fail("corrupt", "the identity memory's manifest cannot be read"); }
  const w = Array.isArray(m?.wraps) ? m.wraps.find((/** @type {any} */ x) => x && x.kind === "device" && x.fp === agree.holder) : null;
  if (!w) throw fail("unknown_key", "this device holds no key for the identity memory yet");
  return unwrapWithDevice(w.wrapped, agree.ecdh, aadOf(identity, `wrap:${w.fp}`));
}

/**
 * Open the person's sealed Personal records on a hosted space. `call` is the app's tool call; `agree` is getAgreeKey()'s answer; `device` names this phone's change-log segments (a short id).
 * `cap` reads the owner's per-member limit in bytes (0: none). `create` makes the store the first time (the person's first device); a phone joining an existing one leaves it off.
 * @param {{ call: (tool: string, input?: Record<string, unknown>) => Promise<any>, space: string, identity: string, agree: { holder: string, ecdh: any }, device: string, cap?: () => number, create?: boolean }} o
 */
export async function openPersonalStore(o) {
  const transport = spacesTransport(asTransportCall(o.call), o.space);
  const imk = await identityKey(transport, o.identity, o.agree);
  const backend = new RemoteBackend(transport, { prefixes: sealedPrefixes(o.identity), name: "this space's server" });
  try {
    return await openSealedStore({ backend, identity: o.identity, imk, allow: PERSONAL_TYPES, device: o.device, ...(o.cap ? { cap: o.cap } : {}), ...(o.create ? { create: true } : {}) });
  } catch (e) { imk.fill(0); throw e; }
}

export { PERSONAL_TYPES };

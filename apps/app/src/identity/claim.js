// @ts-check
// Claim a Vyre name from a device with no box: make the device key, the recovery code and the identity's genesis chain, and send the claim to the names
// directory (names/worker/ids.js POST /v1/ids/claim) with a sealed record signed by this device's key. The same steps as core/spaces/identity-ops.js create,
// in WebCrypto, using kernel/identity/chain.js and names/worker/id-messages.js themselves (not copies). The identity comes first: nothing here needs a box.

import * as C from "../../../../kernel/identity/chain.js";
import { recordMessage } from "../../../../names/worker/id-messages.js";
import { sealRecord } from "./seal.js";
import { newCode, codeKey, STRETCH } from "./recovery.js";
import { generateDeviceKey } from "./keys.js";
import { createPasskeyKey, passkeyRp, WRONG_ORIGIN_SAY } from "./passkey.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** What the directory says in words a person can read. @param {any} e */
function plain(e) {
  const map = /** @type {Record<string, string>} */ ({
    name_taken: "That name is taken.", taken: "That name is taken.", bad_name: "That is not a name Vyre can use.", reserved: "That name is reserved.",
    rate_limited: "Too many names were claimed from here today. Try again tomorrow.", unreachable: "Cannot reach the names directory right now.",
  });
  return map[e && e.code] || (e && e.message) || "That did not work.";
}

/**
 * @param {{ name: string, password?: string, deviceLabel?: string, base: string, fetch?: typeof fetch, now?: () => number, random?: (n: number) => Uint8Array,
 *   params?: { memoryKiB: number, passes: number }, key?: import("./keys.js").DeviceKey, enclave?: string, agree?: string, forceSoftware?: boolean, headers?: Record<string, string>,
 *   beforeClaim?: (made: { name: string, id: string, eid: string, ops: any[], pin: any, key: import("./keys.js").DeviceKey }) => Promise<void> }} o
 */
export async function claimIdentity(o) {
  const now = o.now ?? Date.now, random = o.random ?? (n => crypto.getRandomValues(new Uint8Array(n)));
  const f = o.fetch ?? globalThis.fetch;
  const name = String(o.name).toLowerCase();
  const code = newCode(random);
  const ck = await codeKey(code, o.password ?? "", o.params ?? STRETCH);
  const key = o.key ?? await generateDeviceKey({ forceSoftware: o.forceSoftware });
  const ts = now();
  const genesis = await C.makeGenesis({
    kind: "person", entry: { eid: key.eid, kind: "device", pub: key.publicKey, ...(/** @type {any} */ (key).alg === "webauthn-es256" ? { alg: "webauthn-es256", rp: /** @type {any} */ (key).rp } : {}), ...(o.enclave ? { enclave: o.enclave } : {}), ...(o.agree ? { agree: o.agree } : {}) },
    code: { eid: ck.eid, kind: "code", pub: ck.publicKey }, nonce: C.b64u(random(12)), ts, sign: m => key.sign(m),
  });
  const state = await C.verifyChain([genesis], { now: ts + 1 });
  const sealed = await sealRecord(name, { v: 1 }, random);
  const sealedHash = await C.sha256hex(sealed);
  const sig = C.b64u(await key.sign(recordMessage({ name, id: state.id, by: key.eid, via: undefined, ts, sealedHash, vseq: undefined, vhead: undefined })));
  const body = { name, ops: [genesis], sealed, rec: { by: key.eid, ts, sig } };
  // Keep the key BEFORE the name is claimed: a name held by an identity nobody can sign for cannot be taken back, so if keeping fails (quota, a private window) nothing is claimed.
  if (o.beforeClaim) await o.beforeClaim({ name, id: state.id, eid: key.eid, ops: [genesis], pin: C.pinOf(state), key });
  let res;
  try {
    res = await f(`${o.base.replace(/\/+$/, "")}/v1/ids/claim`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...(o.headers ?? {}) }, body: JSON.stringify(body) });
  } catch (e) { throw refuse(plain({ code: "unreachable" }), "unreachable"); }
  /** @type {any} */ let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !json || json.error || !json.data) {
    const e = (json && json.error) || {};
    throw refuse(plain(e), String(e.code || "directory"));
  }
  return { name, id: state.id, eid: key.eid, ops: [genesis], pin: C.pinOf(state), recoveryCode: code, passwordSet: Boolean(o.password), key, software: key.software, claimed: json.data };
}

/**
 * Claim a name from a browser with a PASSKEY as the identity's first device (0.2.9): the person unlocks it (Face ID, Touch ID, Windows Hello or a PIN) to make it, and again to sign the genesis and the claim. It
 * is a full device, unlike a key a script on the page can reach. Everything else is claimIdentity's.
 * @param {Omit<Parameters<typeof claimIdentity>[0], "key"> & { rp?: string, webauthn?: { create(o: any): Promise<any>, get(o: any): Promise<any> } }} o
 */
export async function claimIdentityWithPasskey(o) {
  // The page decides where a passkey may be made (passkeyRp): app.vyre.run in a release build, also http://localhost in a development one. Anywhere else it is refused before the browser is asked,
  // with the words that say where to go; that origin pairs as its own device with the typed code instead. A page with no location (a test with its own authenticator) uses the default.
  const origin = typeof globalThis.location !== "undefined" ? globalThis.location.origin : undefined;
  const rp = o.rp || (origin === undefined ? "app.vyre.run" : passkeyRp(origin, { dev: typeof process !== "undefined" && process.env.NODE_ENV !== "production" }));
  if (!rp) throw Object.assign(new Error(WRONG_ORIGIN_SAY), { code: "wrong_origin" });
  const key = await createPasskeyKey({ rp, name: o.name, ...(o.webauthn ? { webauthn: o.webauthn } : {}), ...(o.random ? { random: o.random } : {}) });
  return claimIdentity({ ...o, key: /** @type {any} */ (key) });
}

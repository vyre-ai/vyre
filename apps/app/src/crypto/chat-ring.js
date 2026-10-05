// @ts-check
// The chat-key operations a device makes against the box (team/0.3/DESIGN-chat-keys.md, "Wired end to end"): make the ring for a new chat, and lend the key to the server so it can open the chat's files for
// the participants. The ring math is ring.js; this is the calls around it. `call(tool, input)` is the app's one tool call and throws with the box's words. A chat made with no ring stays in the clear.
import { b64, bundleFor, createRing, openRing, unb64, fingerprint } from "./ring.js";

/** The P-256 public JWK of a raw uncompressed point (an identity entry's `agree`, base64url). @param {string} agree @returns {{ kty: "EC", crv: "P-256", x: string, y: string } | null} */
export function jwkOfAgree(agree) {
  let pt;
  try { pt = unb64(agree); } catch { return null; }
  if (pt.length !== 65 || pt[0] !== 4) return null;
  return { kty: "EC", crv: "P-256", x: b64(pt.subarray(1, 33)), y: b64(pt.subarray(33, 65)) };
}

/**
 * Every device that may read a chat: this device, and each device of each participant that carries an agreement key on its identity list entry (spaces.identity.state { person }: { entries: [{ eid, kind, agree? }] }).
 * A participant with no device that can agree is named, because their chat would be unreadable to them.
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<any>} call @param {readonly string[]} people person ids @param {{ holder: string, jwk: any }} me
 * @returns {Promise<{ holders: Record<string, any>, without: string[] }>}
 */
export async function holdersFor(call, people, me) {
  /** @type {Record<string, any>} */ const holders = { [me.holder]: me.jwk };
  /** @type {string[]} */ const without = [];
  for (const person of people) {
    /** @type {any} */ let state = null;
    try { state = await call("spaces.identity.state", { person }); } catch { state = null; } // a list that cannot be read leaves that person without a device here
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    let found = 0;
    for (const e of entries) {
      if (!e || e.kind !== "device" || typeof e.agree !== "string") continue;
      const jwk = jwkOfAgree(e.agree);
      if (!jwk) continue;
      holders[await fingerprint(jwk)] = jwk;
      found++;
    }
    if (!found) without.push(person);
  }
  return { holders, without };
}

/** The ring for a new chat, made on this device: { id, ring } to pass to work.chat.create { id, people, agents, ring }. @param {string} id @param {Record<string, any>} holders */
export async function newChatRing(id, holders) {
  const { doc } = await createRing(id, holders);
  return { id, ring: doc };
}

/**
 * Lend the chat's key to the server for this session: work.chat.keys.begin gives a one-use session key, the ring (work.chat.get .ring) is opened with this device's key, and the keys go back wrapped to the session
 * key (work.chat.keys.finish). The server holds them in memory for agents it allows, and a rotation makes them stale.
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<any>} call @param {string} chat @param {{ holder: string, ecdh: any }} me
 */
export async function lendChatKey(call, chat, me) {
  const begun = await call("work.chat.keys.begin", { chat });
  const got = await call("work.chat.get", { chat });
  const ring = got?.ring;
  if (!ring) throw Object.assign(new Error("This chat has no key to lend."), { code: "no_ring" });
  const keys = await openRing(ring, me.holder, me.ecdh);
  try {
    const bundle = await bundleFor(keys, begun.session_pub);
    await call("work.chat.keys.finish", { request: begun.request, bundle });
    return { epoch: keys.epoch };
  } finally { keys.lock(); }
}

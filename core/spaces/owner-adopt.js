// @ts-check
// The one owner adopt, and the published-key tool every other pairing path calls.
// The adopt runs only after wink's own pairing record names this person. The directory check is assertPublishedKey.

import { assertPublishedKey } from "../../lib/identity/published-key.js";

const str = { type: "string" };
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: true });

/**
 * @param {(name: string, description: string, input: any, run: any, extra?: any) => void} tool
 * @param {{ ctx: { call: Function, log: { warn: Function } }, K: any, dir: { resolveById: Function, resolve: Function }, kv: { put: Function }, onlyModules: Function, refuse: Function, plainKernelError: Function }} d
 */
export function registerOwnerAdopt(tool, d) {
  const { ctx, K, dir, kv, onlyModules, refuse, plainKernelError } = d;

  tool("spaces.identity.confirm-key", "Confirm this person id on the published chain, and the key when one is named. Pairing, adopt and enrol all use this.", obj({ id: str, key: str, full: { type: "boolean" } }, ["id"]), async (/** @type {any} */ i) => {
    await assertPublishedKey(dir, String(i.id), typeof i.key === "string" ? i.key : undefined, { fullDevice: i.full === true });
    return { ok: true, id: String(i.id) };
  }, { internal: true });

  // A server paired to a person's identity has that person's id as its owner, once. The pairing record is checked before the directory, so a stranger is forbidden before any lookup.
  tool("spaces.owner.adopt", "For the pairing module, after it has PROVED the identity: make this home's owner (and its hosted Spaces') the person's identity id. Once only.", obj({ person: str, name: str, key: str, presence_key: obj({ device: str, key_id: str, spki: str, signer: str }, ["device", "key_id", "spki", "signer"]) }, ["person"]), async (/** @type {any} */ i, /** @type {any} */ meta) => {
    onlyModules(meta, ["wink"]);
    const id = String(i.person);
    let rec = null; try { const r = await ctx.call("wink.server.owner", {}); rec = r && r.data ? r.data : null; } catch { rec = null; }
    if (!rec || rec.identity !== id) throw refuse("That is not the identity this server was paired to; give the identity of the person who paired it.", "forbidden");
    if (!/^per_[a-z2-7]{26}$/.test(id)) throw refuse("That is not a person id.", "bad_input");
    await assertPublishedKey(dir, id, typeof i.key === "string" ? i.key : undefined, { fullDevice: typeof i.key === "string" });
    if (!K || typeof K.adoptOwner !== "function") throw refuse("This home has no kernel to change; run this on a server that hosts spaces.", "unavailable");
    { const had = typeof K.ownerClaimed === "function" ? K.ownerClaimed() : null; if (had && had !== id) throw refuse("This server already belongs to another Vyre identity.", "owned_by_other"); }
    let r;
    try { r = await K.adoptOwner(id, { from: K.owner }); } catch (e) { throw plainKernelError(e); }
    const label = typeof i.name === "string" ? i.name.trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
    if (label) { try { const v = await dir.resolve(label); if (v.ok && v.kind === "person" && v.id === id) await kv.put(`person-name/${id}`, label); } catch { /* the name is learned later, when the owner is next verified */ } }
    /** @type {{ enrolled: boolean, reason?: string }} */ let presence = { enrolled: false, reason: "no presence key offered" };
    const pk = i.presence_key;
    if (pk && typeof pk === "object" && typeof K.enrolOwnerKey === "function") {
      try { await K.enrolOwnerKey({ person: id, device: String(pk.device), key_id: String(pk.key_id), spki: String(pk.spki), signer: String(pk.signer), ...(typeof pk.rp === "string" ? { rp: pk.rp } : {}) }); presence = { enrolled: true }; }
      catch (e) { presence = { enrolled: false, reason: String(/** @type {any} */ (e).code || "failed").slice(0, 40) }; ctx.log.warn(`the owner's presence key was not enrolled (${presence.reason})`); }
    }
    return { owner: r.owner, previous: r.previous, changed: r.changed, presence };
  }, { internal: true });
}

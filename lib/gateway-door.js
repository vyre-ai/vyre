// @ts-check
// The one way a module's tool reaches a Space's gateway for a person's call (the app's Store adapter: records.*, tasks.*): the Space the call names (an id or a name; none means the home's own),
// that Space's gateway, and the chain of THE CALL ITSELF (`ctx.kernel.chainIn`): a session token's, or the person's own from the facts the daemon proved about the connection. Never a chain from
// the body, never the module's service chain: a call that proved no person gets a refusal, so nothing here ever acts for a caller who is not one. Every decision is the kernel's.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
import { withProof } from "./remote-proof.js";
const SPACE_ID = /^spc_[a-z2-7]{12}$/;

/** @param {any} ctx the module's context (needs.kernel declared) */
export function createDoor(ctx) {
  /** @param {any} input @returns {Promise<string>} the Space's id */
  async function spaceOf(input) {
    const named = input && typeof input.space === "string" && input.space ? input.space : "";
    // No space named: the space the person made is the one they mean (the home's own space stays internal). Two or more made and none named is a question for the app, never a guess.
    if (!named && ctx.kernel && typeof ctx.kernel.owner === "string") {
      let r; try { r = /** @type {any} */ (await ctx.call("spaces.self", { person: ctx.kernel.owner })); } catch { r = null; }
      const d = r && r.data;
      if (d && d.space && SPACE_ID.test(String(d.space.id))) return String(d.space.id);
      if (d && Array.isArray(d.spaces) && d.spaces.length > 1) throw Object.assign(refuse(`Say which space: ${d.spaces.map((/** @type {any} */ x) => x.name || x.id).join(", ")}.`, "needs_space"), { spaces: d.spaces });
    }
    const s = named || (ctx.kernel && ctx.kernel.space);
    if (!s) throw refuse("this build runs without its kernel", "unavailable");
    if (SPACE_ID.test(s)) return s;
    // a name (alex.vyre.run, harlow) is looked up by the spaces module for the home's owner; anyone else names a Space by its id
    let r; try { r = /** @type {any} */ (await ctx.call("spaces.self", { person: ctx.kernel.owner, space: s })); } catch { r = null; }
    const id = r && r.data && r.data.space && r.data.space.id;
    if (!id || !SPACE_ID.test(id)) throw refuse("no such space", "not_found");
    return String(id);
  }
  return {
    spaceOf,
    /**
     * @param {any} input @param {any} meta
     * @returns {Promise<{ space: string, gateway: any, surfaces: any, chain: any, proof: any }>}
     */
    async open(input, meta) {
      if (!ctx.kernel || typeof ctx.kernel.chainIn !== "function") throw refuse("this build runs without its kernel", "unavailable");
      const space = await spaceOf(input);
      let h; try { h = await ctx.kernel.for(space); } catch { h = null; }
      if (!h || !h.gateway) throw refuse("no such space", "not_found");
      // A Space hosted on a paired SERVER is reached through the remote kernel (core/daemon remoteFor): the server mints the chain from the device it proved, so none is built for it here and the chain
      // argument is not sent. What is still checked here is the part only this device can: the call comes from a signed-in person (this home's own chain), never a model or a stranger.
      if (h.hosted === false) {
        const own = typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta).catch(() => null) : null;
        const hop = own && Array.isArray(own.hops) ? own.hops[0] : null;
        if (!hop || !hop.actor || hop.actor.kind !== "person" || own.hops.length !== 1) throw refuse("this call is not from a signed-in person. Sign in with `vyre signin` (approve on your phone)", "denied");
        const proof = typeof ctx.kernel.proofFrom === "function" ? ctx.kernel.proofFrom(meta) : undefined;
        // The person's proof for THIS call rides to the home when it asks for one (its challenge is checked against the call before anything is signed): the remote gateway runs inside it.
        return { space, gateway: carrying(h.gateway, proof), surfaces: h.surfaces, chain: own, proof, remote: true, kernelProof: meta && meta.kernel_proof && typeof meta.kernel_proof === "object" ? meta.kernel_proof : null };
      }
      const chain = await ctx.kernel.chainIn(space, meta).catch((/** @type {any} */ e) => { throw refuse(e && e.code === "not_found" ? "no such space" : "this connection is not a member of that space", e && e.code === "not_found" ? "not_found" : "denied"); });
      const first = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
      if (!first || !first.actor || first.actor.kind !== "person") throw refuse("this call is not from a signed-in person. Sign in with `vyre signin` (approve on your phone)", "denied");
      return { space, gateway: h.gateway, surfaces: h.surfaces, chain, proof: rawProof(ctx.kernel, meta) };
    },
  };
}

/** The presence proof the surface sent beside the request, ITSELF: ctx.kernel.proofFrom answers the `{ presence }` option a grants call takes (or `{}`), but the tools behind the door hand the proof to the task store, the seal and
 *  the drive as the proof (or wrap it themselves), so a wrapper here made every decision answer needs_presence whatever the person signed. undefined when nothing was sent. @param {any} kernel @param {any} meta */
function rawProof(kernel, meta) {
  if (!kernel || typeof kernel.proofFrom !== "function") return undefined;
  const given = kernel.proofFrom(meta);
  return given && typeof given === "object" && given.presence ? given.presence : undefined;
}

/** A remote gateway whose every call runs with the caller's proof in reach of the remote kernel's signer. @param {any} gw @param {any} proof */
function carrying(gw, proof) {
  if (!proof || proof.presence === undefined) return gw;
  const wrap = (/** @type {any} */ o) => {
    if (typeof o === "function") return (/** @type {any[]} */ ...a) => withProof(proof, () => o(...a));
    if (o && typeof o === "object") { const r = /** @type {any} */ ({}); for (const [k, v] of Object.entries(o)) r[k] = wrap(v); return Object.freeze(r); }
    return o;
  };
  return wrap(gw);
}

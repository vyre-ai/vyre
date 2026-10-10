// @ts-check
// The one way a module's tool reaches a Space's gateway for a person's call (the app's Store adapter: records.*, tasks.*): the Space the call names (an id or a name; none means the home's own),
// that Space's gateway, and the chain of THE CALL ITSELF (`ctx.kernel.chainIn`): a session token's, or the person's own from the facts the daemon proved about the connection. Never a chain from
// the body, never the module's service chain: a call that proved no person gets a refusal, so nothing here ever acts for a caller who is not one. Every decision is the kernel's.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
import { withProof } from "./remote-proof.js";
const SPACE_ID = /^spc_[a-z2-7]{12}$/;

/** @param {any} ctx the module's context (needs.kernel declared) */
export function createDoor(ctx) {
  /** The spaces a person is in on this home: { space, name }, or none when the spaces module cannot say. @param {string} person @returns {Promise<{ space: string, name?: string }[]>} */
  async function spacesOf(person) {
    let r; try { r = /** @type {any} */ (await ctx.call("spaces.merge-list", { person })); } catch { r = null; }
    return r && r.data && Array.isArray(r.data.spaces) ? r.data.spaces : [];
  }
  /** @param {any} input @returns {Promise<string>} the Space's id */
  async function spaceOf(input) {
    const named = input && typeof input.space === "string" && input.space ? input.space : "";
    // No space named: the space the person made is the one they mean (the home's own space stays internal). Two or more made and none named is a question for the app, never a guess.
    if (!named && ctx.kernel && typeof ctx.kernel.owner === "string") {
      // the spaces the home's person is in, from the spaces module's own member lists: a server that hosts a team's space holds no identity of its own, so "who is this device" is not asked
      const mine = await spacesOf(ctx.kernel.owner);
      if (mine.length === 1 && SPACE_ID.test(String(mine[0].space))) return String(mine[0].space);
      if (mine.length > 1) {
        const listed = mine.map(x => x.name || x.space).join(", ");
        throw Object.assign(refuse(`Say which space: ${listed}.`, "needs_space"), { spaces: mine.map(x => ({ id: x.space, name: x.name })) });
      }
    }
    const s = named || (ctx.kernel && ctx.kernel.space);
    if (!s) throw refuse("this build runs without its kernel (ask whoever runs this box for a build that has one)", "unavailable");
    if (SPACE_ID.test(s)) return s;
    // a name (alex.vyre.run, harlow) is looked up by the spaces module for the home's owner; anyone else names a Space by its id
    const bare = s.replace(/\.vyre\.run$/, "");
    const hit = (await spacesOf(ctx.kernel.owner)).find(x => x.space === s || x.name === s || String(x.name || "").replace(/\.vyre\.run$/, "") === bare);
    if (!hit || !SPACE_ID.test(String(hit.space))) throw refuse("no such space (spaces.list shows the ones you are in)", "not_found");
    return String(hit.space);
  }
  return {
    spaceOf,
    /**
     * @param {any} input @param {any} meta
     * @returns {Promise<{ space: string, gateway: any, surfaces: any, chain: any, proof: any }>}
     */
    async open(input, meta) {
      if (!ctx.kernel || typeof ctx.kernel.chainIn !== "function") throw refuse("this build runs without its kernel (ask whoever runs this box for a build that has one)", "unavailable");
      const space = await spaceOf(input);
      let h; try { h = await ctx.kernel.for(space); } catch { h = null; }
      if (!h || !h.gateway) throw refuse("no such space (spaces.list shows the ones you are in)", "not_found");
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
      if (!first || !first.actor || first.actor.kind !== "person") {
        // Say why in the log (never to the caller): the first hop the kernel built for this call and whether the daemon proved any person facts for it. A device that is paired and signed in but not enrolled in this Space lands here.
        try { const say = ctx.log && (ctx.log.warn || ctx.log); if (typeof say === "function") say.call(ctx.log, `gateway door: refused ${String((meta && meta.caller) || "?")} in ${space}: first hop ${first && first.actor ? first.actor.kind : "none"}, person facts ${meta && meta.kernelFacts ? "proved" : "none"}${meta && meta.kernelFacts && meta.kernelFacts.kind === "device" ? ` (device ${String(meta.kernelFacts.device_key_id).slice(0, 8)}, so check its enrolment in this Space)` : ""}`); } catch { /* the refusal stands */ }
        throw refuse("this call is not from a signed-in person. Sign in with `vyre signin` (approve on your phone)", "denied");
      }
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

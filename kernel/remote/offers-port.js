// kernel/remote/offers-port.js: the Wink module's `offers` port (core/wink/pairing.js) over the kernel's own offers store (`grants.offers`), the ONLY store of
// compute offers. Wink asks and sets by (space, device); the kernel wants a member, the computer's key, the caller's chain and a fresh presence proof, so Wink
// passes those as the last argument:
//   get(space, device, { member, device_key })                      -> { space_allows, member_accepts }
//   set(space, device, side, on, { member, device_key, meta })      side "space" | "member"; meta is the tool call's meta (token, kernel_proof)
// The chain is the caller's (`kernel.chain(meta)`) and the proof is `kernel.proofFrom(meta)`, checked by the one verifier; this file decides nothing.
import { KernelError } from "../core/errors.js";

const SIDE = Object.freeze({ space: "space_allows", member: "member_accepts" });

/** @param {{ space: string, grants?: any, for?: (id: string) => any, chain: (meta: any) => Promise<any>, proofFrom: (meta: any) => any }} kernel the module's ctx.kernel */
export function createOffersPort(kernel) {
  /** @param {string} space */
  const offersOf = space => {
    const g = space === kernel.space ? kernel.grants : (kernel.for ? kernel.for(space).gateway?.grants : null);
    if (!g || !g.offers) throw new KernelError("unavailable", "this home does not host that space");
    return g.offers;
  };
  return Object.freeze({
    /** @param {string} space @param {string} device @param {{ member?: string, device_key?: string }} [x] */
    async get(space, device, x = {}) {
      if (!x || typeof x.member !== "string" || !x.member) return { space_allows: false, member_accepts: false };
      const { spaceAllows, memberAccepts } = offersOf(space).active({ member: x.member, device, ...(x.device_key ? { device_key: x.device_key } : {}) });
      return { space_allows: spaceAllows, member_accepts: memberAccepts };
    },
    /** @param {string} space @param {string} device @param {"space" | "member"} side @param {boolean} on @param {{ member?: string, device_key?: string, meta?: any }} [x] */
    async set(space, device, side, on, x = {}) {
      const kside = /** @type {"space_allows" | "member_accepts"} */ (SIDE[side]);
      if (!kside || !x || typeof x.member !== "string" || !x.member) throw new KernelError("bad_input", "an offer needs a side and the member whose computer it is");
      const offers = offersOf(space);
      const chain = await kernel.chain(x.meta);
      const opt = kernel.proofFrom(x.meta);
      // The Space's side covers the member's computers by id; the member's side is bound to the one computer's key.
      const at = { side: kside, member: x.member, device };
      const have = offers.find(at);
      if (!on) { if (have) await offers.unoffer(chain, have.id, opt); return; }
      if (have) return;
      await offers.offer(chain, { ...at, ...(kside === "member_accepts" ? { device_key: x.device_key } : {}) }, opt);
    },
  });
}

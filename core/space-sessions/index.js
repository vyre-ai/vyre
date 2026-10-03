// core/space-sessions/index.js: sessions that belong to one Space. A factory over ports, so it runs under a fake kernel today and
// under the real gateway and Wink later. Every call authorizes under the session's own space; a chain from another space sees nothing.
import { createPlacement } from "./place.js";
import { createRunner } from "./checkpoint.js";
import { createContinue } from "./continue.js";
import { openWorkcopy } from "./workcopy.js";
import { mintUuid } from "../../kernel/core/ids.js";

export { createPlacement, createRunner, createContinue, openWorkcopy };
export { createSpaceStore } from "./spacestore.js";
export { offerGrant, acceptGrant, RUN_OFFER_ACTION, RUN_ACCEPT_ACTION } from "./place.js";

/** @param {{ space: string, authorize(i: { chain: any, action: string, resource: string }): Promise<{ effect: string }>, placement: any, clock?: () => number, sessions?: Map<string, any> }} cfg */
export function createSpaceSessions(cfg) {
  const rows = cfg.sessions || new Map();
  const clock = cfg.clock || Date.now;
  const urn = (/** @type {string} */ id) => `vyre://${cfg.space}/session/${id}`;
  const mine = (/** @type {any} */ chain) => chain && chain.space === cfg.space;
  const ok = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ id) => mine(chain) && (await cfg.authorize({ chain, action, resource: urn(id) })).effect === "allow";

  return Object.freeze({
    /** @param {{ chain: any, person: any, device?: string, title?: string, first_context?: string, from?: any }} q */
    async create(q) {
      if (!mine(q.chain)) throw Object.assign(new Error("not found"), { code: "not_found" });
      const id = mintUuid(clock());
      if (!(await ok(q.chain, "sessions.create", id))) throw Object.assign(new Error("not found"), { code: "not_found" });
      const place = await cfg.placement.placeSession({ space: cfg.space, person: q.person, device: q.device, session_owner: q.person });
      const s = Object.freeze({ id, space: cfg.space, owner: q.person, title: q.title || "Session", where: place.where, device: place.where === "device" ? q.device : undefined, why: place.reason, first_context: q.first_context, from: q.from, created_at: clock() });
      rows.set(id, s);
      return s;
    },
    async get(/** @type {any} */ chain, /** @type {string} */ id) { const s = rows.get(id); return s && s.space === cfg.space && (await ok(chain, "sessions.read", id)) ? s : null; },
    async list(/** @type {any} */ chain) { const out = []; for (const s of rows.values()) if (await ok(chain, "sessions.read", s.id)) out.push(s); return out; },
  });
}

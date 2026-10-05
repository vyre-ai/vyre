// @ts-check
// homecall: the tools for one home to pull from another (a project move between two servers; lib/spaces/move-pull.js is the protocol, core/wink/homemove.js the door's side).
//
//   wink.home-move.open   the SOURCE home's spaces module says a move is open for a Space: another home may now ask `spaces.moves.pull` for it, until `expires` or wink.home-move.close
//   wink.home-move.close  the move is finished or cancelled: the door shuts at once
//   wink.home.call       the TARGET home's spaces module: one request to the source home by its relay route and box key, answered with the tool's data or its error code
//
// All three are for modules (the spaces module), never for a model, an agent or a device. The call dials through the relay: a Noise channel with a throwaway key, the box key pinned (the source
// Space's directory record names the route and the box key), one peer stream, one request at a time. A direct path through the source's public gate is not used for a move yet.
import { connect as realConnect } from "../../relay/client/client.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";
import { peerSession, streamPipe } from "./node/peer-wire.js";
import { HOME_TOOL } from "./homemove.js";
import { PEER_HOME } from "./serverlink.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const str = { type: "string" };
const obj = (/** @type {any} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const ROUTE = /^[A-Za-z0-9_-]{8,128}$/;
const SPACE = /^[A-Za-z0-9_-]{1,64}$/;
/** Callers that may use these: the spaces module, or the daemon. Never a model, an agent, a device or a hook. @param {any} meta @param {string} what */
function modulesOnly(meta, what) {
  const c = String((meta && meta.caller) || "");
  if ((meta && meta.agent) || !/^module:(spaces|vyred)$/.test(c)) throw fail("denied", `${what} is for the spaces module`);
}

/** A way to reach another home: one kept relay connection per call, closed when the call is done. @param {{ relayConnect?: any, log?: (m: string) => void, openMs?: number, callMs?: number }} o */
export function createHomeCaller(o = {}) {
  const log = o.log || (() => {});
  return {
    /** @param {{ relay: string, route: string, box: string, tool: string, input: any }} q */
    async call(q) {
      if (q.tool !== HOME_TOOL) throw fail("denied", "a home may only be asked for a move's pull");
      const input = q.input;
      if (!input || typeof input !== "object" || !SPACE.test(String(input.space)) || typeof input.request !== "object" || input.request === null) throw fail("bad_input", "a pull is { space, request }");
      if (!ROUTE.test(String(q.route)) || !q.box || !/^wss?:\/\//.test(String(q.relay))) throw fail("bad_input", "a pull names the relay, the route and the box key of the source home");
      let k = null;
      const keyStore = { get: async () => k, set: async (/** @type {any} */ v) => { k = v; } };
      const conn = (o.relayConnect || realConnect)({ relay: String(q.relay), route: String(q.route), box: String(q.box), name: "a home", crypto: nodeCrypto(), keyStore, homeMove: true, backoff: { min: 500, max: 2000 } });
      const done = () => { try { conn.close(); } catch { /* going down */ } };
      try {
        const chan = await Promise.race([conn.ready(), new Promise((_, rej) => setTimeout(() => rej(fail("unavailable", "the source home did not answer through the relay")), o.openMs ?? 10_000).unref?.())]);
        const s = chan.open({ peer: "wink", space: PEER_HOME, pull: { space: String(input.space) } });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { s.reset("no answer"); reject(fail("unavailable", "the source home did not accept the stream")); }, o.openMs ?? 10_000);
          s.onhead = (/** @type {any} */ x) => { clearTimeout(timer); x && x.status === 200 ? resolve(undefined) : reject(fail(x && x.status === 429 ? "rate_limited" : "denied", `the source home refused the stream (${x && x.status})`)); };
          s.onreset = (/** @type {any} */ why) => { clearTimeout(timer); reject(fail("unavailable", String(why || "reset"))); };
        });
        const session = peerSession(streamPipe(s));
        try { return await session.call(HOME_TOOL, { space: String(input.space), request: input.request }, { timeoutMs: o.callMs ?? 60_000 }); }
        finally { try { session.close("done"); } catch { /* closed */ } }
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        log(`wink home: pull failed (${code || "error"})`);
        throw code ? e : fail("unavailable", String(/** @type {Error} */ (e).message || e).slice(0, 200));
      } finally { done(); }
    },
  };
}

/** @param {any} ctx @param {{ moves: ReturnType<typeof import("./homemove.js").createHomeMoves>, caller?: ReturnType<typeof createHomeCaller>, relayUrl?: () => string }} d */
export function registerHomeMove(ctx, d) {
  const caller = d.caller || createHomeCaller({ log: m => ctx.log(m) });
  ctx.tool("wink.home-move.open", {
    internal: true,
    description: "The source home's spaces module opens a move for a Space: another home may then ask this home for the move's pull (spaces.moves.pull) until `expires` (a time in ms) or wink.home-move.close. Modules only.",
    input: obj({ space: str, move_id: str, to: str, expires: { type: "number" } }, ["space", "move_id", "expires"]),
    run: async (input, meta = {}) => { modulesOnly(meta, "opening a move"); return d.moves.open(input); },
  });
  ctx.tool("wink.home-move.close", {
    internal: true,
    description: "Closes a move opened with wink.home-move.open: the door shuts at once. Modules only.",
    input: obj({ move_id: str }, ["move_id"]),
    run: async (input, meta = {}) => { modulesOnly(meta, "closing a move"); return d.moves.close(input); },
  });
  ctx.tool("wink.home.call", {
    internal: true,
    description: "The target home's spaces module sends one request to another home through the relay and answers its data or its error code (not_found, denied, bad_input, rate_limited, plan_changed, too_large, unavailable). Only spaces.moves.pull, one request at a time. `route` and `box` are the source Space's directory record (the home's relay route and its box key); `relay` defaults to this home's own relay. Modules only.",
    input: obj({ route: str, box: str, relay: str, tool: str, input: { type: "object" } }, ["route", "box", "tool", "input"]),
    run: async (input, meta = {}) => {
      modulesOnly(meta, "calling another home");
      const relay = String(input.relay || (d.relayUrl ? d.relayUrl() : ""));
      return caller.call({ relay, route: input.route, box: input.box, tool: input.tool, input: input.input });
    },
  });
}

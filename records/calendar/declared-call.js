// @ts-check
// The sync's `call(op, input, extra)` on top of a transport: build the op's request from the connector declaration (checked against the op's declared shapes), hand it to `send`, and give
// back { status, body } with the body parsed. `send` is the vault's route in the daemon (core/daemon/calendar-sync.js) and a fake Google in the tests.
import { buildRequest } from "../connectors/format.js";

/**
 * @param {import("../connectors/format.js").Declaration} decl
 * @param {(req: { method: string, path: string, query?: any, body?: any, headers?: Record<string, string> }, extra?: any) => Promise<{ status: number, body?: any }>} send
 */
export function callThrough(decl, send) {
  return async (/** @type {string} */ op, /** @type {any} */ input, /** @type {any} */ extra) => {
    const res = await send(buildRequest(decl, op, input || {}), extra);
    return { status: res.status, body: res.body };
  };
}

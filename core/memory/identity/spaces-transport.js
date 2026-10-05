// @ts-check
// The five transport calls of core/memory/identity/remote-backend.js over the team server's per-member storage (the spaces module's `spaces.storage.*` tools, which act only in the caller's own folder
// of the hosted space). `call(tool, input)` runs a tool as the person (a module's ctx.call under the person's chain, or the app's own call); `space` is the hosted space id.
import { toB64, fromB64 } from "../../../lib/databox.js";

/** @param {(tool: string, input: any) => Promise<any>} call @param {string} space @returns {import("./remote-backend.js").Transport} */
export function spacesTransport(call, space) {
  const run = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const r = await call(tool, { space, ...input });
    if (r && r.error) throw Object.assign(new Error(String(r.error.message || r.error)), { code: r.error.code || "unavailable" });
    return r && "data" in r ? r.data : r;
  };
  return {
    async list(prefix) { const r = await run("spaces.storage.list", { prefix }); return Array.isArray(r && r.entries) ? r.entries.map((/** @type {any} */ e) => ({ name: String(e.name), sha: String(e.sha), size: Number(e.size) || 0 })) : []; },
    async get(name) { const r = await run("spaces.storage.get", { name }); return r && typeof r.data === "string" ? fromB64(r.data) : null; },
    // every write is a compare-and-set: ifMatch is the sha this device last saw, or null for "must not exist"
    async put(name, bytes, { ifMatch }) { const r = await run("spaces.storage.put-if", { name, data: toB64(bytes), expected: ifMatch }); return { ok: Boolean(r && r.ok) }; },
    async delete(name, { ifMatch }) { const r = await run("spaces.storage.delete", { name, ...(ifMatch ? { expected: ifMatch } : {}) }); return { ok: Boolean(r && r.ok !== false) }; },
  };
}

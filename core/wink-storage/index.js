// @ts-check
// wink-storage: the module around core/wink/storage. It wires the real vault, the relay's space id and the grant table, registers the tools and
// runs the slow reachability check. The tool prefix is this module's own name (a module may only name tools after itself); the Wink module
// can mount the same tools as wink.storage.* with registerStorageTools(ctx, storage, "wink.storage"). See docs/work/tailnet.md, "Wink storage".

import crypto from "node:crypto";
import { createStorageDevices, registerStorageTools, MIGRATIONS } from "../wink/storage/index.js";
import { storageGrants } from "../wink/storage/grants.js";
import { spaceIdOf, base32 } from "../wink/grants.js";

const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    if (ctx.config.role !== "box") return { async stop() {} };
    ctx.store.migrate(MIGRATIONS);
    let routeId = "";
    const route = async () => {
      if (routeId) return routeId;
      const r = /** @type {any} */ (await ctx.call("relay.route.id", {}));
      if (!r || !r.data || !r.data.route) throw Object.assign(new Error("this server has no relay route yet; turn the relay on first"), { code: "unavailable" });
      return (routeId = String(r.data.route));
    };
    let spaceCache = "";
    const space = async () => (spaceCache = spaceIdOf(await route()));
    const grants = storageGrants({ ctx, space: () => spaceCache });
    const data = (/** @type {any} */ r) => { if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r && r.data; };

    // The vault: values go in through vault.put and come back only through the module door (ctx.vault.fetch, declared as per-storage).
    const vault = {
      put: async (/** @type {any} */ o) => { data(await ctx.call("vault.put", { name: o.name, kind: "env-set", description: o.description, fields: o.fields, grants: ["wink-storage"] })); },
      fetch: async (/** @type {string} */ name, /** @type {string} | undefined */ field) => ctx.vault.fetch(name, field ? { field } : {}),
      remove: async (/** @type {string} */ name) => { data(await ctx.call("vault.delete", { name })); },
    };
    // This box's owner is the one person who can call these tools, and the box's own space is the one space they run here. A kernel with roles
    // (ctx.kernel.roles) decides for every other space.
    const admin = {
      self: async () => ({ kind: "person", id: `per_${base32(sha(`person\n${await route()}`), 26)}`, space: await space() }),
      isAdmin: async (/** @type {string} */ person, /** @type {string} */ sp) => {
        if (ctx.kernel && ctx.kernel.roles && ctx.kernel.roles.isAdmin) return Boolean(await ctx.kernel.roles.isAdmin(person, sp));
        return sp === (await space());
      },
      nameOf: async (/** @type {any} */ o) => (o.kind === "person" ? "Personal" : String((ctx.config && ctx.config.name) || "this space")),
    };
    const storage = createStorageDevices({ ctx, grants, vault, admin, space });
    registerStorageTools(ctx, storage, "wink-storage");
    const stopTimer = storage.startTimer();
    return { async stop() { stopTimer(); } };
  },
};

// @ts-check
// Naming a server's own Space (spaces.name-here, spaces.publish-server-space): the box takes the name it was given, and the paired server is listed as serving it. Split out of index.js; nothing changed in behaviour.
//   serveName   says "space.named": the names module hears it from this module alone and runs names.serve's own step (config.name and network.via, which the public gate, names.status and hooks.status read).
//               Without it a server whose Space is named here holds the name in the directory and serves nothing at <name>.vyre.run.
//   listServer  the paired server's route (the one it signs its own directory calls with) is listed as serving the named Space, signed by this person's own entry: the Space's owner is the only one who may.
//   startRepair a server named by an earlier build (home-named is kept, but the box never started serving the name) takes it ten seconds after start, only when names.status says it holds none.

/**
 * @param {{ ctx: any, kv: any, emit: (type: string, payload: any) => void, me: () => any, dir: any, ownerSigner: () => Promise<any>, refuse: (m: string, c: string) => Error, plainDirectory: (e: any) => string }} d
 */
export function nameServe({ ctx, kv, emit, me, dir, ownerSigner, refuse, plainDirectory }) {
  const serveName = (/** @type {string} */ label) => emit("space.named", { name: label });
  return {
    serveName,
    listServer: async (/** @type {{ name: string, server: string }} */ a) => {
      const who = me();
      const ch = /** @type {any} */ (await ctx.call("wink.server.channel", { device: a.server, identity: who.id }).catch(() => null));
      const c = ch && ch.data && !ch.error ? ch.data.channel : null;
      if (!c || !c.route) throw refuse("This server's route is not known here. Check that it is online in Devices, then run spaces.server.list again.", "unavailable");
      try { await dir.server(a.name, String(c.route), await ownerSigner()); } catch (e) { throw refuse(`The names directory did not list the server for ${a.name} (${plainDirectory(e)}). Run spaces.server.list again after fixing the cause.`, /** @type {any} */ (e).code || "unavailable"); }
    },
    startRepair() {
      const t = setTimeout(() => {
        void (async () => {
          const named = await kv.get("home-named").catch(() => null);
          if (!named || typeof named.name !== "string" || !named.name) return;
          const st = /** @type {any} */ (await ctx.call("names.status", {}).catch(() => null));
          if (st && st.data && !st.data.name) serveName(named.name);
        })().catch(() => {});
      }, 10_000);
      if (typeof t.unref === "function") t.unref();
    },
  };
}

// @ts-check
// `server` on a server-side space tool, and where each paired server is reached. Kept out of index.js (a listed file that may not grow): one factory, given what index.js already holds.
//
// onChosenServer: this device (the Mac, whose own daemon is the app's door) asks ONE chosen paired server to run the tool, over the owner's paired session; the SERVER's own owner check judges it. Order matters:
// the caller is proved the owner HERE first (so a member, an agent or an unproven caller never causes a remote call), then the server is found by exact id among the servers this person still has paired. A server
// that is not found is refused with a next step and NEVER falls back to this home's own space (that would name the wrong one). `server` is not forwarded (nothing chains), and only `keys` go.

/** @param {{ ctx: any, identity: any, K: any, remoteCall: (device: string, tool: string, input: any, meta: any) => Promise<any>, refuse: (message: string, code: string) => Error }} d */
export function chosenServer({ ctx, identity, K, remoteCall, refuse }) {
  const who = () => { try { return identity.status(); } catch { return null; } };
  /** The name of a server this person paired and still has paired, by its exact id; null for anything else (unknown, removed, someone else's). Never a guess. @param {string} id */
  const pairedServerName = async id => {
    const w = who();
    if (!w || !w.exists || !w.id) return null;
    try { const r = await ctx.call("wink.server.paired", { device: id, identity: w.id }); return r && r.data && !r.error && r.data.paired === true ? String(r.data.name || id) : null; } catch { return null; }
  };
  /** @param {string} tool @param {Record<string, any>} i @param {any} meta @param {string[]} keys @param {string} deny */
  const onChosenServer = async (tool, i, meta, keys, deny) => {
    if (!K || typeof K.owner !== "string") throw refuse("This home has no kernel of its own to act from; run this on the computer that holds your name.", "unavailable");
    let person = null;
    try { const c = await K.chain(meta); const h = c && c.hops && c.hops.length === 1 ? c.hops[0].actor : null; person = h && h.kind === "person" ? String(h.id) : null; } catch { person = null; }
    if (!person || person !== K.owner) throw refuse(deny, "forbidden");
    const id = typeof i.server === "string" ? i.server : "";
    if (!id) throw refuse("Say which server this is for. Pick one in Settings, Servers. Nothing was changed.", "bad_input");
    if (!(await pairedServerName(id))) throw refuse("That server is not paired with you, or was removed. Add it in Settings, Servers, then try again. Nothing was changed.", "server_not_paired");
    return remoteCall(id, tool, Object.fromEntries(keys.filter(k => i[k] !== undefined).map(k => [k, i[k]])), meta);
  };
  /**
   * The servers list: `online` is null (whether a server is reachable now is not known without opening its session); `channel` is where it is reached (relay, route, box: no secret), so a screen that names its
   * Space can say where its home is; absent when Wink has no record of it. @param {any[]} rows
   */
  const serversWithChannel = async rows => {
    const w = who();
    const out = [];
    for (const r of rows) {
      let channel = null;
      if (w && w.exists && w.id) { try { const c = await ctx.call("wink.server.channel", { device: String(r.id), identity: w.id }); channel = c && c.data && !c.error && c.data.channel ? c.data.channel : null; } catch { channel = null; } }
      out.push({ id: String(r.id), name: String(r.name), online: null, ...(channel ? { channel } : {}) });
    }
    return out;
  };
  return { onChosenServer, serversWithChannel };
}

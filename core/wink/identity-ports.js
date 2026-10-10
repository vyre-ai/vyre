// @ts-check
// The three identity ports Wink needs from the home (every one by the spaces module's own internal tools, read live on each call, never cached), so that no composition root has to pass them:
//   identityEntry(identity, eid)  the entry on that identity's list, { eid, kind, pub, identity }, or null: checks the proof of a server installed with `--pair-to` (Q-3)
//   signIdentity(message)         this device's signature with a key on its own identity list, { eid, sig }, or null: sent when this app adopts a server (Q-3)
//   network                       { entry(eid), self() } for `vyre doctor`'s Wink checks: a device on this space's list, and this device's own identity
// With the spaces module absent, or a tool refusing, each answers null (a `--pair-to` is then refused plainly, "cannot check who is asking"; the doctor says "unknown"): nothing is guessed.

/** @param {{ call: (tool: string, input: any) => Promise<any>, space: () => Promise<string> | string }} o */
export function identityPorts(o) {
  const ask = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    try { const r = await o.call(tool, input); return r && !r.error ? (r.data !== undefined ? r.data : r) : null; } catch { return null; }
  };
  return {
    /** @param {string} identity @param {string} eid */
    identityEntry: async (identity, eid, claimedName, pin) => {
      let st = await ask("spaces.identity.state", { person: identity });
      let entries = st && Array.isArray(st.entries) ? st.entries : [];
      // a server that has never seen this identity: its chain by the claimed Vyre name, read from the directory and kept only when the chain is this id's; an unreachable directory is thrown, not "no such entry"
      if (!entries.length && claimedName) {
        let r;
        try { r = await o.call("spaces.identity.lookup", { name: claimedName, id: identity, ...(pin ? { pin } : {}) }); } catch (e) { throw Object.assign(new Error("the directory could not be reached"), { code: /** @type {any} */ (e).code === "unreachable" ? "unreachable" : "failed" }); }
        // the directory's address itself refused by the guarded client (plain http, a private address) is a refusal with its reason, never "out of reach": a stand-in directory on this machine says so
        if (r && r.error) { const m = String(r.error.message || "lookup failed"); throw Object.assign(new Error(m), { code: r.error.code === "unreachable" ? (/address was refused/.test(m) ? "refused" : "unreachable") : "failed" }); }
        st = r && r.data !== undefined ? r.data : r;
        entries = st && Array.isArray(st.entries) ? st.entries : [];
      }
      const e = entries.find((/** @type {any} */ x) => x && x.eid === eid && x.kind === "device");
      return e && typeof e.pub === "string" ? { eid: String(e.eid), kind: "device", pub: e.pub, identity, ...(e.held ? { held: e.held } : {}), ...(e.alg ? { alg: e.alg, ...(e.rp ? { rp: e.rp } : {}) } : {}), ...(e.enclave ? { enclave: e.enclave } : {}), ...(e.agree ? { agree: e.agree } : {}) } : null;
    },
    /** @param {Uint8Array} message */
    signIdentity: async message => {
      const r = await ask("spaces.identity.sign", { message: Buffer.from(message).toString("base64url") });
      return r && r.eid && r.sig ? { eid: String(r.eid), sig: String(r.sig) } : null;
    },
    network: {
      entry: async (/** @type {string} */ eid) => { const e = await ask("spaces.identity.entry", { space: await o.space(), eid }); return e ? { eid: String(e.eid), kind: String(e.kind), ...(e.identity ? { identity: String(e.identity) } : {}) } : null; },
      self: async () => { const st = await ask("spaces.identity.self", {}); return st && st.id ? { signedIn: true, name: st.label || st.name, id: st.id } : { signedIn: false }; },
    },
  };
}

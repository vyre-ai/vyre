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
    identityEntry: async (identity, eid) => {
      const st = await ask("spaces.identity.state", { person: identity });
      const e = st && Array.isArray(st.entries) ? st.entries.find((/** @type {any} */ x) => x && x.eid === eid && x.kind === "device") : null;
      return e && typeof e.pub === "string" ? { eid: String(e.eid), kind: "device", pub: e.pub, identity } : null;
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

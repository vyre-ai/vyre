// @ts-check
// `wink.lent.revoked`: the Space's home tells this computer, down the connection it holds, that its grant for that Space ended. The runner then stops the Space's sessions and deletes the local work and keys now.
// Only the Space's own home may say so: the message must arrive on the connection to the paired server that hosts that Space, so another server this computer is paired to, or anything else, can neither end
// the grant nor stand in for the home (reviewer-3 NW2-1).
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ call: (tool: string, input: any) => Promise<any>, log: (m: string) => void }} o `call` is the module's registry call (`spaces.server.of`, `runner.revoke`)
 * @returns {(input: any, from: string) => Promise<{ ok: true, revoked: boolean }>} `from` is the paired server the message came from, as this computer knows it
 */
export function lentRevoked({ call, log }) {
  return async (input, from) => {
    const sp = input && typeof input.space === "string" ? input.space : "";
    if (!/^spc_[a-z0-9]{1,40}$/.test(sp)) throw fail("bad_input", "name the space");
    const hosted = await call("spaces.server.of", { space: sp }).catch(() => null);
    if (!from || !hosted || !hosted.data || hosted.data.device !== from) throw fail("denied", "only the server that hosts that space can end this computer's grant for it");
    log(`wink: the home says this computer's grant for ${sp} ended; its sessions stop and the local work is deleted`);
    const r = await call("runner.revoke", { space: sp });
    return { ok: true, revoked: Boolean(r && r.data && r.data.revoked) };
  };
}

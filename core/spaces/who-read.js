// @ts-check
// Who is asking, for a READ only, and a paired device's own entry, on a server that holds no identity of its own.

/**
 * Who is asking, for a READ only. This home's own identity when it has one; else, for a call from a paired device the daemon has proven is the owner's (meta.kernelFacts is built by the daemon from the
 * home's own device record and kernel, never from anything the caller sends), that owner's person id and that device's id. A server that holds no identity of its own is that case: the person's devices
 * hold the keys, the server only knows whose they are. It signs nothing and gives no write: every write keeps `me()`.
 * @param {{ identity: { status: () => any }, me: () => any, kernel: () => any }} o `kernel` is asked each call (the home's kernel handle, or none)
 * @returns {(meta: any) => any}
 */
export function makeWhoRead(o) {
  return meta => {
    let s = null; try { s = o.identity.status(); } catch { s = null; }
    if (s && s.exists && !s.pending) return s;
    const f = meta && meta.kernelFacts;
    const K = o.kernel();
    if (f && f.kind === "device" && typeof f.person === "string" && f.person && typeof f.device_key_id === "string" && f.device_key_id && K && typeof K.space === "string") return { exists: true, id: f.person, eid: f.device_key_id, name: null, viaDevice: true };
    return o.me();
  };
}

/**
 * The device entry `eid` on the person's list. A server with no identity list: the paired device asking about ITSELF is known by the id the daemon proved; it names no other device.
 * @param {() => Promise<any[]>} entries @param {string} eid @param {any} who
 */
export async function deviceEntry(entries, eid, who) {
  let e = null; try { e = (await entries()).find((/** @type {any} */ x) => x.eid === eid && x.kind === "device"); } catch { e = null; }
  return e || (who && who.viaDevice && eid === who.eid ? { eid, kind: "device", label: null } : null);
}

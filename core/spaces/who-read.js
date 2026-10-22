// @ts-check
// Who is asking, for a READ only, and a paired device's own entry, on a server that holds no identity of its own.

/**
 * Who is asking, for a READ only. This home's own identity when it has one; else, for a call from a paired device the daemon has proven is the owner's (meta.kernelFacts is built by the daemon from the
 * home's own device record and kernel, never from anything the caller sends), that owner's person id and that device's id. A server that holds no identity of its own is that case: the person's devices
 * hold the keys, the server only knows whose they are. It signs nothing and gives no write: every write keeps `me()`.
 * @param {{ identity: { status: () => any }, me: () => any, kernel: () => any }} o `kernel` is asked each call (the home's kernel handle, or none)
 * @returns {(meta: any) => any}
 */
/** The home's space id, from the module handle (`.space`) or the kernel object (`.id.space`). @param {any} K */
function spaceOf(K) {
  if (!K) return "";
  if (typeof K.space === "string" && K.space) return K.space;
  return K.id && typeof K.id.space === "string" ? K.id.space : "";
}

/** The home's owner id, from the module handle (`.owner`) or the kernel object (`.id.owner`). @param {any} K */
function ownerOf(K) {
  if (!K) return "";
  if (typeof K.owner === "string" && K.owner) return K.owner;
  return K.id && typeof K.id.owner === "string" ? K.id.owner : "";
}

export function makeWhoRead(o) {
  return meta => {
    let s = null; try { s = o.identity.status(); } catch { s = null; }
    if (s && s.exists && !s.pending) return s;
    const f = meta && meta.kernelFacts;
    const K = o.kernel();
    const space = spaceOf(K);
    if (f && f.kind === "device" && typeof f.person === "string" && f.person && typeof f.device_key_id === "string" && f.device_key_id && space) return { exists: true, id: f.person, eid: f.device_key_id, name: null, viaDevice: true };
    // The owner's own computer: a local or cli call the daemon measured as outside any model, on a home that has a space and an owner, and no identity list of its own.
    // The facts become a device fact for this call so the list can name this computer without asking me() (which is the no_identity the computer was getting).
    const owner = ownerOf(K);
    if (f && f.kind === "socket" && (f.surface === "local" || f.surface === "cli") && f.inside_model_process !== true && space && owner) {
      const proved = { kind: "device", device_key_id: "this-computer", person: owner, path: "socket" };
      try { meta.kernelFacts = proved; } catch { /* a frozen meta still answers below; the list's self flag then keeps the old facts */ }
      return { exists: true, id: owner, eid: "this-computer", name: null, viaDevice: true, here: true };
    }
    return o.me();
  };
}

/**
 * The device entry `eid` on the person's list. A server with no identity list: the paired device asking about ITSELF is known by the id the daemon proved; it names no other device.
 * @param {() => Promise<any[]>} entries @param {string} eid @param {any} who
 */
export async function deviceEntry(entries, eid, who) {
  let e = null; try { e = (await entries()).find((/** @type {any} */ x) => x.eid === eid && x.kind === "device"); } catch { e = null; }
  return e || (who && who.viaDevice && eid === who.eid ? { eid, kind: "device", label: who.here ? "This computer" : null } : null);
}

// kernel/seal/leases.js: key leases for a lent computer's encrypted workspace (DESIGN-local-runner.md section 3). The key that opens a space's workspace on
// one device is derived here, inside the sealing process, from the home's master key, the Space, the device and a revocation epoch: stable while access
// holds (so the workspace reopens), different after a revoke (so a copy of an old key opens nothing new). It is leased for an hour, renewed only while the
// kernel says access holds, and never issued again after a revoke until a person with presence reinstates it. The kernel supplies `allowed` (both
// Offer grants active) on every issue and renew; the process supplies memory: what was revoked survives a restart in the sealed store.
import crypto from "node:crypto";

export const LEASE_MS = 3_600_000;
const STATE = { ref: "seal_leasestate0000000000", space: "_system", record: "_", field: "leases", class: "lease" };
const err = code => Object.assign(new Error(code), { code });

export class Leases {
  /** @param {import("./store.js").SealStore} store @param {() => number} now */
  constructor(store, now = Date.now) {
    this.store = store; this.now = now; this.live = new Map();
    const r = store.read("values", STATE.ref, "_system"); this.st = r ? JSON.parse(r.plaintext) : { epoch: {}, revoked: {} };
  }
  save() { this.store.write("values", STATE, JSON.stringify(this.st)); }
  slot(space, device) { return `${space}\n${device}`; }
  keyFor(space, device) { return Buffer.from(crypto.hkdfSync("sha256", this.store.master, Buffer.alloc(0), `vyre lease key v1 ${space}|${device}|${this.st.epoch[this.slot(space, device)] ?? 0}`, 32)); }
  /** @returns {{ id: string, key: string, ttlMs: number } | { revoked: true }} */
  issue({ space, device, allowed }) {
    if (typeof device !== "string" || !device) throw err("bad_input");
    const s = this.slot(space, device);
    if (!allowed) { this.revoke({ space, device }); return { revoked: true }; }
    if (this.st.revoked[s]) return { revoked: true };
    const id = `lease_${crypto.randomBytes(12).toString("hex")}`;
    this.live.set(id, { space, device, exp: this.now() + LEASE_MS });
    return { id, key: this.keyFor(space, device).toString("base64"), ttlMs: LEASE_MS };
  }
  /** Renewal needs access to still hold. A lease that ran out or is unknown (a restart) is refused as transient: the device asks for a new one, which is checked again. */
  renew({ id, allowed }) {
    const l = this.live.get(id); if (!l) throw err("unknown_lease");
    if (this.st.revoked[this.slot(l.space, l.device)] || !allowed) { this.revoke(l); return { revoked: true }; }
    if (l.exp <= this.now()) { this.live.delete(id); throw err("lease_expired"); }
    l.exp = this.now() + LEASE_MS; return { ttlMs: LEASE_MS };
  }
  /** Access ended: nothing is issued again, live leases stop renewing, and the epoch moves so an old key is of no use after a reinstatement. */
  revoke({ space, device }) {
    const s = this.slot(space, device);
    this.st.revoked[s] = true; this.st.epoch[s] = (this.st.epoch[s] ?? 0) + 1; this.save();
    for (const [id, l] of this.live) if (l.space === space && l.device === device) this.live.delete(id);
    return { revoked: true };
  }
  reinstate({ space, device }) { delete this.st.revoked[this.slot(space, device)]; this.save(); return { reinstated: true }; }
  /** The point of use: a live, unrevoked lease, and nothing else. The credential itself comes from the vault, per request, and is never kept here. */
  check({ id }) {
    const l = this.live.get(id);
    if (!l || l.exp <= this.now() || this.st.revoked[this.slot(l.space, l.device)]) throw err("no_lease");
    return { space: l.space, device: l.device };
  }
}

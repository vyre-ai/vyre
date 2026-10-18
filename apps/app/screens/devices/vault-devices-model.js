// @ts-check
// The Vault's devices on the Settings > Devices page: the person's own devices in the vault group (vault.device.list), the autofill extensions paired to it (vault.devices), and the accounts the firm key
// lets a member act as (vault.me.provisioned). Pure, so Node tests it. Nothing here holds a value of the vault.

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

/** @param {unknown} d vault.device.list's answer ({ devices } or a list) @returns {{ id: string, name: string, role: string, fingerprint: string, line: string }[]} */
export function groupDevices(d) {
  const list = Array.isArray(d) ? d : /** @type {any} */ (d)?.devices;
  return arr(list).filter((x) => str(x.name) || str(x.id)).map((x) => {
    const role = str(x.role) === "storage" ? "Storage" : "Full";
    const fp = str(x.fingerprint);
    return { id: str(x.id) || str(x.name), name: str(x.name) || str(x.id), role, fingerprint: fp, line: [role, fp ? `fingerprint ${fp}` : ""].filter(Boolean).join(", ") };
  });
}

/** @param {unknown} d vault.devices' answer ({ devices }) @param {number} [now] @returns {{ id: string, name: string, revoked: boolean, line: string }[]} */
export function extensions(d, now = Date.now()) {
  const day = (/** @type {number} */ ms) => { const n = Math.max(0, Math.floor((now - ms) / 86_400_000)); return n < 1 ? "today" : n === 1 ? "yesterday" : `${n} days ago`; };
  return arr(/** @type {any} */ (d)?.devices).filter((x) => str(x.id)).map((x) => {
    const revoked = Boolean(x.revoked);
    const state = revoked ? "Revoked" : Number(x.sessions) > 0 ? "Unlocked" : "Locked";
    return { id: str(x.id), name: str(x.name) || str(x.id), revoked, line: [state, Number(x.lastSeen) > 0 ? `seen ${day(Number(x.lastSeen))}` : ""].filter(Boolean).join(", ") };
  });
}

/** @param {unknown} d vault.me.provisioned's answer ({ accounts }) @returns {{ id: string, title: string, line: string }[]} */
export function provisioned(d) {
  return arr(/** @type {any} */ (d)?.accounts).filter((a) => str(a.app)).map((a) => ({ id: `${str(a.app)}:${str(a.account)}`, title: str(a.app), line: str(a.account) ? `Acts as ${str(a.account)}` : "" }));
}

/** A join code is pasted whole; trim it and refuse an empty one. @param {string} code */
export const cleanCode = (code) => String(code || "").replace(/\s+/g, "");

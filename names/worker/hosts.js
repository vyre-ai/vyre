// @ts-check
// Own hosts through the tunnel (ingress v2, team/contracts/ingress.md): a firm's own address for a public page, sign.firm.com, reaches the same box as <name>.vyre.run.
// The proof the host is theirs is the record the certificate needs anyway: a CNAME at _acme-challenge.<host> to <routehash>.acme.<zone>, which only the owner of the domain can set and only this
// box's key can then use. The relay asks `tunnelResolve` as for any name; this file adds the host list a box keeps here and the lookup behind that answer.
import { routeHash, dnsFor } from "./index.js";
import { aliasDomain, dohAnswers } from "./ids.js";

export const HOST_LIMITS = Object.freeze({ perName: 5, perRoute: 20 });

const err = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => ({ status, code, message });

/** The CNAME targets at a name (lower case, no trailing dot), over DNS-over-HTTPS unless the environment gives a resolver. @param {any} env @param {string} name @returns {Promise<string[]>} */
export async function cnameOf(env, name) {
  const clean = (/** @type {unknown[]} */ xs) => xs.map(x => String(x).toLowerCase().replace(/\.$/, ""));
  return clean(typeof env.RESOLVE_CNAME === "function" ? await env.RESOLVE_CNAME(name) : await dohAnswers(env, name, "CNAME"));
}

/** The mixin: methods the Directory gains. `this` is the Directory. */
export const hostOps = {
  /**
   * A box lists an own host it serves. Proven by the CNAME above, read live; limited per name and per route a day.
   * @this {any} @param {any} b @param {{ route: string }} a
   */
  async op_hostAdd(b, a) {
    const rec = await this.owned(b, a);
    const host = aliasDomain(b.host);
    if (!host) throw err(400, "bad_host", "that is not a domain the directory can serve");
    const list = Array.isArray(rec.hosts) ? rec.hosts : [];
    if (list.includes(host)) return { name: rec.name, host, hosts: list };
    const holder = await this.store.get(`th/${host}`);
    if (holder && holder !== rec.name) {
      const other = (await this.idLiveRecord(holder)) || (await this.load(holder));
      if (other && other.state !== "tombstone" && Array.isArray(other.hosts) && other.hosts.includes(host)) throw err(409, "taken", "another name already serves that domain");
    }
    if (list.length >= HOST_LIMITS.perName) throw err(409, "too_many", `at most ${HOST_LIMITS.perName} domains`);
    await this.count("host", a.route, HOST_LIMITS.perRoute, "too many domain checks today; try again tomorrow");
    const want = `${await routeHash(a.route)}.acme.${dnsFor(this.env).zone}`;
    let found;
    try { found = await cnameOf(this.env, `_acme-challenge.${host}`); } catch { throw err(502, "dns_unavailable", "could not read the domain's DNS; try again"); }
    if (!found.includes(want)) throw err(403, "not_proven", `point _acme-challenge.${host} (a CNAME) at ${want}, then try again`);
    rec.hosts = [...list, host];
    await this.saveAny(rec);
    await this.store.put(`th/${host}`, rec.name);
    return { name: rec.name, host, hosts: rec.hosts };
  },

  /** @this {any} @param {any} b @param {{ route: string }} a */
  async op_hostRemove(b, a) {
    const rec = await this.owned(b, a);
    const host = aliasDomain(b.host);
    const list = Array.isArray(rec.hosts) ? rec.hosts : [];
    if (!host || !list.includes(host)) throw err(404, "not_found", "that domain is not served by this name");
    rec.hosts = list.filter((/** @type {string} */ h) => h !== host);
    await this.saveAny(rec);
    if ((await this.store.get(`th/${host}`)) === rec.name) await this.store.delete(`th/${host}`);
    return { name: rec.name, host, hosts: rec.hosts };
  },

  /** The record that serves an own host the box listed here, or null. @this {any} @param {string} host */
  async ownHostRecord(host) {
    const name = await this.store.get(`th/${host}`);
    if (!name) return null;
    const rec = (await this.idLiveRecord(name)) || (await this.load(name));
    return rec && rec.state !== "tombstone" && Array.isArray(rec.hosts) && rec.hosts.includes(host) ? rec : null;
  },
};

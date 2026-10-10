// @ts-check
// Own domains for an app's public pages (ingress v2, team/contracts/ingress.md): a firm's sign.firm.com instead of documents.<name>.vyre.run. This file is the module's own list of them and the
// words around it; the public gate holds the certificate (core/wink/control/publicgate.js) and the directory lists the host (names/worker). The record the person adds is the proof.

export const DOMAIN_MIGRATIONS = [
  `CREATE TABLE appmods_domains (host TEXT PRIMARY KEY, app TEXT NOT NULL, created INTEGER NOT NULL);`,
];

/** The most own domains one server keeps; the directory allows the same number per name. */
export const MAX_DOMAINS = 5;

/**
 * A domain the person typed, made a host name, or null when it cannot be one: letters, digits and dashes, two labels at least, no address, nothing under the zone, no xn-- spelling.
 * @param {unknown} raw @param {string} [zone]
 */
export function cleanHost(raw, zone = "vyre.run") {
  const h = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return null;
  if (h === zone || h.endsWith(`.${zone}`) || h.includes("xn--")) return null;
  return h;
}

/**
 * The list over the module's database.
 * @param {{ prepare(sql: string): { all(...a: any[]): any[], get(...a: any[]): any, run(...a: any[]): any } }} db
 * @param {() => number} [now]
 */
export function createDomains(db, now = Date.now) {
  return {
    list: () => /** @type {{ host: string, app: string, created: number }[]} */ (db.prepare("SELECT host, app, created FROM appmods_domains ORDER BY created, host").all().map(r => ({ host: String(r.host), app: String(r.app), created: Number(r.created) }))),
    /** The app a host belongs to, or null. @param {string} host */
    appOf(host) { const r = db.prepare("SELECT app FROM appmods_domains WHERE host = ?").get(host); return r ? String(r.app) : null; },
    /** @param {string} host @param {string} app */
    add(host, app) {
      const have = db.prepare("SELECT app FROM appmods_domains WHERE host = ?").get(host);
      if (have && have.app === app) return false;
      if (!have && db.prepare("SELECT COUNT(*) AS n FROM appmods_domains").get().n >= MAX_DOMAINS) throw Object.assign(new Error(`at most ${MAX_DOMAINS} domains: remove one first`), { code: "conflict" });
      db.prepare("INSERT INTO appmods_domains (host, app, created) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET app = excluded.app").run(host, app, now());
      return true;
    },
    /** @param {string} host */
    remove(host) { return db.prepare("DELETE FROM appmods_domains WHERE host = ?").run(host).changes > 0; },
  };
}

/**
 * The https origin of the person's own domain for an app, when the public gate serves it now (a certificate held); the oldest such domain, or null.
 * @param {{ host: string, app: string }[]} list @param {string} app @param {string[]} live
 */
export function ownOrigin(list, app, live) {
  const d = list.find(x => x.app === app && live.includes(x.host));
  return d ? `https://${d.host}` : null;
}

/**
 * The two records the person adds at their domain, in the words of a DNS screen. The first sends visitors here; the second lets this server get the certificate (only the owner of the domain can set it).
 * @param {{ host: string, name: string, acmeZone: string | null, zone?: string }} o
 */
export function recordsFor({ host, name, acmeZone, zone = "vyre.run" }) {
  return [
    { type: "CNAME", name: host, value: `${name}.${zone}` },
    ...(acmeZone ? [{ type: "CNAME", name: `_acme-challenge.${host}`, value: acmeZone }] : []),
  ];
}

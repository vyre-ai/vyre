// @ts-check
// cloudflare: the few DNS operations Vyre needs, fenced to one zone. DEVELOPMENT ONLY since the
// name directory (names/worker): a box no longer holds a Cloudflare token, index.js loads this only
// with VYRE_NAMES_DEV_CLOUDFLARE=1.
//
// The interim name service is the user's own Cloudflare API token (ADR 0002, Names). That
// token may also cover the user's other zones, so every method refuses a name that is not the
// configured zone or under it, and remove() reads a record before deleting it to check the
// same. The token goes in the Authorization header and nowhere else: not in logs, not in
// error messages.

import dns from "node:dns";

/** Lowercase, trailing dot stripped. */
const norm = fqdn => String(fqdn || "").trim().toLowerCase().replace(/\.$/, "");
const LABELS = /^[a-z0-9_*]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * @param {{ token: string, zone?: string, fetch?: typeof globalThis.fetch, api?: string }} opts
 */
export function cloudflare({ token, zone = "vyre.run", fetch = globalThis.fetch, api = "https://api.cloudflare.com/client/v4" }) {
  if (!token) throw new Error("cloudflare needs an API token");
  const z = norm(zone);
  if (!LABELS.test(z) || !z.includes(".")) throw new Error(`"${zone}" is not a zone name`);
  /** @type {Promise<string>|null} */ let zoneIdP = null;

  /** True only for the zone itself or a name under it. */
  function inside(fqdn) {
    const n = norm(fqdn);
    return n === z || n.endsWith("." + z);
  }

  function guard(fqdn) {
    const n = norm(fqdn);
    if (!inside(n)) throw new Error(`refusing "${n}": it is not inside the ${z} zone`);
    if (!LABELS.test(n)) throw new Error(`refusing "${n}": not a DNS name`);
    return n;
  }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(api + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Say which call failed without echoing the request, which holds the token.
      throw new Error(`cloudflare ${method} ${path.split("?")[0]} failed: ${/** @type {any} */ (err).cause?.code || "network error"}`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !data || data.success === false) {
      const why = (data && data.errors || []).map(e => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new Error(`cloudflare ${method} ${path.split("?")[0]}: ${why}`.split(token).join("[token]"));
    }
    return data.result;
  }

  /** The zone's id, looked up by name once and cached. */
  function zoneId() {
    if (!zoneIdP) {
      zoneIdP = call("GET", `/zones?name=${encodeURIComponent(z)}`).then(result => {
        const list = Array.isArray(result) ? result : [];
        if (list.length !== 1 || norm(list[0].name) !== z) throw new Error(`expected exactly one zone named ${z}, the token sees ${list.length}`);
        return String(list[0].id);
      });
      zoneIdP.catch(() => { zoneIdP = null; }); // a failure should not be cached
    }
    return zoneIdP;
  }

  /** Records with exactly this name, optionally of one type. */
  async function find(fqdn, type) {
    const n = guard(fqdn);
    const id = await zoneId();
    const q = new URLSearchParams({ name: n, per_page: "100" });
    if (type) q.set("type", type);
    const list = await call("GET", `/zones/${id}/dns_records?${q}`);
    // Filter again here: only ever act on what is inside the zone and exactly this name.
    return (list || []).filter(r => norm(r.name) === n && inside(r.name) && (!type || r.type === type));
  }

  /** Point fqdn at ip with one A record, DNS only. Creates, updates, and removes duplicates. */
  async function upsertA(fqdn, ip) {
    const n = guard(fqdn);
    if (!IPV4.test(String(ip))) throw new Error(`"${ip}" is not an IPv4 address`);
    const id = await zoneId();
    const body = { type: "A", name: n, content: ip, proxied: false, ttl: 60 };
    const [first, ...extra] = await find(n, "A");
    const rec = first
      ? await call("PUT", `/zones/${id}/dns_records/${first.id}`, body)
      : await call("POST", `/zones/${id}/dns_records`, body);
    for (const r of extra) await remove(r.id);
    return rec;
  }

  /** Add a TXT record and return its id. */
  async function addTxt(fqdn, value) {
    const n = guard(fqdn);
    const id = await zoneId();
    const rec = await call("POST", `/zones/${id}/dns_records`, { type: "TXT", name: n, content: `"${String(value).replace(/"/g, "")}"`, ttl: 60 });
    return String(rec.id);
  }

  /** Delete one record, after checking it is inside the zone. */
  async function remove(recordId) {
    if (!/^[A-Za-z0-9]+$/.test(String(recordId))) throw new Error("not a record id");
    const id = await zoneId();
    const rec = await call("GET", `/zones/${id}/dns_records/${recordId}`);
    guard(rec && rec.name);
    await call("DELETE", `/zones/${id}/dns_records/${recordId}`);
  }

  /** Free, or already this box's. */
  async function available(fqdn, ip) {
    const recs = (await find(fqdn)).filter(r => ["A", "AAAA", "CNAME"].includes(r.type));
    if (recs.length === 0) return { available: true, mine: false };
    const mine = recs.every(r => r.type === "A" && r.content === ip);
    return { available: mine, mine };
  }

  return { zone: z, inside, zoneId, find, upsertA, addTxt, remove, available };
}

/** The { set, clear } adapter acme.issue wants. */
export function dnsFor(cf) {
  return {
    set: (fqdn, value) => cf.addTxt(fqdn, value),
    clear: id => cf.remove(id),
  };
}

/**
 * Wait until every resolver returns the TXT value for fqdn. Asking public resolvers directly
 * is closer to what the CA sees than the system resolver, which may cache a miss.
 * @param {string} fqdn
 * @param {string} value
 * @param {{ resolvers?: string[], timeoutMs?: number, pollMs?: number }} [opts]
 */
export async function waitTxt(fqdn, value, { resolvers = ["1.1.1.1", "8.8.8.8"], timeoutMs = 120000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const clients = resolvers.map(ip => { const r = new dns.promises.Resolver({ timeout: Math.min(5000, Math.max(100, timeoutMs)), tries: 1 }); r.setServers([ip]); return { ip, r }; });
  let waiting = clients;
  for (;;) {
    const seen = await Promise.all(waiting.map(async c => {
      try { return (await c.r.resolveTxt(fqdn)).some(chunks => chunks.join("") === value); } catch { return false; }
    }));
    waiting = waiting.filter((_, i) => !seen[i]);
    if (waiting.length === 0) return;
    if (Date.now() > deadline) throw new Error(`TXT for ${fqdn} not seen by ${waiting.map(c => c.ip).join(", ")} after ${Math.round(timeoutMs / 1000)}s`);
    await new Promise(r => setTimeout(r, pollMs));
  }
}

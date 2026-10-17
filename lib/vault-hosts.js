// @ts-check
// One host allowlist check for a vault credential and for a space-vault item.
// Exact host, or a "*." wildcard that matches exactly one label.

/**
 * Whether a host name matches one entry in an allowlist: exact, or one leading "*." wildcard
 * matching exactly one label ("*.googleapis.com" matches "gmail.googleapis.com", never
 * "a.gmail.googleapis.com" and never a bare suffix a longer, unrelated name could satisfy).
 * @param {string} host @param {string[]} hosts
 */
export function hostAllowed(host, hosts) {
  const h = host.toLowerCase();
  return hosts.some(entry => {
    if (!entry.startsWith("*.")) return entry === h;
    const suffix = entry.slice(1); // ".googleapis.com"
    if (!h.endsWith(suffix)) return false;
    const label = h.slice(0, h.length - suffix.length);
    // Exactly one label, and a real hostname label: no "*", "_", space or other character a name server would treat specially.
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  });
}

const ENTRY = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The hosts an item may be sent to. An https origin is kept as its hostname.
 * @param {unknown} list
 * @param {(message: string, code: string) => Error} refuse
 * @returns {string[]}
 */
export function normalizeHostList(list, refuse) {
  const raw = Array.isArray(list) ? list : [];
  if (!raw.length) throw refuse("Save it again with the hosts it may be sent to.", "host_refused");
  /** @type {string[]} */
  const hosts = [];
  for (const item of raw) {
    let s = String(item ?? "").trim().toLowerCase();
    if (!s) continue;
    if (s.includes("://")) {
      let u;
      try { u = new URL(s); } catch { throw refuse("Name each host as a hostname or an https address.", "bad_input"); }
      if (u.protocol !== "https:") throw refuse("A vault item is only sent to https hosts.", "host_refused");
      if (u.username || u.password) throw refuse("A host must not carry a user or password.", "host_refused");
      s = u.hostname;
    }
    if (!ENTRY.test(s)) throw refuse("Name each host as a hostname, such as api.example.com or *.example.com.", "bad_input");
    if (!hosts.includes(s)) hosts.push(s);
  }
  if (!hosts.length) throw refuse("Save it again with the hosts it may be sent to.", "host_refused");
  if (hosts.length > 16) throw refuse("An item can name at most 16 hosts.", "bad_input");
  return hosts;
}

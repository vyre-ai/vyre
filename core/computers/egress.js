// @ts-check
// egress: the few sites a computer's Chrome reaches through the user's own Mac.
//
// A bank or a court that sees a datacenter address asks questions, or refuses outright. With
// config glass.egress on, Chrome in every computer made after the change gets a proxy
// auto-config script: the listed sites go through the `egress` sidecar (box/compose.egress.yml),
// a second tailscaled that uses the Mac as its exit node and offers a SOCKS5 server on the
// computers network, and everything else goes out directly, as before. The box's own tailscaled
// never uses an exit node: that applies to the whole node, vyred included.
//
// Fail closed: a listed site has no DIRECT fallback. When the Mac is asleep or away, that site
// fails to load rather than quietly showing the datacenter's address after all.
//
// Everything a site string could carry into the script is checked here first, so the script is
// built from hostnames and nothing else. It is a routing rule, not an access control: any
// process in any computer can reach the sidecar's port, and the tailnet's ACL is what bounds
// where that port leads (autogroup:internet, through the exit node, and nothing else).

import net from "node:net";

/** Where the sidecar answers, as the computers see it. VYRE_EGRESS_PROXY moves it (tests only). */
export const PROXY = "egress:1055";

/** How many sites a list may hold. A PAC is read on every request; this is a list, not a policy. */
export const MAX_SITES = 200;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Two labels at least ("*.com" and "localhost" would route far more than a site), 253 in all.
const SITE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);
const HOSTPORT = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:\d{1,5}$/;

/** The proxy's address, from VYRE_EGRESS_PROXY when a test sets it, else PROXY. */
export function proxy() {
  const p = String(process.env.VYRE_EGRESS_PROXY || PROXY).toLowerCase();
  if (!HOSTPORT.test(p) || Number(p.split(":").pop()) > 65535) throw new Error(`"${p}" is not a host:port for the egress proxy`);
  return p;
}

/**
 * One site, checked strictly: a hostname, lowercase, optionally with a leading "*." that also
 * matches the name itself ("*.harlow.example" covers harlow.example and every name under it).
 * Anything else is refused, never cleaned up: a space, a quote, a slash, a port, a scheme or a
 * trailing dot all mean the input is not what it claims to be.
 * @param {unknown} s
 * @returns {string}
 */
export function checkSite(s) {
  if (typeof s !== "string") throw new Error("a site must be a string");
  const v = s.toLowerCase();
  if (v.length > 253 || !SITE.test(v)) throw new Error(`${JSON.stringify(s).slice(0, 80)} is not a hostname (optionally *.hostname)`);
  return v;
}

/**
 * The checked, de-duplicated list. Throws on the first bad one, naming it.
 * @param {unknown} sites
 * @returns {string[]}
 */
export function checkSites(sites) {
  if (!Array.isArray(sites)) throw new Error("sites must be a list of hostnames");
  if (sites.length > MAX_SITES) throw new Error(`at most ${MAX_SITES} sites`);
  return [...new Set(sites.map(checkSite))];
}

/**
 * The PAC script for these sites: each through SOCKS5 to the sidecar with no DIRECT fallback,
 * everything else DIRECT. Pure; the sites are checked here too, so a caller cannot skip it.
 * @param {string[]} sites
 * @param {string} [via] host:port of the SOCKS5 server
 * @returns {string}
 */
export function pac(sites, via = proxy()) {
  const list = checkSites(sites);
  if (!HOSTPORT.test(via)) throw new Error(`"${via}" is not a host:port for the egress proxy`);
  const exact = list.filter(s => !s.startsWith("*."));
  const under = list.filter(s => s.startsWith("*.")).map(s => s.slice(2));
  // Chrome hands the script the host alone; a trailing dot ("bank.example.") names the same
  // host, so it is dropped before matching or it would slip past the list.
  return [
    "function FindProxyForURL(url, host) {",
    '  host = String(host).toLowerCase().replace(/\\.$/, "");',
    `  var exact = ${JSON.stringify(exact)};`,
    `  var under = ${JSON.stringify(under)};`,
    `  var via = ${JSON.stringify(`SOCKS5 ${via}`)};`,
    "  for (var i = 0; i < exact.length; i++) if (host === exact[i]) return via;",
    "  for (var j = 0; j < under.length; j++) {",
    "    var d = under[j];",
    '    if (host === d || (host.length > d.length && host.slice(-d.length - 1) === "." + d)) return via;',
    "  }",
    '  return "DIRECT";',
    "}",
    "",
  ].join("\n");
}

/** The PAC as the data: URL Chrome's --proxy-pac-url takes. */
export const pacUrl = (sites, via) => `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac(sites, via)).toString("base64")}`;

/**
 * The setting as the pool uses it, from config glass.egress. Off unless `enabled` is exactly
 * true. A bad site list throws: a computer that would quietly go DIRECT for a site the person
 * listed is worse than one that does not start.
 * @param {any} cfg config glass.egress
 * @returns {{ enabled: boolean, sites: string[] }}
 */
export function setting(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return { enabled: c.enabled === true, sites: c.sites === undefined ? [] : checkSites(c.sites) };
}

/**
 * What a new computer's env gets for this setting: VYRE_PROXY_PAC (entrypoint.sh turns it into
 * Chrome's --proxy-pac-url) when the setting is on and lists at least one site, else nothing.
 * @param {any} cfg config glass.egress
 * @returns {Record<string, string>}
 */
export function chromeEnv(cfg) {
  const s = setting(cfg);
  return s.enabled && s.sites.length ? { VYRE_PROXY_PAC: pacUrl(s.sites) } : {};
}

/**
 * Does something accept a TCP connection at host:port within timeoutMs? On demand only: the
 * status tool calls it, nothing polls it.
 * @param {string} hostport @param {number} [timeoutMs]
 * @returns {Promise<{ answers: boolean, why?: string }>}
 */
export function probe(hostport, timeoutMs = 1500) {
  const i = hostport.lastIndexOf(":");
  const host = hostport.slice(0, i), port = Number(hostport.slice(i + 1));
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = r => { s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs, () => done({ answers: false, why: `no answer within ${timeoutMs} ms` }));
    s.once("connect", () => done({ answers: true }));
    s.once("error", e => done({ answers: false, why: /** @type {any} */ (e).code || e.message }));
  });
}

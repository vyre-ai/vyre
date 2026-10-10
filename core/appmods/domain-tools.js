// @ts-check
// The tools for an app's own domains (ingress v2): add, remove and list. The list is the module's (domains.js); the certificate and the directory listing belong to the public gate, which looks
// again when `appmods.domain-changed` fires. Nothing here touches DNS: the person adds two records and the list says which one is still missing.
import { cleanHost, recordsFor, MAX_DOMAINS } from "./domains.js";

const str = { type: "string" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/**
 * @param {{ ctx: any, domains: ReturnType<typeof import("./domains.js").createDomains>, running: (app: string) => boolean, signingApp: () => string | null, ownerOrAdmin: (meta: any) => Promise<boolean> }} o
 */
export function registerDomainTools({ ctx, domains, running, signingApp, ownerOrAdmin }) {
  const unwrap = (/** @type {any} */ r) => (r && !r.error ? (r.data !== undefined ? r.data : r) : null);
  /** Where each own domain stands on the public gate, by host. */
  const states = async () => {
    const d = unwrap(await ctx.call("wink.public.hosts", {}).catch(() => null));
    return new Map(((d && d.hosts) || []).map((/** @type {any} */ h) => [String(h.host), h]));
  };
  const boxName = () => { const n = ctx.config && ctx.config.name; return typeof n === "string" && n ? n : null; };
  const zone = () => "vyre.run";

  /** The records to add, with what the live DNS says about the challenge one (names.domain.check). @param {string} host */
  async function records(host) {
    const name = boxName();
    const chk = unwrap(await ctx.call("names.domain.check", { domain: host }).catch(() => null));
    const expected = chk && chk.cname && chk.cname.expected ? String(chk.cname.expected) : null;
    const list = name ? recordsFor({ host, name, acmeZone: expected, zone: zone() }) : [];
    return list.map(r => ({ ...r, ...(r.name.startsWith("_acme-challenge.") && chk && chk.cname ? { done: Boolean(chk.cname.ok) } : {}) }));
  }

  ctx.tool("appmods.domain.add", {
    description: "Use your own domain for an app's public pages, such as sign.yourfirm.com for signing: { host, app? }. Answers the two DNS records to add.",
    input: obj({ host: str, app: str }, ["host"]),
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (!(await ownerOrAdmin(meta))) throw refuse("only the Space's owner or an admin can point a domain at an app", "denied");
      const host = cleanHost(i.host, zone());
      if (!host) throw refuse("that is not a domain of your own, such as sign.yourfirm.com", "bad_input");
      const app = String(i.app || signingApp() || "");
      if (!app || !running(app)) throw refuse(app ? `${app} is not running here; install and start it first` : "no signing app is running here; install Documents first", "not_found");
      if (!(ctx.config && ctx.config.relay && ctx.config.relay.tunnel_url)) throw refuse("your own domain needs the public door, which is not set up on this server yet", "unavailable");
      let changed;
      try { changed = domains.add(host, app); } catch (e) { throw refuse(`${/** @type {Error} */ (e).message}; remove one first`, "conflict"); }
      if (changed) ctx.events.emit("appmods.domain-changed", { host, app, on: true });
      return { host, app, state: "waiting", records: await records(host), note: "Add both records at your domain's DNS. Vyre looks again every few minutes and starts serving the page when they are there." };
    },
  });

  ctx.tool("appmods.domain.remove", {
    description: "Stop using your own domain for an app's public pages: { host }.",
    input: obj({ host: str }, ["host"]),
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (!(await ownerOrAdmin(meta))) throw refuse("only the Space's owner or an admin can remove a domain", "denied");
      const host = cleanHost(i.host, zone());
      if (!host || !domains.remove(host)) throw refuse("that domain is not in use here", "not_found");
      ctx.events.emit("appmods.domain-changed", { host, on: false });
      return { host, removed: true };
    },
  });

  ctx.tool("appmods.domain.list", {
    description: "Your own domains for apps and where each stands: waiting for its DNS records, getting a certificate, or live. check: true adds the records still to add.",
    input: obj({ check: { type: "boolean" } }),
    run: async (/** @type {any} */ i) => {
      const st = await states();
      const rows = [];
      for (const d of domains.list()) {
        const s = /** @type {any} */ (st.get(d.host));
        rows.push({ host: d.host, app: d.app, state: s ? s.state : "waiting", ...(s && s.why ? { why: s.why } : {}), ...(s && s.expires ? { expires: s.expires } : {}),
          ...(i && i.check === true ? { records: await records(d.host) } : {}) });
      }
      return { domains: rows, max: MAX_DOMAINS };
    },
  });
}

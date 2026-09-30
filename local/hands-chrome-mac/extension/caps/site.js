// @ts-check
// site: what Vyre has learned about a site, read from this device (lib/sitecache.js). Read only; nothing here changes a page.

import { err } from "../lib/err.js";
import { originOf } from "../lib/observe.js";

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "site",
  ops: {
    "site.card": async (args, ctx) => {
      const sites = ctx.sites;
      if (!sites) return { known: false, why: "the site cache is not running" };
      let origin = typeof args.origin === "string" ? originOf(args.origin) || args.origin : "";
      if (!origin && typeof args.tabId === "number") { const t = await ctx.tabs.get(args.tabId); origin = originOf(String(t && (t.pendingUrl || t.url) || "")); }
      if (!origin) throw err("bad_request", "site.card needs an origin or a tab on an http(s) page");
      const card = await sites.arrive(origin);
      return { origin, known: !!card, ...(card ? { card } : {}), stats: sites.stats() };
    },
    /** Send what is queued now instead of in 10 s. */
    "site.flush": async (_args, ctx) => { const out = ctx.sites ? await ctx.sites.flush() : []; return { sent: out.length, origins: out.map((/** @type {any} */ o) => o.origin) }; },
  },
};

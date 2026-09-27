// @ts-check
// names — `<you>.vyre.run`, Tailscale and certificates (docs/adr/0002-network-and-identity.md).
//
// Wires the real adapters into the service: the tailscale CLI, Cloudflare for the vyre.run zone
// (until the hosted name directory exists), Let's Encrypt by DNS-01, and the certificate store in
// ~/.vyre/certs. The tailnet listener starts on its own when a certificate is already there.

import os from "node:os";
import * as config from "../config/index.js";
import * as ts from "./tailscale.js";
import * as acme from "./acme.js";
import * as certs from "./certs.js";
import { cloudflare, dnsFor, waitTxt } from "./cloudflare.js";
import { names } from "./service.js";

const DAY = 86_400_000;
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);

    // The user's own token for the vyre.run zone, from vyred's environment or the vault. It is
    // never logged and never leaves this module.
    const token = async () => {
      if (process.env.CLOUDFLARE_vyre_token) return process.env.CLOUDFLARE_vyre_token;
      try { const v = await ctx.vault.fetch("cloudflare-vyre-token"); if (v) return v; } catch {}
      throw new Error("no Cloudflare token for the vyre.run zone: set CLOUDFLARE_vyre_token in ~/.vyre/env");
    };
    const hasToken = () => token().then(() => true, () => false);
    const which = () => (ctx.config.network || {}).acme === "staging" ? "staging" : "production";

    const svc = names({
      ctx, save, ts, certs,
      dns: async zone => {
        const cf = cloudflare({ token: await token(), zone, ...(process.env.VYRE_CLOUDFLARE_API ? { api: process.env.VYRE_CLOUDFLARE_API } : {}) });
        return { ...cf, ...dnsFor(cf) };
      },
      issue: ({ names: list, dns }) => acme.issue({
        names: list, dns, log: m => ctx.log(m),
        directory: process.env.VYRE_ACME_DIRECTORY || acme.DIRECTORIES[which()],
        accountKey: certs.accountKey(ctx.paths.certs, which()),
        waitDns: process.env.VYRE_ACME_DIRECTORY ? undefined : (f, v) => waitTxt(f, v),
      }),
    });

    const person = caller => !["onboard"].includes(String(caller));
    ctx.tool("names.status", {
      description: "This box's address, how it is served, its owner, its certificate, whether a vyre.run zone token is here, and what Tailscale says.",
      input: obj(),
      run: async () => {
        const [t, zone] = await Promise.all([svc.tailscale().catch(() => null), hasToken()]);
        return { ...svc.status(), zone, tailscale: t && { ...t, install: t.installed ? null : ts.installCommand(), operator: await ts.operator(os.userInfo().username) } };
      },
    });
    ctx.tool("names.check", {
      description: "Is <name>.vyre.run a valid name, and is it free (or already this box's)?",
      input: obj({ name: { type: "string" } }, ["name"]),
      run: async ({ name }) => svc.check(name),
    });
    ctx.tool("names.claim", {
      description: "Point <name>.vyre.run at this box's tailnet address, get its certificate and serve the Deck there. Runs in the background; watch names.status.",
      input: obj({ name: { type: "string" } }),
      run: async ({ name }) => svc.claim(name),
    });
    ctx.tool("names.fallback", {
      description: "Serve at the tailnet's own ts.net name with a `tailscale cert` certificate instead of a vyre.run name.",
      input: obj(),
      run: async () => svc.fallback(),
    });
    ctx.tool("names.release", {
      description: "Remove this box's vyre.run record and stop serving on the tailnet.",
      input: obj(),
      run: async (_, { caller }) => { if (!person(caller)) throw new Error("not from the onboarding page"); return svc.release(); },
    });
    ctx.tool("names.connect", {
      description: "Start `tailscale up`. Returns the sign-in link to open, or nothing when already signed in.",
      input: obj(),
      run: async () => svc.connect(),
    });
    ctx.tool("names.owner", {
      description: "Set the one Tailscale login this box serves.",
      input: obj({ login: { type: "string" } }, ["login"]),
      run: async ({ login }, { caller }) => {
        if (!person(caller)) throw new Error("the owner cannot be changed from the onboarding page");
        svc.setOwner(login);
        return svc.status();
      },
    });
    ctx.tool("names.claim-code", {
      description: "A one-time link for a tagged box: the first tailnet login to open it becomes the owner.",
      input: obj(), internal: true,
      run: async () => svc.claimCode(),
    });

    // Serve straight away when a certificate is already here, but after start returns.
    const first = setTimeout(() => { svc.serve().catch(e => ctx.log("names: " + e.message)); }, 0);
    const daily = setInterval(() => { svc.renew().catch(() => {}); }, DAY);
    daily.unref();
    return { async stop() { clearTimeout(first); clearInterval(daily); await svc.close(); } };
  },
};

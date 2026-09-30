// @ts-check
// names — `<you>.vyre.run`, Tailscale and certificates (docs/adr/0002-network-and-identity.md).
//
// Wires the real adapters into the service: the tailscale CLI, the hosted name directory
// (names.vyre.run, signed with the box's relay route key), Let's Encrypt by DNS-01, and the
// certificate store in ~/.vyre/certs. The tailnet listener starts on its own when a certificate is
// already there. The old direct-to-Cloudflare path (cloudflare.js) is development only: it needs
// VYRE_NAMES_DEV_CLOUDFLARE=1 and the zone token, and a box never gets that token in production.

import os from "node:os";
import dns from "node:dns";
import * as config from "../config/index.js";
import * as ts from "./tailscale.js";
import * as acme from "./acme.js";
import * as certs from "./certs.js";
import { cloudflare, dnsFor, waitTxt } from "./cloudflare.js";
import { names } from "./service.js";
import { directory, DEFAULT_BASE } from "./directory.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);

    // Development only: the user's own token for the vyre.run zone, from vyred's environment or
    // the vault. It is never logged and never leaves this module.
    const dev = process.env.VYRE_NAMES_DEV_CLOUDFLARE === "1";
    const token = async () => {
      if (process.env.CLOUDFLARE_VYRE_TOKEN) return process.env.CLOUDFLARE_VYRE_TOKEN;
      try { const v = await ctx.vault.fetch("cloudflare-vyre-token"); if (v) return v; } catch {}
      throw new Error("no Cloudflare token for the vyre.run zone: set CLOUDFLARE_VYRE_TOKEN in ~/.vyre/env");
    };
    const hasToken = () => dev ? token().then(() => true, () => false) : Promise.resolve(false);
    const which = () => (ctx.config.network || {}).acme === "staging" ? "staging" : "production";

    // The route key stays with the relay module. Two answers from it, both internal: the box's
    // route id and public key, and a signature over a message that must begin with this service's
    // tag and the box's own route (so it cannot be turned into a signature the relay would accept).
    const answer = async (tool, input) => {
      const r = await ctx.call(tool, input);
      if (!r || r.error || !r.data) throw new Error(`the relay keys are not available (${tool})`);
      return r.data;
    };
    const signer = {
      identity: async () => { const d = await answer("relay.route.id", {}); return { route: String(d.route), pub: Buffer.from(String(d.pub), "base64url") }; },
      sign: async message => Buffer.from(String((await answer("relay.route.sign", { message: message.toString("base64url") })).sig), "base64url"),
    };
    const dir = dev ? null : directory({ base: (ctx.config.network || {}).directory || process.env.VYRE_NAMES_DIRECTORY || DEFAULT_BASE, signer });
    const resolver = (() => {
      const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
      r.setServers(["1.1.1.1", "8.8.8.8"]);
      return { resolveCname: h => r.resolveCname(h), resolveCaa: h => r.resolveCaa(h) };
    })();

    const svc = names({
      ctx, save, ts, certs, ...(dir ? { directory: dir, resolver } : {}),
      dns: async zone => {
        if (!dev) throw new Error("direct DNS is development only (VYRE_NAMES_DEV_CLOUDFLARE=1)");
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
      description: "This box's address, how it is served, its owner, its certificate, and what Tailscale says.",
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
      description: "Claim <name>.vyre.run for this box for good, then point it at the tailnet address, get its certificate and serve the Deck there. Answers at once with the one-time recovery code (shown only here) when the name is new; the rest runs in the background, watch names.status. Run it again once Tailscale is connected if it says it is waiting.",
      input: obj({ name: { type: "string" } }),
      run: async ({ name }) => svc.claim(name),
    });
    ctx.tool("names.recover", {
      description: "Take this box's name back with its recovery code after a reinstall. A 72-hour pending rebind: the old box, if still online, cancels it by itself, and its owner's devices are told. Returns the new recovery code, shown once.",
      input: obj({ name: { type: "string" }, code: { type: "string" } }, ["code"]),
      presence: true,
      run: async (input, { caller }) => { if (!person(caller)) throw new Error("not from the onboarding page"); return svc.recover(input); },
    });
    // A new install has no owner yet, so the recovery code is its authority. Internal: the setup
    // channel's allowlist wires it, nothing else calls it.
    ctx.tool("names.recover.code", {
      description: "names.recover for a new install's setup channel, where the recovery code is the only authority.",
      input: obj({ name: { type: "string" }, code: { type: "string" } }, ["name", "code"]),
      internal: true,
      run: async input => svc.recover(input),
    });
    ctx.tool("names.domain.check", {
      description: "Live DNS check of the records for using your own domain: _acme-challenge.<domain> as a CNAME to <routehash>.acme.vyre.run (required) and an optional CAA record.",
      input: obj({ domain: { type: "string" } }, ["domain"]),
      run: async ({ domain }) => svc.domainCheck(domain),
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
    // A recovery of this box's name is cancelled by the box itself, so look often (the rebind waits 72 hours).
    const watching = () => svc.watch().catch(e => ctx.log("names: directory check failed: " + e.message));
    const watch = setInterval(watching, HOUR);
    watch.unref();
    const soon = setTimeout(watching, 30_000);
    soon.unref();
    return { async stop() { clearTimeout(first); clearTimeout(soon); clearInterval(daily); clearInterval(watch); await svc.close(); } };
  },
};

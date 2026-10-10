// @ts-check
// names: `<you>.vyre.run` (docs/adr/0002-network-and-identity.md, DESIGN-wink 2).
//
// Wires the real adapters into the service: the hosted name directory (names.vyre.run, signed with the box's relay route key) and a DNS resolver for the own-domain
// check. A name is held here and nothing is served: the browser address belongs to the built-in network (SPEC-wink-network 4.5).

import dns from "node:dns";
import * as config from "../config/index.js";
import { agentClaim, ownerDevice } from "../modules/index.js";
import { names } from "./service.js";
import { directory, DEFAULT_BASE } from "./directory.js";

const HOUR = 3_600_000;
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);

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
    const dir = directory({ base: (ctx.config.network || {}).directory || process.env.VYRE_NAMES_DIRECTORY || DEFAULT_BASE, signer });
    const resolver = (() => {
      const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
      r.setServers(["1.1.1.1", "8.8.8.8"]);
      return { resolveCname: h => r.resolveCname(h), resolveCaa: h => r.resolveCaa(h) };
    })();

    const svc = names({ ctx, save, directory: dir, resolver });

    // Who may change the name a server serves: the person's own surfaces and their devices (the paired app included). A model session, an agent, a hook, a guest or any module is refused. Declared with the surface kinds the router
    // lets through (callers); this is the check that narrows "a module" to the three that may.
    const SURFACES = ["cli", "local", "deck", "capsule", "mobile"];
    const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"];
    const steward = (/** @type {string[]} */ modules) => (/** @type {any} */ meta) => {
      const c = String((meta && meta.caller) || "");
      const ok = !(meta && meta.agent) && agentClaim(c) === null
        && (c.startsWith("module:") ? modules.includes(c.slice(7)) : SURFACES.includes(c) || ownerDevice(c) || /^setup:[a-z2-7]{16}$/.test(c));
      if (!ok) throw Object.assign(new Error("changing the box's name or owner is the person's own"), { code: "denied" });
    };
    const ownerOnly = steward([]);
    ctx.tool("names.status", {
      description: "This box's name and whether it is held: the name, its address once the built-in network publishes one, and why not when it cannot.",
      input: obj(),
      run: async () => svc.status(),
    });
    ctx.tool("names.check", {
      description: "Is <name>.vyre.run a valid name, and is it free (or already this box's)?",
      input: obj({ name: { type: "string" } }, ["name"]),
      run: async ({ name }) => svc.check(name),
    });
    ctx.tool("names.serve", {
      description: "Set the space this server serves: <name>.vyre.run. The directory points the name at this server only when the space listed this server's route, so a wrong name here publishes nothing.",
      input: obj({ name: { type: "string" } }, ["name"]),
      callers: WHO,
      run: async ({ name }, meta = {}) => { ownerOnly(meta); return svc.serve(name); },
    });
    ctx.tool("names.domain.check", {
      description: "Live DNS check of the records for using your own domain: _acme-challenge.<domain> as a CNAME to <routehash>.acme.vyre.run (required) and an optional CAA record.",
      input: obj({ domain: { type: "string" } }, ["domain"]),
      callers: WHO,
      run: async ({ domain }) => svc.domainCheck(domain),
    });
    ctx.tool("names.unserve", {
      description: "Stop serving the space's name on this server.",
      input: obj(),
      callers: WHO,
      run: async (_, meta = {}) => { ownerOnly(meta); return svc.unserve(); },
    });
    // The box's public gate (core/wink/control/publicgate.js) gets its certificate and its address through the directory, which this module alone can sign for.
    // Modules only, and only the Wink module: it never sees the route key, only these three answers.
    const fromWink = meta => { if (String((meta && meta.caller) || "") !== "module:wink") throw Object.assign(new Error("the name directory's DNS calls are the Wink module's alone; names.status shows this box's name"), { code: "denied" }); };
    const myName = () => { const n = ctx.config.name; if (!n) throw Object.assign(new Error("this box has no name yet; choose one first (names.check tells if a name is free)"), { code: "no_name" }); return String(n); };
    ctx.tool("names.directory.acme", {
      description: "Put an ACME DNS-01 challenge value under this box's name, or under its own-domain label with own: true (Wink module only).",
      input: obj({ token: { type: "string" }, own: { type: "boolean" } }, ["token"]),
      internal: true,
      run: async ({ token, own }, meta) => { fromWink(meta); return own === true ? dir.acmeOwn(String(token)) : dir.acme(myName(), String(token)); },
    });
    ctx.tool("names.directory.acme-clear", {
      description: "Clear this box's ACME challenge record, or its own-domain one with own: true (Wink module only).",
      input: obj({ own: { type: "boolean" } }),
      internal: true,
      run: async (i, meta) => { fromWink(meta); return i && i.own === true ? dir.acmeOwnClear() : dir.acmeClear(myName()); },
    });
    ctx.tool("names.directory.host-add", {
      description: "List an own domain this box serves through the tunnel; the directory checks the CNAME proof (Wink module only).",
      input: obj({ host: { type: "string" } }, ["host"]),
      internal: true,
      run: async ({ host }, meta) => { fromWink(meta); return dir.hostAdd(myName(), String(host)); },
    });
    ctx.tool("names.directory.host-remove", {
      description: "Unlist an own domain this box served through the tunnel (Wink module only).",
      input: obj({ host: { type: "string" } }, ["host"]),
      internal: true,
      run: async ({ host }, meta) => { fromWink(meta); return dir.hostRemove(myName(), String(host)); },
    });
    ctx.tool("names.directory.publish", {
      description: "Point this box's name at the public IPv4 the directory sees it at (Wink module only). With apps: true, *.<name> points there too (the box has an app module installed).",
      input: obj({ apps: { type: "boolean" }, via: { type: "string" }, share: { type: "boolean" } }),
      internal: true,
      run: async (i, meta) => { fromWink(meta); return dir.publish(myName(), { apps: Boolean(i && i.apps === true), ...(i && i.via === "tunnel" ? { via: "tunnel", share: i.share === true } : {}) }); },
    });
    // Ask the directory hourly how this box's name stands (a name support moved to another server is told to the person).
    const watching = () => svc.watch().catch(e => ctx.log("names: directory check failed: " + e.message));
    const watch = setInterval(watching, HOUR);
    watch.unref();
    const soon = setTimeout(watching, 30_000);
    soon.unref();
    return { async stop() { clearTimeout(soon); clearInterval(watch); } };
  },
};

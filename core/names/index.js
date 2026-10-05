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

    const person = caller => !["onboard"].includes(String(caller));
    // Who may change a box's name: the person's own surfaces and their devices (the setup page's device
    // included), and only the named modules that run those steps for them (onboard, launch). A model session, an agent, a hook, a guest or any other module is refused, so no session can
    // claim <name>.vyre.run for the box for good, release it or reassign its owner. Declared with the surface kinds the router
    // lets through (callers); this is the check that narrows "a module" to the three that may.
    const SURFACES = ["cli", "local", "deck", "capsule", "mobile"];
    const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "module"];
    const steward = (/** @type {string[]} */ modules) => (/** @type {any} */ meta) => {
      const c = String((meta && meta.caller) || "");
      const ok = !(meta && meta.agent) && agentClaim(c) === null
        && (c.startsWith("module:") ? modules.includes(c.slice(7)) : SURFACES.includes(c) || ownerDevice(c) || /^setup:[a-z2-7]{16}$/.test(c));
      if (!ok) throw Object.assign(new Error("changing the box's name or owner is the person's own"), { code: "denied" });
    };
    const ownerOnly = steward([]), setupSteps = steward(["onboard", "launch"]);
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
    ctx.tool("names.claim", {
      description: "Claim <name>.vyre.run for this box for good. Answers with the one-time recovery code (shown only here) when the name is new. The name is held; its address is published once the built-in network has one for this home.",
      input: obj({ name: { type: "string" } }),
      callers: WHO,
      run: async ({ name }, meta = {}) => { setupSteps(meta); return svc.claim(name); },
    });
    ctx.tool("names.recover", {
      description: "Take this box's name back with its recovery code after a reinstall. A 72-hour pending rebind: the old box, if still online, cancels it by itself, and its owner's devices are told. Returns the new recovery code, shown once.",
      input: obj({ name: { type: "string" }, code: { type: "string" } }, ["code"]),
      presence: true,
      callers: WHO,
      run: async (input, meta = {}) => { ownerOnly(meta); if (!person(meta.caller)) throw new Error("not from the onboarding page"); return svc.recover(input); },
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
    ctx.tool("names.release", {
      description: "Release this box's vyre.run name.",
      input: obj(),
      callers: WHO,
      run: async (_, meta = {}) => { ownerOnly(meta); if (!person(meta.caller)) throw new Error("not from the onboarding page"); return svc.release(); },
    });
    // A recovery of this box's name is cancelled by the box itself, so look often (the rebind waits 72 hours).
    const watching = () => svc.watch().catch(e => ctx.log("names: directory check failed: " + e.message));
    const watch = setInterval(watching, HOUR);
    watch.unref();
    const soon = setTimeout(watching, 30_000);
    soon.unref();
    return { async stop() { clearTimeout(soon); clearInterval(watch); } };
  },
};

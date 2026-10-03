// kernel/modules/host.js: where a module is installed (K6). A first-party module (reviewed code shipped with Vyre) runs in the core as today. Any other
// module runs only under the supervisor, and the kernel refuses to install it while the supervisor is absent or cannot prove its sandbox: there is no
// "run it unsandboxed for now". The manifest's `needs.egress` is the host list the egress proxy holds it to; nothing else is open to it.
import { KernelError } from "../core/errors.js";

/** Domains whose subdomains belong to many different tenants: a wildcard on one opens every tenant, so none is accepted. */
export const SHARED_SUFFIXES = Object.freeze(["github.io", "githubusercontent.com", "herokuapp.com", "amazonaws.com", "s3.amazonaws.com", "cloudfront.net", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "azurewebsites.net", "cloudapp.net", "appspot.com", "firebaseapp.com", "web.app", "onrender.com", "fly.dev", "railway.app", "ngrok.io", "ngrok-free.app", "blogspot.com", "wordpress.com", "myshopify.com", "glitch.me", "repl.co", "gitlab.io", "surge.sh", "now.sh", "execute-api.us-east-1.amazonaws.com", "co.uk", "com.au", "co.jp", "com", "net", "org", "io", "dev", "app", "ai"]);
/** A wildcard is `*.` plus a name with at least two labels that is not a shared suffix. @param {string} h */
export const wildcardOk = h => { if (!h.startsWith("*.")) return true; const base = h.slice(2); return base.split(".").length >= 2 && !SHARED_SUFFIXES.includes(base) && !SHARED_SUFFIXES.some(s => s.includes(".") && base.endsWith("." + s)); };

/**
 * @param {{ space: string, supervisor: any, isFirstParty: (dir: string) => boolean, log?: any, chains?: any }} cfg
 */
export function createModuleHost(cfg) {
  /** @type {Map<string, { name: string, mode: "in_process" | "sandboxed", dir: string, hosts: string[], handle?: any }>} */ const installed = new Map();
  const note = (/** @type {string} */ type, /** @type {any} */ data) => { if (cfg.log && cfg.chains) { try { cfg.log.append(cfg.chains.fromFacts({ kind: "module", module: "supervisor", first_party: true }), { type, sv: 1, subject: `vyre://${cfg.space}/module/${data.name}`, data, vis: "space", red: "internal" }); } catch { /* the install stands on its own */ } } };

  return Object.freeze({
    /**
     * What the install card shows: the module and the hosts it asks to reach. The hosts are the module author's own claim and its whole outside world; a
     * declared host is also a channel for anything the module can read (it chooses the path and query), which the card says plainly.
     * @param {{ name: string, manifest?: { needs?: { egress?: string[] } } }} m
     */
    installCard(m) {
      const hosts = (m.manifest && m.manifest.needs && m.manifest.needs.egress) || [];
      return { name: m.name, runs: "sandboxed: no network of its own, no files beyond its folder, no other programs", egress_hosts: hosts, refused_wildcards: hosts.filter(h => !wildcardOk(h)),
        warning: hosts.length ? "This module can send anything it can read to these hosts." : "This module cannot reach anything outside." };
    },
    /** The hosts a module's manifest declared: what `createEgress({ hostsOf })` reads. */
    hostsOf: (/** @type {string} */ name) => installed.get(name)?.hosts,
    /**
     * @param {{ name: string, dir: string, entry: string, manifest?: { needs?: { egress?: string[] } } }} m
     * @param {{ approved_hosts?: string[] }} [o] the hosts the person saw on the install card and approved
     * @returns {Promise<{ name: string, mode: string }>}
     */
    async install(m, o = {}) {
      if (!m || typeof m.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.name) || typeof m.dir !== "string" || typeof m.entry !== "string") throw new KernelError("bad_input", "a module needs a name, a folder and an entry");
      if (cfg.isFirstParty(m.dir)) {
        installed.set(m.name, { name: m.name, mode: "in_process", dir: m.dir, hosts: [] });
        note("module.installed", { name: m.name, mode: "in_process" });
        return { name: m.name, mode: "in_process" };
      }
      // No supervisor, no install: an unreviewed module never runs beside the kernel's own memory.
      if (!cfg.supervisor || !cfg.supervisor.available()) { note("module.refused", { name: m.name, why: "supervisor_absent" }); throw new KernelError("supervisor_absent", "modules from outside Vyre run only under the module supervisor, which is not available here"); }
      const hosts = (m.manifest && m.manifest.needs && m.manifest.needs.egress) || [];
      if (!Array.isArray(hosts) || hosts.some(h => typeof h !== "string" || !/^(\*\.)?[a-z0-9.-]+$/.test(h))) throw new KernelError("bad_input", "needs.egress must be a list of host names");
      const shared = hosts.filter(h => !wildcardOk(h));
      if (shared.length) throw new KernelError("bad_input", `a wildcard on ${shared.join(", ")} would open every tenant of that domain; name the hosts`);
      // The person installing is shown the hosts and approves exactly them (`approved_hosts`), the way a permission card works; no card, no install.
      if (hosts.length && !(Array.isArray(o.approved_hosts) && o.approved_hosts.length === hosts.length && hosts.every(h => o.approved_hosts.includes(h)))) throw new KernelError("needs_approval", "the person installing must approve the hosts this module can reach");
      installed.set(m.name, { name: m.name, mode: "sandboxed", dir: m.dir, hosts });
      try {
        const handle = await cfg.supervisor.start({ name: m.name, dir: m.dir, entry: m.entry });
        installed.set(m.name, { name: m.name, mode: "sandboxed", dir: m.dir, hosts, handle });
      } catch (e) { installed.delete(m.name); note("module.refused", { name: m.name, why: /** @type {any} */ (e).code || "failed" }); throw e; }
      note("module.installed", { name: m.name, mode: "sandboxed", egress_hosts: hosts.length });
      return { name: m.name, mode: "sandboxed" };
    },
    /** Call a sandboxed module's method. A first-party module is called by the registry, not here. */
    async call(/** @type {string} */ name, /** @type {string} */ method, /** @type {any} */ input) {
      const r = installed.get(name);
      if (!r || r.mode !== "sandboxed" || !r.handle) throw new KernelError("not_found", "no such sandboxed module");
      return r.handle.call(method, input);
    },
    async uninstall(/** @type {string} */ name) { const r = installed.get(name); if (r && r.handle) await r.handle.stop(); installed.delete(name); note("module.removed", { name }); },
    list: () => [...installed.values()].map(({ handle: _h, ...x }) => x),
  });
}

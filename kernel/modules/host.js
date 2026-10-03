// kernel/modules/host.js: where a module is installed (K6). A first-party module (reviewed code shipped with Vyre) runs in the core as today. Any other
// module runs only under the supervisor, and the kernel refuses to install it while the supervisor is absent or cannot prove its sandbox: there is no
// "run it unsandboxed for now". The manifest's `needs.egress` is the host list the egress proxy holds it to; nothing else is open to it.
import { KernelError } from "../core/errors.js";

/**
 * @param {{ space: string, supervisor: any, isFirstParty: (dir: string) => boolean, log?: any, chains?: any }} cfg
 */
export function createModuleHost(cfg) {
  /** @type {Map<string, { name: string, mode: "in_process" | "sandboxed", dir: string, hosts: string[], handle?: any }>} */ const installed = new Map();
  const note = (/** @type {string} */ type, /** @type {any} */ data) => { if (cfg.log && cfg.chains) { try { cfg.log.append(cfg.chains.fromFacts({ kind: "module", module: "supervisor", first_party: true }), { type, sv: 1, subject: `vyre://${cfg.space}/module/${data.name}`, data, vis: "space", red: "internal" }); } catch { /* the install stands on its own */ } } };

  return Object.freeze({
    /** The hosts a module's manifest declared: what `createEgress({ hostsOf })` reads. */
    hostsOf: (/** @type {string} */ name) => installed.get(name)?.hosts,
    /**
     * @param {{ name: string, dir: string, entry: string, manifest?: { needs?: { egress?: string[] } } }} m
     * @returns {Promise<{ name: string, mode: string }>}
     */
    async install(m) {
      if (!m || typeof m.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.name) || typeof m.dir !== "string" || typeof m.entry !== "string") throw new KernelError("bad_input", "a module needs a name, a folder and an entry");
      if (cfg.isFirstParty(m.dir)) {
        installed.set(m.name, { name: m.name, mode: "in_process", dir: m.dir, hosts: [] });
        note("module.installed", { name: m.name, mode: "in_process" });
        return { name: m.name, mode: "in_process" };
      }
      const hosts = (m.manifest && m.manifest.needs && m.manifest.needs.egress) || [];
      if (!Array.isArray(hosts) || hosts.some(h => typeof h !== "string" || !/^(\*\.)?[a-z0-9.-]+$/.test(h))) throw new KernelError("bad_input", "needs.egress must be a list of host names");
      // No supervisor, no install: an unreviewed module never runs beside the kernel's own memory.
      if (!cfg.supervisor || !cfg.supervisor.available()) { note("module.refused", { name: m.name, why: "supervisor_absent" }); throw new KernelError("supervisor_absent", "modules from outside Vyre run only under the module supervisor, which is not available here"); }
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

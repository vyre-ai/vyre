// @ts-check
// A module's tool as a step of a Flow. The tool says `flow: { risk }` in its manifest; the registry has the kernel register `<module>.<tool>` as an action of the Space (the owner and admins
// hold it), so a Flow's `call` step may name it and the runner authorizes it for the run's chain first. This is the port the runner then calls: it runs ONLY a tool that was registered that
// way, through the registry as the Flows service, so the tool's own checks, the install card's declarations and the event log all apply as for any other caller.

/** @param {{ registry: any, owner?: () => string }} o @returns {(chain: any, action: string, resource: string, input: any, opts?: any) => Promise<any>} */
export function moduleActionPort({ registry, owner }) {
  return async (chain, action, _resource, input) => {
    if (!registry.flowActionTools || !registry.flowActionTools.has(action)) throw Object.assign(new Error(`${action} is not a tool a Flow may call`), { code: "unavailable" });
    // The Flow runs for the person who approved it. Origin "cli" is the OWNER's own surface, so it is claimed only when the run's chain is the owner; an admin's run carries a class
    // no tool's callers list names, so a module tool that builds its own chain from the origin never acts as the owner for an admin.
    const who = chain && chain.hops && chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.id;
    const origin = owner && who && who === owner() ? "cli" : "flow-member";
    const r = await registry.call(action, input && typeof input === "object" ? input : {}, "module:flows", { origin });
    if (r && r.error) throw Object.assign(new Error(String(r.error.message || r.error.code)), { code: String(r.error.code || "failed") });
    return r ? r.data : null;
  };
}

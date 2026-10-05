// @ts-check
// Test helper: with the kernel on, a call is a person's or an agent's by the facts the daemon proves, never by its label. This gives a registry call those facts: the person at the cli is the home's owner
// on its own socket; an `mcp:agent:<name>` caller is a vouched session of that person (the assistant acts as them; a project agent is its own actor); anything else carries none.
/** @param {any} d a started daemon @param {string} caller */
const SURFACES = new Set(["cli", "deck", "local"]);
export const factsFor = (d, caller) => (SURFACES.has(caller)
  ? { kernelFacts: { kind: "socket", surface: caller, uid: process.getuid ? process.getuid() : 0, pid: process.pid, inside_model_process: false, capsule_verified: true } }
  : /^mcp:agent:/.test(caller) ? { kernelFacts: { kind: "agent_session", agent: caller.split(":")[2], session: `s-${caller.split(":")[2]}`, thread: `t-${caller.split(":")[2]}`, vouched: true, person: d.kernel.id.owner } } : {});
/** A registry call as `caller`, with the facts it would be proved with. @param {any} d @param {string} tool @param {any} input @param {string} [caller] */
export const as = (d, tool, input, caller = "cli") => d.registry.call(tool, input, caller, factsFor(d, caller));

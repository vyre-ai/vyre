/**
 * Did the person's own words, in this thread or its lineage, ask for exactly this act? The same question the registry asks
 * for an "asked" tool (core/modules saidMatch): vault.said.match with kind act_out, the act's key as the destination, and the
 * match used up. Fails closed: no vault, a locked one, an error, or no thread answers no. A person's own surface never asks
 * this (a click there IS the asking); it is for a model, the assistant or a session acting on the person's behalf.
 *
 * The key names the act and what it touches: "team.role.fill:<project>/<role>/<agent|default>", "team.retire:<project>/<role>",
 * "team.duties.create:<project>/<role>", "team.duties.update:<teammate>/<duty id>".
 * @param {(tool: string, input: any) => Promise<any>} call
 * @param {{ thread?: string, agent?: string }} meta
 * @param {string} key
 */
export async function askedFor(call, meta, key) {
  try {
    const thread = typeof meta.thread === "string" && meta.thread ? meta.thread : undefined;
    let lineage;
    if (thread) {
      const l = await call("threads.lineage", { thread });
      if (l && l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage.map(String);
    }
    const r = await call("vault.said.match", { kind: "act_out", via: "team", to: [key], consume: true,
      ...(thread ? { thread } : {}), ...(lineage ? { lineage } : {}), ...(meta.agent ? { agent: meta.agent } : {}) });
    return Boolean(r && r.data && r.data.matched === true);
  } catch { return false; }
}

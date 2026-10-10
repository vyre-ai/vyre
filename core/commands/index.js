// @ts-check
// commands: every CLI verb the running modules declare under does.commands, in one list (ADR 0033).
//
// A module says `{ verb, tool, summary, args }` in its manifest and every surface can offer it:
// the CLI's dispatcher, the Capsule, the chat's / menu, the Deck's command bar. This module only
// reads what the registry already knows; it keeps nothing and runs nothing until it is asked.
// Switched off, the list is gone and nothing else breaks.

/** The surfaces a list may be asked for. */
export const SURFACES = ["cli", "capsule", "chat", "deck", "phone", "glass"];

/**
 * The commands a caller may run: running modules only, and only those whose tool the caller could
 * call. For now `surface` does not narrow the list. A surface calls as its own caller kind, so the
 * caller is what decides; the manifest has no per-surface field, and none is made up here.
 * @param {any[]} status rows from ctx.modules.status()
 * @param {Set<string>} callable tool names the caller may use
 */
export function listCommands(status, callable) {
  const out = [];
  for (const m of status) {
    if (m.state !== "running" || !Array.isArray(m.commands)) continue;
    for (const c of m.commands) {
      if (!c || !callable.has(c.tool)) continue;
      out.push({ module: m.name, verb: c.verb, tool: c.tool, summary: c.summary, args: Array.isArray(c.args) ? c.args : [] });
    }
  }
  return out.sort((a, b) => a.verb.localeCompare(b.verb) || a.module.localeCompare(b.module));
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("commands.list", {
      effect: "read",
      description: "Every command the running modules offer this caller, sorted by verb: { module, verb, tool, summary, args }. `vyre <module> <verb>` runs `tool`.",
      input: { type: "object", properties: { surface: { type: "string", enum: SURFACES, description: "who is asking; today every surface gets the same list" } } },
      run: async (_input, meta) => listCommands(ctx.modules.status(), new Set(ctx.modules.tools(meta.caller).map(t => t.name))),
    });
    return { async stop() {} };
  },
};

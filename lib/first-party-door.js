// @ts-check
// A first-party tool that declares reach "anyone" is open to an ADDED module too when that module lists it in
// needs.tools (ADR 0047). Most of the vault, the Gate, Google, mail, the MCP hub and the connectors were never
// meant to be: an added module reaches a vendor through ctx.connections, a secret through ctx.vault.fetch and
// the Gate through ctx.gate.request, and nothing else. This wraps ctx.tool so each tool refuses a module caller
// that is not one of Vyre's own (the registry sets meta.firstParty, over anything a caller passes), with the
// same not_declared an undeclared tool gave before the tool declared its reach. Internal and hook tools, and a
// tool whose callers are modules only (the loader's own doors call those), are left as they are. `except` names
// the tools an added module may reach on purpose.

/** @param {any} ctx @param {{ except?: string[] }} [opts] */
export function closeToAddedModules(ctx, { except = [] } = {}) {
  const tool = ctx.tool.bind(ctx);
  ctx.tool = (/** @type {string} */ name, /** @type {any} */ def) => {
    if (!def || def.internal || def.hook || except.includes(name) || (Array.isArray(def.callers) && def.callers.length && def.callers.every((/** @type {string} */ c) => c === "module"))) return tool(name, def);
    const run = def.run;
    return tool(name, { ...def, run: (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (meta && String(meta.caller || "").startsWith("module:") && !meta.firstParty) {
        throw Object.assign(new Error(`${name} is not open to added modules`), { code: "not_declared" });
      }
      return run(input, meta);
    } });
  };
}

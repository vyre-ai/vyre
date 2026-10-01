// @ts-check
// A first-party tool that declares reach "anyone" is open to an ADDED module too when that module lists it in
// needs.tools (ADR 0047). Some were never meant to be: an added module reaches a secret through ctx.vault.fetch,
// not by storing, reading or using one directly. This wraps ctx.tool so the named tools refuse a module caller
// that is not one of Vyre's own (the registry sets meta.firstParty, over anything a caller passes), with the
// same not_declared an undeclared tool gave before the tool declared its reach. Every other tool is left as it is: the
// connectors, the Gate and the MCP hub scope an added module in their own code, and the loader's doors call them.

/** @param {any} ctx @param {{ only?: string[] }} [opts] */
export function closeToAddedModules(ctx, { only = [] } = {}) {
  const tool = ctx.tool.bind(ctx);
  ctx.tool = (/** @type {string} */ name, /** @type {any} */ def) => {
    if (!def || !only.includes(name)) return tool(name, def);
    const run = def.run;
    return tool(name, { ...def, run: (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (meta && String(meta.caller || "").startsWith("module:") && !meta.firstParty) {
        throw Object.assign(new Error(`${name} is not open to added modules`), { code: "not_declared" });
      }
      return run(input, meta);
    } });
  };
}

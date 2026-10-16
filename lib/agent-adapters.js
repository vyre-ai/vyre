// @ts-check
// [reviewed: trust] Every session adapter calls tools the same way. Claude is built in. Codex, Grok and
// any provider a module registers with ctx.provider are the rest. The caller label and the MCP listing
// do not branch on which one it is.

/** Adapters the Switchboard runs when no registered driver is asked for. */
export const BUILTIN_ADAPTERS = Object.freeze(["claude"]);

/**
 * Every session adapter: the built-in ones, then whatever the registry registered. A new provider
 * shows up here because the test reads the registry, not a hand-written list.
 * @param {Iterable<string>} registered
 */
export function sessionAdapters(registered) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  for (const id of [...BUILTIN_ADAPTERS, ...(registered || [])]) {
    const name = String(id || "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The caller label a session of `adapter` uses. Every adapter gets the same shape: `mcp`, or
 * `mcp:agent:<name>` / `mcp:thread:<id>` when vyred has verified one. The adapter id is required
 * so a call site names who is calling, and it does not change the label.
 * @param {string} adapter @param {{ agent?: string, thread?: string }} [opts]
 */
export function sessionCaller(adapter, opts = {}) {
  if (typeof adapter !== "string" || !adapter) throw new Error("sessionCaller needs the adapter id");
  if (opts.agent) return `mcp:agent:${opts.agent}`;
  if (opts.thread) return `mcp:thread:${opts.thread}`;
  return "mcp";
}

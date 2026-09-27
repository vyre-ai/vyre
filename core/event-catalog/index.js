// @ts-check
// events: the catalog of event types (ADR 0033). The folder is event-catalog because core/events
// is the kernel's event bus, which has no manifest; the module and its tools are named "events".
//
// Every type comes from a running module's watches.emits, so the list is what can actually
// arrive on /v1/events right now. A renamed type stays in ALIASES for one release, listed as
// deprecated with the name to use instead, and is then removed. This module keeps nothing and
// runs nothing until it is asked. Switched off, the catalog is gone and nothing else breaks.

/**
 * Old event type to the canonical one, e.g. { "file.changed": "files.changed" }. An alias lasts
 * one release: add it when a type is renamed, remove it in the release after.
 * @type {Record<string, string>}
 */
export const ALIASES = {};

/**
 * @param {any[]} status rows from ctx.modules.status()
 * @param {Record<string, string>} [aliases]
 */
export function catalog(status, aliases = ALIASES) {
  /** @type {Map<string, string>} type to the module that emits it (the first, in load order) */
  const owner = new Map();
  const out = [];
  for (const m of status) {
    if (m.state !== "running" || !Array.isArray(m.emits)) continue;
    for (const type of m.emits) {
      if (!owner.has(type)) owner.set(type, m.name);
      out.push({ type, module: m.name });
    }
  }
  for (const [type, use] of Object.entries(aliases)) out.push({ type, module: owner.get(use) || null, deprecated: true, use });
  return out.sort((a, b) => a.type.localeCompare(b.type) || String(a.module).localeCompare(String(b.module)));
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("events.catalog", {
      description: "Every event type the running modules may emit, sorted: { type, module }. An old name kept for one release after a rename also appears, as { type, module, deprecated: true, use }, where `use` is the name to follow instead.",
      input: { type: "object", properties: {} },
      run: async () => catalog(ctx.modules.status()),
    });
    return { async stop() {} };
  },
};

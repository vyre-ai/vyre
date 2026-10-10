// @ts-check
// events: the catalog of event types (ADR 0033). The folder is event-catalog because kernel/bus (the bus over the kernel log)
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
 * Renames agreed with cohesion (27 Sep 2026), not made yet: each owner renames its own emits, and
 * then the old name moves into ALIASES for one release. Until then the old names are the real
 * ones, so the catalog doesn't mark them.
 *   file.created, file.moved, file.trashed, file.uploaded (glass), file.touched (harness) -> files.*
 *   computer.* (15 types, computers) -> computers.*
 * thread.* stays as it is.
 */
export const PLANNED = Object.freeze({
  "file.created": "files.created", "file.moved": "files.moved", "file.trashed": "files.trashed",
  "file.uploaded": "files.uploaded", "file.touched": "files.touched",
  ...Object.fromEntries(["checked-out", "created", "frozen", "handed-back", "idle-warning", "joined", "left", "paused",
    "released", "resumed", "shielded", "stopped", "taken-over", "thawed", "unshielded"].map(v => [`computer.${v}`, `computers.${v}`])),
});

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
      description: "Every event type the running modules may emit, as { type, module }. A renamed event's old name appears with deprecated: true and `use`.",
      input: { type: "object", properties: {} },
      run: async () => catalog(ctx.modules.status()),
    });
    return { async stop() {} };
  },
};

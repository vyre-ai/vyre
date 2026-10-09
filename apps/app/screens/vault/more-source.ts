// Vault's other calls on a real vyred, over an injected `call` (the app's box connection, or a fake box in a test): vault.caps, vault.pending and vault.approve (what waits for
// the person), vault.pass.list / create / revoke and vault.offboard, vault.devices and vault.device.revoke, vault.health and vault.breach.check (Watchtower), vault.history,
// vault.audit for an item, vault.update (replace a value, or make a new one on the box) and vault.ssh.generate. Acts that need the person are answered by the app's call
// with the device's own proof, so a refusal that reaches here is a real one. A value never comes back from any of these.
import { pickReveals, pickMcpMade, pickBreach, pickCaps, pickDevices, pickHealth, pickHistory, pickPasses, pickPending } from "./more-model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function vaultMoreSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  /** A read that a box without the tool may lack: null, not an error. */
  const maybe = async <T>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> => { const r = await call<T>(tool, input); return r.error ? null : (r.data as T); };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    async caps() { return pickCaps(await maybe("vault.caps")); },
    /** The passes, and what waits for the person (a box without vault.pending has none). */
    async passes() {
      const [p, w] = await Promise.all([ask("vault.pass.list"), maybe("vault.pending")]);
      return { passes: pickPasses(p), pending: w ? pickPending(w) : [], reveals: w ? pickReveals(w) : [] };
    },
    approve: (id: string) => ask("vault.approve", { id }),
    /** Deny an ask: a grant is revoked, a pass is ended. Taking access away is always allowed. */
    deny: (x: { kind: "grant" | "pass"; id: string; name: string; module: string; watcher: string }) =>
      x.kind === "grant" ? ask("vault.revoke", { name: x.name, module: x.module, ...(x.watcher ? { watcher: x.watcher } : {}) }) : ask("vault.pass.revoke", { id: x.id }),
    /** Make a pass: a ticket to send (held for approval first, or made now). */
    async createPass(input: Record<string, unknown>): Promise<{ ticket: string; pending: boolean }> {
      const r = await ask<{ ticket?: string; pass?: { status?: string } }>("vault.pass.create", input);
      return { ticket: typeof r?.ticket === "string" ? r.ticket : "", pending: r?.pass?.status === "pending" };
    },
    /** Make a pass for an outside agent (Claude Code, Codex): the token and the lines to give them, shown once. */
    async createMcpPass(input: Record<string, unknown>) { return pickMcpMade(await ask("vault.mcp.pass.create", input)); },
    /** The api credentials a pass can share and the hosts each is pinned to (names and hosts only). */
    async mcpItems(): Promise<{ name: string; hosts: string[] }[]> { const r = await maybe<{ items?: { name?: unknown; hosts?: unknown }[] }>("vault.mcp.items"); return (r?.items ?? []).filter((x) => typeof x.name === "string").map((x) => ({ name: String(x.name), hosts: list(x.hosts) })); },
    /** Allow an outside agent to see one value, once (your fresh yes), or decline. */
    allowReveal: (id: string) => ask("vault.mcp.reveal.allow", { id }),
    declineReveal: (id: string) => ask("vault.mcp.reveal.clear", { id }),
    /** End an outside agent's pass. Needs no one. */
    async revokeMcpPass(id: string): Promise<void> { await ask("vault.mcp.pass.revoke", { id }); },
    /** End a pass. A sealed one left a copy, so the items to replace come back. */
    async revokePass(id: string): Promise<string[]> { return list((await ask<{ rotate?: unknown }>("vault.pass.revoke", { id }))?.rotate); },
    async offboard(person: string): Promise<{ ended: number; rotate: string[] }> {
      const r = await ask<{ revoked?: unknown; rotate?: unknown }>("vault.offboard", { person });
      return { ended: Array.isArray(r?.revoked) ? r.revoked.length : 0, rotate: list(r?.rotate) };
    },
    async devices() { return pickDevices(await ask("vault.devices")); },
    revokeDevice: (id: string) => ask("vault.device.revoke", { id }),
    async health() { return pickHealth(await ask("vault.health")); },
    async breachCheck() { return pickBreach(await ask("vault.breach.check", {})); },
    /** An item's version history; a box without it, or with none, answers null. */
    async history(name: string) { const r = await maybe("vault.history", { name }); return r ? pickHistory(r) : null; },
    /** Replace values or make a new one on the box. Nothing typed is kept by this source. */
    async update(input: Record<string, unknown>): Promise<{ generated: string }> {
      const r = await ask<{ generated?: string }>("vault.update", input);
      return { generated: typeof r?.generated === "string" ? r.generated : "" };
    },
    /** An ed25519 key made on the box: the private half never leaves it. */
    sshGenerate: (name: string, description?: string) => ask("vault.ssh.generate", { name, ...(description?.trim() ? { description: description.trim() } : {}) }),
  };
}

// Vault's calls, over whatever `call` it is given (the app's box connection, or a fake box in a test).
import type { ListRow, UseRow } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function vaultSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    async listReal(): Promise<{ items: ListRow[]; locked: boolean; personal: string }> {
      const r = await ask<{ items?: ListRow[]; locked?: boolean; personal?: string }>("vault.list");
      return { items: r.items ?? [], locked: Boolean(r.locked), personal: r.personal ?? "none" };
    },
    async usesReal(item: string): Promise<UseRow[]> {
      const r = await ask<{ uses?: UseRow[] }>("vault.uses", { item, limit: 200 });
      return r.uses ?? [];
    },
    /** Reveal one field: a person's own call (the box asks for presence). The value goes back to the caller's state only; nothing here logs or keeps it. */
    async revealReal(name: string, field: string): Promise<string> {
      const r = await ask<{ value?: string }>("vault.reveal", { name, field });
      return String(r.value ?? "");
    },
    /** Taking access away is always allowed: no proof asked. */
    async revokeReal(name: string, module: string): Promise<void> {
      const [mod, watcher] = module.split("/");
      await ask("vault.revoke", { name, module: mod, ...(watcher ? { watcher } : {}) });
    },
  };
}

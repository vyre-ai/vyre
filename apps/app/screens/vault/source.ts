// Vault's calls, over whatever `call` it is given (the app's box connection, or a fake box in a test).
import type { ListRow, UseRow } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string; detail?: { retry_after_s?: number } } }>;

export function vaultSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, detail: r.error.detail });
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
    /** Whether the vault is open and how it unlocks (vault.state). A box without the tool answers null and the screen falls back to vault.list's own `locked`. */
    async stateReal(): Promise<{ locked: boolean; unlock: "passphrase" | "none" } | null> {
      const r = await call<{ locked?: boolean; unlock?: string }>("vault.state");
      if (r.error) return null;
      return { locked: Boolean(r.data?.locked), unlock: r.data?.unlock === "passphrase" ? "passphrase" : "none" };
    },
    /** Unlock the PERSONAL vault from the phone: its password and the person's presence (vault.account.unlock-phone; the desk tool takes the password as the whole proof, a phone must not). */
    unlockPersonalReal: (password: string) => ask<unknown>("vault.account.unlock-phone", { password }),
    /** Unlock a passphrase vault (the first unlock sets the passphrase). */
    unlockReal: (passphrase: string) => ask<unknown>("vault.unlock", { passphrase }),
    /** Add an item: a person's own call, the box asks for presence on this exact save. The value goes to the box and is not kept here. */
    putReal: (input: Record<string, unknown>) => ask<unknown>("vault.put", input),
    /** Taking access away is always allowed: no proof asked. */
    async revokeReal(name: string, module: string): Promise<void> {
      const [mod, watcher] = module.split("/");
      await ask("vault.revoke", { name, module: mod, ...(watcher ? { watcher } : {}) });
    },
  };
}

import { create } from "zustand";
import { call as boxCall } from "../api/box";
import type { Result } from "../api/client";
import { about } from "../api/relay";
import { markDenied } from "./devices";
import { isDenied, readVault, type VaultItem } from "./devices-model";

// The vault's names (vault.list: names, kinds, sites, field names, never a value), and the two
// ways a value leaves it here: vault.reveal (shown on this device, hidden again after the box's
// concealAfter) and vault.copy (the box's clipboard, cleared after 90 s). Both go through the
// one client, so the person session and presence are handled there: the phone proves with its
// biometric key once, and one proof covers 30 minutes. Never queued: a secret is asked for now.

type VaultState = { items: VaultItem[] | null; locked: boolean; error: string | null; loading: boolean };

const useStore = create<VaultState>()(() => ({ items: null, locked: false, error: null, loading: false }));
const set = useStore.setState;

let inflight: Promise<void> | null = null;

/** A call that never throws: a box not reached yet is an offline answer. */
const call = <T,>(tool: string, input: Record<string, unknown> = {}): Promise<Result<T>> =>
  boxCall<T>(tool, input).catch((e: Error) => ({ error: { code: "offline", message: e.message || "the box did not answer" } }));

export function refreshVault(): Promise<void> {
  return (inflight ??= (async () => {
    set({ loading: true });
    try {
      const r = await call<unknown>("vault.list");
      if (r.error) set({ error: r.error.message || r.error.code });
      else {
        const v = readVault(r.data);
        set({ items: v.items, locked: v.locked, error: null });
      }
    } finally {
      set({ loading: false });
      inflight = null;
    }
  })());
}

export const useVaultItems = () => useStore((s) => s.items);
export const useVaultError = () => useStore((s) => s.error);
export const useVaultLocked = () => useStore((s) => s.locked);
export const useVaultItem = (name: string) => useStore((s) => s.items?.find((i) => i.name === name) ?? null);

export type Outcome = { ok: true; value?: string; hideAfter?: number; said?: string } | { ok: false; denied: boolean; message: string };

function refused(e: { code: string; message: string }): Outcome {
  const denied = isDenied(about.kind, e);
  if (denied) markDenied();
  return { ok: false, denied, message: denied ? "This browser can't use vault secrets until you trust it." : e.message || e.code };
}

/** Show one field here. */
export async function reveal(name: string, field: string): Promise<Outcome> {
  const r = await call<{ value: string; concealAfter?: number }>("vault.reveal", { name, field });
  if (r.error) return refused(r.error);
  return { ok: true, value: String(r.data.value ?? ""), hideAfter: Number(r.data.concealAfter) || 10 };
}

/** Copy one field to the box's clipboard; the box says when it clears. */
export async function copy(name: string, field: string): Promise<Outcome> {
  const r = await call<{ copied: boolean; said?: string }>("vault.copy", { name, field });
  if (r.error) return refused(r.error);
  return { ok: true, said: r.data.said || "Copied · clears in 90 s" };
}

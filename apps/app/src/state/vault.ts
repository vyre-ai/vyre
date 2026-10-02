import { create } from "zustand";
import { call as boxCall } from "../api/box";
import type { Result } from "../api/client";
import { about } from "../api/relay";
import { makeClip } from "../vault/clip-model";
import { board } from "../vault/clipboard";
import { markDenied } from "./devices";
import { isDenied, readVault, type VaultItem } from "./devices-model";

// The vault's names (vault.list: names, kinds, sites, field names, never a value), and the two
// ways a value leaves it here, both through vault.reveal: Reveal shows it on this device, hidden
// again after the box's concealAfter; Copy writes it to this device's clipboard without showing
// it, cleared after 30 s where that can be done (clip-model.ts), and asks with purpose "copy" so the
// audit says "copy on <device>". Copy never goes to the Mac: the
// app does not call vault.copy. Both go through the one client, so the person session and
// presence are handled there: the phone proves with its biometric key once, and one proof
// covers 30 minutes. Never queued: a secret is asked for now. A value is never logged or stored.

type VaultState = { items: VaultItem[] | null; locked: boolean; error: string | null; loading: boolean };

const useStore = create<VaultState>()(() => ({ items: null, locked: false, error: null, loading: false }));
const set = useStore.setState;

let inflight: Promise<void> | null = null;

/** A call that never throws: a box not reached yet is an offline answer. */
const call = <T,>(tool: string, input: Record<string, unknown> = {}): Promise<Result<T>> =>
  boxCall<T>(tool, input).catch((e: Error) => ({ error: { code: "offline", message: e.message || "your server did not answer" } }));

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

const clip = makeClip(board, { set: (f, ms) => setTimeout(f, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) });

/**
 * Copy one field to this device's clipboard. The write starts before the box answers, so a
 * browser keeps the tap's permission; the value is not shown.
 */
export function copy(name: string, field: string): Promise<Outcome> {
  const out: { refusal?: Outcome } = {};
  const pending = call<{ value: string }>("vault.reveal", { name, field, purpose: "copy" }).then((r) => {
    if (r.error) {
      out.refusal = refused(r.error);
      return null;
    }
    return String(r.data.value ?? "");
  });
  return clip.copy(pending).then((done): Outcome => {
    if (out.refusal) return out.refusal;
    return done ? { ok: true, said: done.said } : { ok: false, denied: false, message: "Couldn't copy on this device" };
  });
}

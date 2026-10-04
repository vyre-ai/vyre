// Kits' calls on the real box (flows.kit.list, flows.kit.remove), over an injected `call`. Removing takes the Kit's definitions away and never a record.
import type { KitRow, LibraryKit } from "./kits-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function kitsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<KitRow[]> => { const r = await ask<KitRow[]>("flows.kit.list"); return Array.isArray(r) ? r : []; },
    /** The Kits the box offers (flows.kit.library). A box without the tool offers none: null, so the screen shows no Available section rather than an invented one. */
    library: async (): Promise<LibraryKit[] | null> => {
      const r = await call<LibraryKit[] | { kits?: LibraryKit[] }>("flows.kit.library");
      if (r.error) { if (r.error.code === "no_such_tool" || r.error.code === "not_available" || r.error.code === "not_found") return null; throw Object.assign(new Error(r.error.message), { code: r.error.code }); }
      const d = r.data; return Array.isArray(d) ? d : Array.isArray(d?.kits) ? d.kits : [];
    },
    /** The install card for a library Kit: what it adds and what each part may do, read before anything changes. */
    card: async (id: string): Promise<{ kit: unknown; card: unknown }> => {
      const got = await ask<{ kit?: unknown }>("flows.kit.library.get", { id });
      const kit = got && typeof got === "object" && "kit" in got && got.kit ? got.kit : got;
      return { kit, card: await ask<unknown>("flows.kit.card", { kit }) };
    },
    /** Ask to install it: nothing changes until a person approves the card, which lands in Now. */
    propose: (kit: unknown) => ask<{ ok?: boolean; errors?: { path: string; message: string }[] }>("flows.kit.propose", { kit }),
    remove: (id: string) => ask<unknown>("flows.kit.remove", { id }),
  };
}

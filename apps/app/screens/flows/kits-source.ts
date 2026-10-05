// Kits' calls on the real box (flows.kit.list, flows.kit.remove), over an injected `call`. Removing takes the Kit's definitions away and never a record.
import type { KitDiff, KitRow, LibraryKit } from "./kits-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

async function kitCardVia(ask: <T>(tool: string, input?: Record<string, unknown>) => Promise<T>, id: string): Promise<{ kit: unknown; card: unknown }> {
  const got = await ask<{ kit?: unknown }>("flows.kit.library.get", { id });
  const kit = got && typeof got === "object" && "kit" in got && got.kit ? got.kit : got;
  return { kit, card: await ask<unknown>("flows.kit.card", { kit }) };
}

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
      // records owns the library today (records.kits.library); the flows names are what platform may register later.
      let r = await call<LibraryKit[] | { kits?: LibraryKit[] }>("records.kits.library");
      if (r.error?.code === "no_such_tool") r = await call<LibraryKit[] | { kits?: LibraryKit[] }>("flows.kit.library");
      if (r.error) { if (r.error.code === "no_such_tool" || r.error.code === "not_available" || r.error.code === "not_found") return null; throw Object.assign(new Error(r.error.message), { code: r.error.code }); }
      const d = r.data; return Array.isArray(d) ? d : Array.isArray(d?.kits) ? d.kits : [];
    },
    /** The install card for a library Kit: what it adds and what each part may do, read before anything changes. */
    card: async (id: string): Promise<{ kit: unknown; card: unknown }> => {
      const g = await call<{ kit?: unknown }>("records.kits.get", { id });
      if (g.error?.code === "no_such_tool") return kitCardVia(ask, id);
      if (g.error) throw Object.assign(new Error(g.error.message), { code: g.error.code });
      const got = g.data as { kit?: unknown };
      const kit = got && typeof got === "object" && "kit" in got && got.kit ? got.kit : got;
      return { kit, card: await ask<unknown>("flows.kit.card", { kit }) };
    },
    /** The library's own copy of one Kit, in the form the card, diff and propose take. */
    libraryKit: async (id: string): Promise<unknown> => {
      let g = await call<{ kit?: unknown }>("flows.kit.library.get", { id });
      if (g.error?.code === "no_such_tool") g = await call<{ kit?: unknown }>("records.kits.get", { id });
      if (g.error) throw Object.assign(new Error(g.error.message), { code: g.error.code });
      const got = g.data as { kit?: unknown };
      return got && typeof got === "object" && "kit" in got && got.kit ? got.kit : got;
    },
    /** What updating an installed Kit to this version changes. Read only: asks nobody and writes nothing. */
    diff: (kit: unknown) => ask<KitDiff>("flows.kit.diff", { kit }),
    /** Ask to install it: nothing changes until a person approves the card, which lands in Now. */
    propose: (kit: unknown) => ask<{ ok?: boolean; errors?: { path: string; message: string }[] }>("flows.kit.propose", { kit }),
    remove: (id: string) => ask<unknown>("flows.kit.remove", { id }),
  };
}

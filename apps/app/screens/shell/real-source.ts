// The shell's calls on the real box: spaces.list for the switcher and spaces.identity.status for the person, over an injected `call`.
// onboard.space.list adds spaces this identity joined or created that the box list does not have yet. real-model.ts turns the rows into the switcher.
import type { IdentityRow, SpaceRow } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

type Listed = { spaces?: Array<SpaceRow & { server?: string | null }> };

export function shellSource(call: Call) {
  return {
    /** The identity is optional: a box with none still shows its spaces. A missing onboard list leaves the box list as it is. */
    async load(): Promise<{ spaces: SpaceRow[]; identity: IdentityRow | null }> {
      const [sp, id, mine] = await Promise.all([
        call<SpaceRow[]>("spaces.list"),
        call<IdentityRow>("spaces.identity.status"),
        call<Listed>("onboard.space.list").catch(() => null),
      ]);
      if (sp.error) throw Object.assign(new Error(sp.error.message), { code: sp.error.code });
      const rows = Array.isArray(sp.data) ? sp.data.slice() : [];
      const extra = mine && !mine.error && mine.data && Array.isArray(mine.data.spaces) ? mine.data.spaces : [];
      const known = new Set(rows.map((r) => r.id));
      const names = new Set(rows.map((r) => String(r.label || r.name || "").replace(/\.vyre\.run$/i, "")));
      for (const s of extra) {
        if (!s || !s.id || known.has(s.id)) continue;
        const name = String(s.label || s.name || "").replace(/\.vyre\.run$/i, "");
        if (name && names.has(name)) continue;
        known.add(s.id);
        rows.push({ id: s.id, name: s.name || name, label: name, role: s.role, status: "done" });
      }
      return { spaces: rows, identity: id.error ? null : (id.data ?? null) };
    },
  };
}

// The shell's calls on the real box: spaces.list for the switcher and spaces.identity.status for the person, over an injected `call`. It returns the box's rows as they are;
// real-model.ts turns them into the shell's data.
import type { IdentityRow, SpaceRow } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function shellSource(call: Call) {
  return {
    /** Both reads at once. The identity is optional: a box with none still shows its spaces. */
    async load(): Promise<{ spaces: SpaceRow[]; identity: IdentityRow | null }> {
      const [sp, id] = await Promise.all([call<SpaceRow[]>("spaces.list"), call<IdentityRow>("spaces.identity.status")]);
      if (sp.error) throw Object.assign(new Error(sp.error.message), { code: sp.error.code });
      return { spaces: Array.isArray(sp.data) ? sp.data : [], identity: id.error ? null : (id.data ?? null) };
    },
  };
}

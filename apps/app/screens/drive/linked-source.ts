// Files > Linked's calls on the real box over an injected `call`: files.linked.* (core/files/linked.js, linked-read.js). Linking, saving and unlinking are the person's own acts.
import type { LinkedEntry, LinkedFile, LinkedFolder, LinkedVersion, PickFolder, ProviderInfo, SyncState } from "./linked-model";
import type { Call } from "./source";

export function linkedSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<LinkedFolder[]> => (await ask<{ links?: LinkedFolder[] }>("files.linked.list"))?.links ?? [],
    providers: async (): Promise<ProviderInfo[]> => (await ask<{ providers?: ProviderInfo[] }>("files.linked.providers"))?.providers ?? [],
    /** The folders inside `parent` (the source's top when none) that this person's account may link. */
    pick: (provider: string, parent?: string) => ask<{ parent: string; folders: PickFolder[] }>("files.linked.pick", { provider, ...(parent ? { parent } : {}) }),
    link: (name: string, provider: string, source: Record<string, unknown>) => ask<LinkedFolder>("files.linked.link", { name, provider, source }),
    unlink: (id: string) => ask<{ unlinked: boolean }>("files.linked.unlink", { id }),
    sync: (id: string, full?: boolean) => ask<SyncState>("files.linked.sync", { id, ...(full ? { full: true } : {}) }),
    status: (id: string) => ask<{ link: LinkedFolder; sync: SyncState | null }>("files.linked.status", { id }),
    ls: (id: string, path = "") => ask<{ path: string; entries: LinkedEntry[] }>("files.linked.ls", { id, ...(path ? { path } : {}) }),
    read: (id: string, path: string) => ask<LinkedFile>("files.linked.read", { id, path }),
    /** `baseRev` is the rev the person opened; without it the file is created (or replaced). */
    write: (id: string, path: string, base64: string, baseRev?: string) => ask<{ path: string; rev: string }>("files.linked.write", { id, path, base64, ...(baseRev ? { base_rev: baseRev } : {}) }),
    /** Every file in this person's index of each linked folder, for the # picker. */
    tree: async (): Promise<{ id: string; name: string; files: { path: string }[] }[]> => (await ask<{ folders?: { id: string; name: string; files: { path: string }[] }[] }>("files.linked.tree"))?.folders ?? [],
    versions: async (id: string, path: string): Promise<LinkedVersion[]> => (await ask<{ versions?: LinkedVersion[] }>("files.linked.versions", { id, path }))?.versions ?? [],
  };
}

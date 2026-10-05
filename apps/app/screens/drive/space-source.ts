// The Space Drive's calls on the real box over an injected `call`: files.drive.space.list, files.drive.space.read, files.drive.upload, files.drive.versions, files.drive.restore (the person's own act).
import type { LinkRow, SpaceEntry, Version } from "./space-model";
import type { Call } from "./source";

export function spaceDriveSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** Every page under a folder, up to a cap so a huge Drive cannot hold the screen. */
    list: async (space: string | undefined, prefix: string): Promise<{ entries: SpaceEntry[]; more: boolean }> => {
      const entries: SpaceEntry[] = [];
      let after: string | null = null;
      for (let page = 0; page < 5; page++) {
        const r: { entries?: SpaceEntry[]; next?: string | null } = await ask("files.drive.space.list", { ...(space ? { space } : {}), prefix, limit: 500, ...(after ? { after } : {}) });
        entries.push(...(r.entries ?? []));
        after = r.next ?? null;
        if (!after) break;
      }
      return { entries, more: !!after };
    },
    read: (space: string | undefined, path: string, version?: number) => ask<{ path: string; version: number; size: number; base64: string }>("files.drive.space.read", { ...(space ? { space } : {}), path, ...(version ? { version } : {}) }),
    upload: (space: string | undefined, path: string, base64: string, base?: number) => ask<{ path: string; version: number; conflict: boolean; size: number }>("files.drive.upload", { ...(space ? { space } : {}), path, base64, ...(base ? { base } : {}) }),
    versions: async (space: string | undefined, path: string): Promise<Version[]> => { const r = await ask<{ versions?: Version[] }>("files.drive.versions", { ...(space ? { space } : {}), path }); return r?.versions ?? []; },
    /** Make a link to one version of a file: outward, so the box asks for the person's own yes (an assistant's ask is held in Now). */
    linkCreate: (space: string | undefined, path: string, version?: number, days?: number) => ask<LinkRow>("files.drive.link.create", { ...(space ? { space } : {}), path, ...(version ? { version } : {}), ...(days ? { days } : {}) }),
    linkList: async (): Promise<LinkRow[]> => { const r = await ask<{ links?: LinkRow[] }>("files.drive.link.list"); return r?.links ?? []; },
    /** Taking a link away is always allowed: no proof asked. It deletes the copy. */
    linkRevoke: (code: string) => ask<{ revoked: boolean }>("files.drive.link.revoke", { code }),
    restore: (space: string | undefined, path: string, version: number) => ask<{ path: string; from: number; version: number }>("files.drive.restore", { ...(space ? { space } : {}), path, version }),
  };
}

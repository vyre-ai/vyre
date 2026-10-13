// A project's Instructions and Context on the real box (projects.docs.*, projects.refs.*), as the FolderApi the shared editors take.
import type { Call } from "../settings/real-source";
import type { DocFile, FolderApi, Item } from "./model.ts";

export function projectFolderApi(call: Call, project: string, canEdit = true): FolderApi {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, { project, ...input });
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    id: `project:${project}`,
    canEdit,
    docs: async () => { const d = await ask<any>("projects.docs.get"); return { "AGENTS.md": String(d?.files?.["AGENTS.md"] ?? "") }; },
    saveDoc: (file: DocFile, text: string) => ask("projects.docs.set", { file, text }),
    context: async (): Promise<Item[]> => { const d = await ask<any>("projects.refs.list"); return Array.isArray(d?.items) ? d.items : []; },
    addFile: (name, base64) => ask("projects.refs.add", { name, base64 }),
    addNote: (name, text) => ask("projects.refs.add", { name, text }),
    addLink: (name, files) => ask("projects.refs.add", { name, files }),
    remove: (name) => ask("projects.refs.remove", { name }),
  };
}

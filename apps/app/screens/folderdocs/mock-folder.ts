// The sample world's Instructions and Context for a folder: kept in memory for the session, so the editors can be used in the preview with no box.
import type { DocFile, FolderApi, Item } from "./model.ts";

const kept = new Map<string, { docs: Record<DocFile, string>; items: Item[] }>();
const of = (id: string) => { let k = kept.get(id); if (!k) { k = { docs: { "AGENTS.md": "", "CLAUDE.md": "" }, items: [{ name: "Trust certificate.pdf", kind: "link", size: 0, files: "Projects/northwind/files/Trust certificate.pdf" }] }; kept.set(id, k); } return k; };

export function mockFolderApi(id: string): FolderApi {
  return {
    id: `mock:${id}`, kept: true, canEdit: true,
    docs: async () => ({ ...of(id).docs }),
    saveDoc: async (file, text) => { const k = of(id); k.docs = { "AGENTS.md": text, "CLAUDE.md": text }; void file; },
    context: async () => [...of(id).items],
    addFile: async (name, base64) => { of(id).items.push({ name, kind: "file", size: Math.round(base64.length * 0.75) }); },
    addNote: async (name, text) => { of(id).items.push({ name, kind: "note", size: text.length }); },
    addLink: async (name, files) => { of(id).items.push({ name, kind: "link", size: 0, files }); },
    remove: async (name) => { const k = of(id); k.items = k.items.filter((x) => x.name !== name); },
  };
}

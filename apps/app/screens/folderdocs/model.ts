// The pure half of the Instructions and Context editors that an agent's page and a project's page share: what a folder's docs and context items are, and the lines drawn for them. No calls here.
import { sizeLine } from "../assistants/config-model.ts";

export type DocFile = "AGENTS.md";
export type Item = { name: string; kind: "file" | "note" | "link"; size: number; files?: string };

/** What the instructions editor calls: an agent's and a project's docs, the same shape. */
export type DocsApi = Pick<FolderApi, "id" | "docs" | "saveDoc" | "canEdit">;

/** What one folder's editors call. A project's and an agent's are the same shape, over different tools. */
export type FolderApi = {
  /** Names the folder, so a screen can make the api again on every draw: the editors reload when this changes, not when the object does. */
  id: string;
  docs: () => Promise<Record<DocFile, string>>;
  saveDoc: (file: DocFile, text: string) => Promise<unknown>;
  context: () => Promise<Item[]>;
  addFile: (name: string, base64: string) => Promise<unknown>;
  addNote: (name: string, text: string) => Promise<unknown>;
  addLink: (name: string, filesPath: string) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  /** Whether this person may change them (Can edit); false hides every write. */
  canEdit?: boolean;
};

/** The one instructions file, as it is named under the title. Every tool and model reads it. */
export const DOC_NAME = "AGENTS.md";
export const READ_ONLY_NOTE = "You can read this. Changing it takes Can edit.";

/** One row of context: its name as a person reads it, and one line under it. */
export function itemLine(i: Item): { title: string; sub: string } {
  if (i.kind === "link") return { title: i.name.replace(/\.link$/, ""), sub: i.files ? `In Files: ${i.files}` : "A place in Files" };
  if (i.kind === "note") return { title: i.name.replace(/\.md$/, ""), sub: `Note, ${sizeLine(i.size)}` };
  return { title: i.name, sub: `File, ${sizeLine(i.size)}` };
}

/** What a person typed for a Files reference, tidied; empty when it names nothing. */
export const filesPath = (s: string): string => s.trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");

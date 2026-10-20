// The Files screen's real sources, from the same calls the Space Drive, linked folders and box shares already use (real.ts). `linkedNames` is filled by the screen as it learns the linked folders.
import { filesLoader } from "./files-source.ts";
import { driveTool, linked, listReal, spaceList } from "./real";
import { withTimeout } from "../../src/real/with-timeout.js";
import { NAMES_MS } from "./files-keep.js";

export const linkedNames: Record<string, string> = {};
/** A project's folder is named by its id (Projects/<id>), an agent's too (agents/<id>); files.places has their names. Filled once, then used by the listing, the tree and the path above it. */
export const folderNames: Record<string, string> = {};
let named: Promise<void> | null = null;
export const learnFolderNames = () => (named ??= driveTool<{ projects?: { name: string; path: string }[]; agents?: { name: string; path: string }[] }>("files.places", {}).then((r) => { for (const p of [...(r?.projects ?? []), ...(r?.agents ?? [])]) if (p.path && p.name) folderNames[p.path] = p.name; }).catch(() => {}));
export const loader = filesLoader({ space: { list: spaceList }, linked, box: { list: listReal }, linkedNames: () => linkedNames, names: async () => { await withTimeout(learnFolderNames(), NAMES_MS).catch(() => { named = null; }); return folderNames; } });

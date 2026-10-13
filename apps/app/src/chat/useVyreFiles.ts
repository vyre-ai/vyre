// "From Vyre Files" in the composer: the space Drive's files as a list the keyboard can search, and what picking one does (read it, then add it through the same attachment path as a file from the computer).
// Real: files.drive.space.list and files.drive.space.read (screens/drive/real.ts). The sample world offers a few files and adds a chip without a box.
import { useCallback, useEffect, useMemo, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { spaceList, spaceRead } from "../../screens/drive/real";
import type { Picked } from "./attach-pick";

type VyreFile = { id: string; name: string; path: string };
const SAMPLE: VyreFile[] = [
  { id: "Projects/northwind/files/Trust certificate.pdf", name: "Trust certificate.pdf", path: "Northwind Bakery / files" },
  { id: "Projects/northwind/made/Site visit.mp4", name: "Site visit.mp4", path: "Northwind Bakery / made" },
  { id: "Projects/okafor/files/Deed scan.png", name: "Deed scan.png", path: "Okafor estate / files" },
  { id: "space/Voice note.mp3", name: "Voice note.mp3", path: "Space documents" },
];
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const mimeOf = (name: string) => MIME[(name.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";

/** The folder a file is in, in words: each folder shown by the name the Drive gives it (a project's name, a chat's title) when it has one. */
function folderWords(path: string, names: Record<string, string>): string {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => names[parts.slice(0, i + 1).join("/")] ?? parts[i]).join(" / ");
}

export function useVyreFiles(add: (files: Picked[]) => Promise<void>, addReady: (f: { name: string; mime: string; bytes: number }) => void) {
  const [files, setFiles] = useState<VyreFile[]>(allowsMock() ? SAMPLE : []);
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    spaceList(undefined, "").then((l) => {
      if (!live) return;
      const rows = l.entries.filter((e) => e.path).map((e) => ({ at: Number(e.at ?? e.mtime ?? 0) || 0, path: String(e.path) }));
      rows.sort((a, b) => b.at - a.at);
      setFiles(rows.slice(0, 400).map((r) => ({ id: r.path, name: r.path.split("/").pop() ?? r.path, path: folderWords(r.path, l.names ?? {}) })));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const pick = useCallback(async (id: string) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    if (allowsMock()) { addReady({ name: f.name, mime: mimeOf(f.name), bytes: 120 * 1024 }); return; }
    const r = await spaceRead(undefined, id);
    await add([{ name: f.name, mime: mimeOf(f.name), bytes: r.size, base64: r.base64 }]);
  }, [files, add, addReady]);
  return useMemo(() => ({ files, pick }), [files, pick]);
}

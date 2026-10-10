// Choosing files to add to a message in a browser: a file input made and clicked on demand, and the files of a paste or a drop. Read once into base64; nothing is stored here.
import type { Picked } from "./attach-pick";
export type { Picked };
export const canPick = true;

const readOne = (f: File): Promise<Picked> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const s = String(reader.result ?? ""); resolve({ name: f.name || "pasted file", mime: f.type || "application/octet-stream", bytes: f.size, base64: s.slice(s.indexOf(",") + 1) }); };
  reader.onerror = () => reject(new Error("The file could not be read."));
  reader.readAsDataURL(f);
});

/** Read files the browser handed over (a paste, a drop, the picker). */
export async function readFiles(files: Iterable<File>): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const f of files) out.push(await readOne(f));
  return out;
}

/** Open the browser's file chooser. `photo` offers pictures only. An empty list when the person closes it. */
export function pickFiles(photo: boolean): Promise<Picked[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; if (photo) input.accept = "image/*";
    input.onchange = () => { readFiles(Array.from(input.files ?? [])).then(resolve, () => resolve([])); };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

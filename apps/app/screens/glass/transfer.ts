// The two byte moves Glass makes outside tool calls, on the box's own routes with a one-time ticket: a download (an <a download> click) and an upload (a PUT with progress).
// The ticket is the credential, so neither carries anything else.
import { boxOrigin } from "../../src/api/box";
import { rawUrl } from "./model";

/** Save a file the box handed a ticket for. Returns false when the ticket's path is not on the box. */
export function saveFile(path: string, name: string): boolean {
  const url = rawUrl(boxOrigin() || location.origin, path);
  if (!url) return false;
  const a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  return true;
}

/** Open a ticketed file (a PDF) in its own tab, from the box's raw route with its own strict headers. */
export function openFile(path: string): boolean {
  const url = rawUrl(boxOrigin() || location.origin, path);
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** The address of an image preview. */
export const imageUrl = (path: string): string | null => rawUrl(boxOrigin() || location.origin, path);

export type Upload = { done: Promise<void>; abort: () => void };
/** PUT a file's bytes to an upload ticket's path, reporting progress. */
export function putBytes(path: string, file: File, progress: (sent: number, total: number) => void): Upload {
  const x = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    const url = rawUrl(boxOrigin() || location.origin, path);
    if (!url) { reject(Object.assign(new Error("the upload path is not on your server"), { code: "bad_path" })); return; }
    x.open("PUT", url);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (e) => progress(e.loaded, e.lengthComputable ? e.total : file.size);
    x.onload = () => {
      let b: { error?: { code?: string; message?: string } } | null = null;
      try { b = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && !b?.error) resolve();
      else reject(Object.assign(new Error(b?.error?.message || x.statusText || `your server answered ${x.status}`), { code: b?.error?.code || `http_${x.status}` }));
    };
    x.onerror = () => reject(Object.assign(new Error("the upload did not reach your server"), { code: "offline" }));
    x.onabort = () => reject(Object.assign(new Error("upload cancelled"), { code: "aborted" }));
    x.send(file);
  });
  return { done, abort: () => x.abort() };
}

/** Ask the browser for files to upload. Resolves the chosen files (none when cancelled). */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file"; i.multiple = true; i.hidden = true;
    i.onchange = () => { resolve(Array.from(i.files ?? [])); i.remove(); };
    i.oncancel = () => { resolve([]); i.remove(); };
    document.body.append(i);
    i.click();
  });
}

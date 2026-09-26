// @ts-check
// The one byte transfer the Deck makes outside js/api.js: an upload's body, PUT to the ticketed
// path that glass.files.upload returned (/v1/glass/put?ticket=...), with progress. It belongs in
// js/api.js next to call(); it lives here until the deck workstream moves it.

/**
 * @param {string} path a same-origin ticketed put path
 * @param {Blob} body
 * @param {(sent: number, total: number) => void} [progress]
 * @returns {{ done: Promise<any>, abort: () => void }}
 */
export function upload(path, body, progress) {
  const x = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    if (!path.startsWith("/")) { reject(Object.assign(new Error("the upload path is not on this box"), { code: "bad_path" })); return; }
    x.open("PUT", path);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.setRequestHeader("x-vyre-caller", "deck");
    x.upload.onprogress = e => progress?.(e.loaded, e.lengthComputable ? e.total : body.size);
    x.onload = () => {
      let b = null;
      try { b = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300 && !b?.error) resolve(b?.data ?? b);
      else reject(Object.assign(new Error(b?.error?.message || x.statusText || `the box answered ${x.status}`), { code: b?.error?.code || `http_${x.status}` }));
    };
    x.onerror = () => reject(Object.assign(new Error("the upload did not reach the box"), { code: "offline" }));
    x.onabort = () => reject(Object.assign(new Error("upload cancelled"), { code: "aborted" }));
    x.send(body);
  });
  return { done, abort: () => x.abort() };
}

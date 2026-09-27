// @ts-check
// Fakes for the apps tests: an exec that records every call and answers from a function, so no
// osascript, shortcuts, open or plutil ever runs, a fetch that answers from canned JSON, and
// fake .app bundles for the installed-apps scan.

import fs from "node:fs";
import path from "node:path";

/**
 * @param {(file: string, args: string[], opts: any) => any} [answer]
 */
export function fakeExec(answer = () => ({})) {
  /** @type {{ file: string, args: string[], opts: any }[]} */
  const calls = [];
  const exec = async (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ opts = {}) => {
    calls.push({ file, args: [...args], opts });
    return { code: 0, stdout: "", stderr: "", ...(await answer(file, args, opts)) };
  };
  return { exec, calls };
}

/**
 * A fetch that answers by URL: the first route whose key the URL contains wins. A route that is
 * an Error rejects, as a network failure does.
 * @param {Record<string, any>} routes
 */
export function fakeFetch(routes) {
  /** @type {string[]} */
  const urls = [];
  const fetch = async (/** @type {string} */ url) => {
    urls.push(String(url));
    const key = Object.keys(routes).find(k => String(url).includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const body = routes[key];
    if (body instanceof Error) throw body;
    if (body && body.status) return { ok: false, status: body.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return { fetch, urls };
}

/** Make a fake .app bundle. `id` null leaves out the plist; `binary` writes a bplist header. */
export function fakeApp(/** @type {string} */ dir, /** @type {string} */ name, /** @type {string | null} */ id, binary = false) {
  const contents = path.join(dir, `${name}.app`, "Contents");
  fs.mkdirSync(contents, { recursive: true });
  if (id === null) return;
  fs.writeFileSync(path.join(contents, "Info.plist"), binary ? Buffer.concat([Buffer.from("bplist00"), Buffer.from([0, 1, 2])])
    : `<?xml version="1.0"?><plist><dict>\n<key>CFBundleName</key><string>${name}</string>\n<key>CFBundleIdentifier</key>\n\t<string>${id}</string></dict></plist>`);
}

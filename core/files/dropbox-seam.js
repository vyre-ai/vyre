// @ts-check
// dropbox-seam: Dropbox for Files > Linked, as ONE person (core/files/linked-dropbox.js calls it through files.dropbox.linked).
//
// Whose token: the calling person's own Vault item, and nobody else's. `tokenFor(person)` is handed in (files/index.js: the owner's own "dropbox" item, or a member's own through
// vault.me.release); it answers a plain sentence when there is none. There is no fallback to another person's item, and no firm key.
// What goes out: a fixed host list (api.dropboxapi.com for calls, content.dropboxapi.com for file bytes), over https, with redirects refused so the token never follows one. Only the file calls
// below pass, and files/delete_v2 never does: Dropbox cannot undo it, so the provider moves a file to "Vyre Trash" instead. A read stops at 25 MB. An error that leaves here has the token and every
// token-looking value removed and is cut to 300 characters.

import { scrub } from "../../lib/scrub.js";

export const NO_TOKEN = "Connect your Dropbox in the Vault first";
export const HOSTS = Object.freeze({ rpc: "api.dropboxapi.com", content: "content.dropboxapi.com" });
export const MAX_READ = 25 * 1024 * 1024;
export const MAX_WRITE = 25 * 1024 * 1024;
const RPC = new Set(["/2/files/list_folder", "/2/files/list_folder/continue", "/2/files/list_folder/get_latest_cursor", "/2/files/get_metadata", "/2/files/move_v2", "/2/files/create_folder_v2", "/2/files/list_revisions"]);
const CONTENT = new Set(["/2/files/download", "/2/files/upload"]);
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_JSON = 8 * 1024 * 1024;
const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** A message with the token, every bearer token, authorization header and token-valued field removed, cut to 300 characters. @param {unknown} s @param {string} [token] */
export function strip(s, token) {
  let t = String(s ?? "");
  if (token && token.length >= 6) t = scrub(t, [token], { marker: "[removed]", min: 6 });
  return t
    .replace(/\bauthorization\b\s*[:=]\s*\S+(?:\s+\S+)?/gi, "[removed]")
    .replace(/\bBearer\s+[^\s"',;}]+/gi, "[removed]")
    .replace(/\bsl\.[A-Za-z0-9_-]{16,}/g, "[removed]")
    .replace(/\b((?:access|refresh|id)_token|client_secret|app_secret|api[_-]?key)\b(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1$2[removed]")
    .slice(0, 300);
}

/** JSON for a header: Dropbox wants plain ASCII there, so every other character goes as \uXXXX. @param {unknown} v */
export const headerJson = v => JSON.stringify(v ?? {}).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/**
 * @param {{ tokenFor: (person: string) => Promise<string>, fetch?: typeof fetch, timeoutMs?: number }} d
 */
export function dropboxSeam({ tokenFor, fetch: doFetch = globalThis.fetch, timeoutMs = 30_000 }) {
  /**
   * @param {string} person
   * @param {{ path: string, args?: any, bodyB64?: string, raw?: boolean }} req
   * @returns {Promise<{ status: number, body?: any, bytesB64?: string, result?: any, message?: string }>} a Dropbox refusal comes back as its status, not as a throw
   */
  async function run(person, req) {
    const path = String((req && req.path) ?? "");
    if (/delete/i.test(path)) throw fail("Vyre never deletes from Dropbox for good; it moves a file to Vyre Trash inside the linked folder", "denied");
    const host = RPC.has(path) ? HOSTS.rpc : CONTENT.has(path) ? HOSTS.content : null;
    if (!host) throw fail("only Dropbox file calls can be reached from a linked folder", "bad_input");
    if (!PERSON.test(String(person))) throw fail(NO_TOKEN, "no_account");
    const upload = path === "/2/files/upload";
    let bytes;
    if (upload) {
      bytes = typeof req.bodyB64 === "string" ? Buffer.from(req.bodyB64, "base64") : Buffer.alloc(0);
      if (bytes.length > MAX_WRITE) throw fail("That file is over 25 MB, which is as much as Vyre sends to Dropbox", "too_large");
    }
    let token;
    try { token = await tokenFor(String(person)); } catch { throw fail(NO_TOKEN, "no_account"); }
    if (typeof token !== "string" || !token.trim()) throw fail(NO_TOKEN, "no_account");
    const url = `https://${host}${path}`;
    const headers = /** @type {Record<string, string>} */ ({ Authorization: `Bearer ${token}` });
    /** @type {any} */ let body;
    if (host === HOSTS.rpc) { headers["Content-Type"] = "application/json"; body = JSON.stringify(req.args ?? {}); }
    else { headers["Dropbox-API-Arg"] = headerJson(req.args); if (upload) { headers["Content-Type"] = "application/octet-stream"; body = bytes; } }
    let res;
    try { res = await doFetch(url, { method: "POST", headers, ...(body !== undefined ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw fail(strip((/** @type {any} */ (e)).message, token) || "Dropbox did not answer", "unavailable"); }
    if (res.status < 200 || res.status >= 300) {
      let text = "";
      try { text = await res.text(); } catch { /* the status alone says enough */ }
      let summary = text;
      try { const j = JSON.parse(text); if (j && typeof j.error_summary === "string") summary = j.error_summary; } catch { /* not JSON */ }
      return { status: res.status, message: strip(summary || `Dropbox answered ${res.status}`, token) };
    }
    if (path === "/2/files/download") {
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_READ) throw fail("That file is over 25 MB, which is as much as Vyre opens from Dropbox", "too_large");
      const chunks = []; let n = 0;
      if (res.body && typeof res.body.getReader === "function") {
        const rd = res.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          n += value.length;
          if (n > MAX_READ) { try { await rd.cancel(); } catch { /* closing */ } throw fail("That file is over 25 MB, which is as much as Vyre opens from Dropbox", "too_large"); }
          chunks.push(Buffer.from(value));
        }
      } else { const all = Buffer.from(await res.arrayBuffer()); if (all.length > MAX_READ) throw fail("That file is over 25 MB, which is as much as Vyre opens from Dropbox", "too_large"); chunks.push(all); }
      let result; try { result = JSON.parse(res.headers.get("dropbox-api-result") || "{}"); } catch { result = {}; }
      return { status: 200, bytesB64: Buffer.concat(chunks).toString("base64"), result };
    }
    const text = await res.text();
    if (text.length > MAX_JSON) throw fail("Dropbox answered with more than Vyre reads", "too_large");
    let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { throw fail("Dropbox did not answer in a way Vyre understands", "unavailable"); }
    return { status: 200, body: parsed };
  }
  return { run };
}

/** The `client` linked-dropbox.js wants, over a function that calls files.dropbox.linked. @param {(input: any) => Promise<{ data?: any, error?: { code?: string, message?: string } }>} call */
export function dropboxClient(call) {
  return {
    /** @param {string} person @param {{ path: string, args?: any, body?: Uint8Array, raw?: boolean }} req */
    async request(person, req) {
      const { body, raw, ...rest } = req || /** @type {any} */ ({});
      const r = await call({ person, ...rest, ...(raw ? { raw: true } : {}), ...(body instanceof Uint8Array ? { bodyB64: Buffer.from(body).toString("base64") } : {}) });
      if (r.error) throw Object.assign(new Error(strip(r.error.message) || NO_TOKEN), { code: r.error.code || "failed" });
      const d = r.data;
      if (d.status !== 200) throw Object.assign(new Error(strip(d.message) || `Dropbox answered ${d.status}`), { status: d.status });
      return raw ? { bytes: new Uint8Array(Buffer.from(d.bytesB64, "base64")), result: d.result } : d.body;
    },
  };
}

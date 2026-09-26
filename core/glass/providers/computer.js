// @ts-check
// computer: files on an agent's computer, through computerd (ADR 0005, decision 4).
//
// computerd runs inside the container as the agent's user and applies the same guard there;
// vyred applies it here as well, so a path is checked on both sides of the wire and a denied
// name is hidden even if computerd were to list it. vyred reaches computerd with the URL and
// token from `computers.helper`, a module-only tool that thaws the container without taking a
// screen slot. The token lives in this call's memory and is never returned or logged.
//
// The computerd /fs contract this expects (Glass contributes these routes to the computers
// image). Every path is relative to /home/agent; "" is the home itself. Every request carries
// `Authorization: Bearer <token>`. Errors are JSON `{ "error": { "code", "message" } }` with a
// 4xx or 5xx status (400 bad path, 403 denied by the guard, 404 missing, 409 exists, 413 too
// large, 416 bad range, 423 shielded).
//
//   GET  /fs/list?path=<rel>    -> { entries: [{ name, kind: "dir"|"file"|"link"|"other", size, mtime, to? }], truncated }
//   GET  /fs/stat?path=<rel>    -> { name, kind, size, mtime, mime? }
//   GET  /fs/read?path=<rel>    -> the bytes; honours one `Range: bytes=a-b` with 206 and
//                                  content-range, else 200; content-length always
//   PUT  /fs/write?path=<rel>&overwrite=0|1&size=<n>
//                               -> streams the body to a temp file in the same folder and renames
//                                  it into place only if exactly <n> bytes arrived; 409 if the
//                                  name exists and overwrite=0. Answers { size }
//   POST /fs/move  { from, to } -> { moved: true }   (never replaces an existing name)
//   POST /fs/mkdir { path }     -> { created: true }
//   POST /fs/trash { path }     -> { to }            (moved into ~/.vyre-trash/<stamp>-<name>)

import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { checkRel, hidden } from "../guard.js";
import { counter } from "../bytes.js";

const NO_HELPER = "files on an agent's computer need computers.helper";

/** Read a small JSON answer. computerd's JSON is never large; a body past 4 MB is refused. */
async function json(res) {
  let raw = "";
  res.setEncoding("utf8");
  for await (const c of res) { raw += c; if (raw.length > 4_000_000) { res.destroy(); throw new Error("computerd sent too much"); } }
  let body = null;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`computerd answered ${res.statusCode} with something that is not JSON`); }
  if ((res.statusCode || 500) >= 400) throw errorOf(res.statusCode, body);
  return body;
}

const errorOf = (status, body) => {
  const e = body && body.error;
  const code = status === 409 ? "exists" : status === 413 ? "too_large" : status === 416 ? "range" : (e && e.code) || "failed";
  return Object.assign(new Error((e && e.message) || `computerd answered ${status}`), { code, status });
};

export class ComputerProvider {
  /**
   * @param {string} agent
   * @param {(tool: string, input: any) => Promise<any>} call ctx.call
   */
  constructor(agent, call) {
    this.agent = agent;
    this.call = call;
  }

  roots() { return [{ name: "home", path: "" }]; }

  /** computerd's URL and token, thawing the computer if it was frozen. */
  async helper() {
    const r = await this.call("computers.helper", { agent: this.agent });
    if (r.error) throw new Error(r.error.code === "no_such_tool" ? NO_HELPER : `could not reach ${this.agent}'s computer: ${r.error.message}`);
    const h = r.data || {};
    if (!h.url || !h.token) throw new Error(`${this.agent}'s computer did not say where computerd is`);
    return { url: new URL(String(h.url)), token: String(h.token) };
  }

  /**
   * One request to computerd. Resolves with the response once headers arrive; the body is the
   * caller's to read. `body` is a stream piped in (an upload) or an object sent as JSON.
   * @param {string} method @param {string} route @param {Record<string, string>} query
   * @param {{ body?: any, headers?: Record<string, string> }} [opts]
   * @returns {Promise<import("node:http").IncomingMessage>}
   */
  async request(method, route, query, opts = {}) {
    const { url, token } = await this.helper();
    const target = new URL(route, url);
    for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
    const json = opts.body && typeof opts.body.pipe !== "function" ? JSON.stringify(opts.body) : null;
    const headers = { authorization: `Bearer ${token}`, ...(opts.headers || {}),
      ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const lib = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(target, { method, headers, agent: false }, resolve);
      req.on("error", e => reject(new Error(`computerd did not answer: ${e.message}`)));
      if (json) req.end(json);
      else if (opts.body) {
        pipeline(opts.body, req).catch(e => { req.destroy(); reject(e); });
      } else req.end();
    });
  }

  async list(rel) {
    const segments = checkRel(rel);
    const r = await json(await this.request("GET", "/fs/list", { path: segments.join("/") }));
    const entries = (Array.isArray(r.entries) ? r.entries : []).filter(e => e && typeof e.name === "string" && !hidden(e.name, segments));
    return { root: "home", path: segments.join("/"), entries, truncated: Boolean(r.truncated) };
  }

  async stat(rel) {
    const segments = checkRel(rel);
    return json(await this.request("GET", "/fs/stat", { path: segments.join("/") }));
  }

  /** @param {string} rel @param {string} [range] */
  async read(rel, range) {
    const segments = checkRel(rel);
    const res = await this.request("GET", "/fs/read", { path: segments.join("/") }, range ? { headers: { range } } : {});
    if ((res.statusCode || 500) >= 400) {
      const e = await json(res).catch(err => err);
      throw e instanceof Error ? e : new Error("computerd could not read that");
    }
    const length = Number(res.headers["content-length"]);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers["content-range"] || ""));
    if (res.statusCode === 206 && m) return { stream: res, start: Number(m[1]), end: Number(m[2]), total: Number(m[3]), partial: true };
    return { stream: res, start: 0, end: Math.max(0, length - 1), total: Number.isFinite(length) ? length : 0, partial: false };
  }

  /** @param {string} rel @param {import("node:stream").Readable} body @param {{ size: number, overwrite?: boolean }} opts */
  async write(rel, body, { size, overwrite = false }) {
    const segments = checkRel(rel);
    if (!segments.length) throw new Error("the home folder cannot be replaced");
    // Counted here too, so a body that overruns stops at vyred, before it costs the container.
    const count = counter(size);
    body.pipe(count);
    body.on("error", e => count.destroy(e));
    const res = await this.request("PUT", "/fs/write", { path: segments.join("/"), overwrite: overwrite ? "1" : "0", size: String(size) },
      { body: count, headers: { "content-type": "application/octet-stream" } });
    const r = await json(res);
    if (count.bytes !== size) throw Object.assign(new Error(`the upload announced ${size} bytes and sent ${count.bytes}`), { code: "wrong_size" });
    return { size: Number(r.size ?? count.bytes) };
  }

  async move(from, to) {
    const a = checkRel(from), b = checkRel(to);
    if (!a.length || !b.length) throw new Error("the home folder cannot be moved");
    await json(await this.request("POST", "/fs/move", {}, { body: { from: a.join("/"), to: b.join("/") } }));
  }

  async mkdir(rel) {
    const s = checkRel(rel);
    if (!s.length) throw new Error("the home folder already exists");
    await json(await this.request("POST", "/fs/mkdir", {}, { body: { path: s.join("/") } }));
  }

  async trash(rel) {
    const s = checkRel(rel);
    if (!s.length) throw new Error("the home folder cannot be trashed");
    const r = await json(await this.request("POST", "/fs/trash", {}, { body: { path: s.join("/") } }));
    return { to: String(r.to || "") };
  }
}

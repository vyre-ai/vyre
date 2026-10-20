// @ts-check
// agentd-fs: runs AS one agent's uid, started by the relay for an "fs" ticket (agentd-relay.js). It does ONE file operation in that agent's own home and exits. This is how Vyre Files reads and
// writes the agent's folder (owner decision, 20 Oct 2026: the folder on the agent's computer is the one real copy; nothing syncs and nothing is copied).
//
// The operation is done by computerd's own /fs routes (computerd/fs.js, copied beside this file in the image), so the agent's folder in Files is checked by exactly the code that checks Glass Files:
// every path relative to the home, no "..", no absolute path, the private names (.ssh, keys, .vyre and the rest) never listed or opened, symlinks followed only when they land inside the home on an
// allowed name, each folder on the way opened by fd so a swap in the middle of a request leads nowhere, a write counted against the size it announced and renamed into place, a delete a move to
// the home's trash, and Downloads (the link to the folder Chrome saves into, the browser uid's) listed and read only.
//
// The home and the downloads folder follow from the uid this runs as and nothing else: no request can name another agent's. And because it runs as that uid, the kernel's own file modes stop it at
// that agent's files (every home is 0700) whatever a path says.
//
// In: one JSON line, the request the relay checked (agentd.js validateFs) and wrote first; for a write, exactly `size` bytes after it. Out: one JSON line { status, headers }, then the body: the
// bytes of a read, or the route's JSON answer. Errors are the routes' own: 400 bad path, 403 denied, 404 missing, 409 exists, 413 too large, 416 bad range.

import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { createFs } from "./computerd/fs.js";

export const HOME_OF = (/** @type {number} */ uid) => `/var/lib/vyre/agents/ag${uid}/home`;
export const DOWNLOADS_OF = (/** @type {number} */ uid) => `/var/lib/vyre/downloads/ag${uid}`;
const OPS = new Set(["list", "stat", "read", "write", "mkdir", "move", "trash"]);
const LINE_MAX = 16 * 1024;

/** The response a route writes, carried as a header line and then the bytes. */
class Reply extends Writable {
  /** @param {NodeJS.WritableStream} out */
  constructor(out) { super(); this.out = out; this.headersSent = false; }
  /** @param {number} status @param {Record<string, string>} [headers] */
  writeHead(status, headers = {}) {
    if (!this.headersSent) { this.headersSent = true; this.out.write(JSON.stringify({ status, headers }) + "\n"); }
    return this;
  }
  /** @param {any} chunk @param {BufferEncoding} _enc @param {(e?: Error | null) => void} cb */
  _write(chunk, _enc, cb) { this.writeHead(200); this.out.write(chunk, () => cb()); }
  /** @param {(e?: Error | null) => void} cb */
  _final(cb) { this.writeHead(200); cb(); }
}

/** The first line of the input and what came after it. @param {NodeJS.ReadableStream} input @returns {Promise<{ line: string, rest: Buffer }>} */
function firstLine(input) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const stop = () => { input.off("data", onData); input.off("end", onEnd); input.off("error", onEnd); input.pause(); };
    const onData = (/** @type {Buffer} */ c) => {
      buf = Buffer.concat([buf, Buffer.from(c)]);
      const nl = buf.indexOf(10);
      if (nl >= 0) { stop(); resolve({ line: buf.subarray(0, nl).toString("utf8"), rest: buf.subarray(nl + 1) }); }
      else if (buf.length > LINE_MAX) { stop(); reject(new Error("the request line is too long")); }
    };
    const onEnd = () => { stop(); reject(new Error("no request")); };
    input.on("data", onData); input.on("end", onEnd); input.on("error", onEnd);
  });
}

/** Exactly `size` bytes of the input, starting with what was read past the first line; anything after them is never read. @param {NodeJS.ReadableStream} input @param {Buffer} rest @param {number} size */
async function* bytes(input, rest, size) {
  let left = size;
  if (left > 0 && rest.length) { const c = rest.subarray(0, left); left -= c.length; yield c; }
  if (left <= 0) return;
  for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (input)) {
    const c = Buffer.from(chunk).subarray(0, left);
    left -= c.length;
    if (c.length) yield c;
    if (left <= 0) return;
  }
}

/**
 * Serve one operation. `root` is the agent's home and `downloads` its Chrome download folder, both fixed by the caller (the uid, in the image; a temp folder, in a test).
 * @param {{ root: string, downloads?: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} o
 */
export async function serveFs(o) {
  const res = new Reply(o.output);
  const refuse = (/** @type {string} */ message) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "bad_request", message } })); return finished(res); };
  let spec, rest;
  try { const l = await firstLine(o.input); rest = l.rest; spec = JSON.parse(l.line); }
  catch (e) { return refuse(e instanceof SyntaxError ? "the request is not JSON" : String(/** @type {Error} */ (e).message)); }
  if (!spec || typeof spec !== "object" || !OPS.has(spec.op)) return refuse("not a file operation");
  const q = new URLSearchParams();
  if (spec.op !== "move") q.set("path", typeof spec.path === "string" ? spec.path : "");
  /** @type {Readable} */ let body;
  /** @type {Record<string, string>} */ const headers = {};
  let method = "GET", route = spec.op;
  if (spec.op === "write") {
    if (!Number.isSafeInteger(spec.size) || spec.size < 0) return refuse("a write says its size");
    method = "PUT"; q.set("size", String(spec.size)); if (spec.overwrite === true) q.set("overwrite", "1");
    body = Readable.from(bytes(o.input, rest, spec.size), { objectMode: false });
  } else if (spec.op === "mkdir" || spec.op === "trash" || spec.op === "move") {
    method = "POST";
    body = Readable.from([JSON.stringify(spec.op === "move" ? { from: spec.from, to: spec.to } : { path: spec.path })], { objectMode: false });
  } else {
    if (spec.op === "read" && typeof spec.range === "string") headers.range = spec.range;
    body = Readable.from([], { objectMode: false });
  }
  const req = Object.assign(body, { method, headers, url: `/fs/${route}?${q}` });
  const handle = createFs({ root: o.root, downloads: o.downloads || "" });
  await handle(/** @type {any} */ (req), /** @type {any} */ (res), new URL(`http://agentd/fs/${route}?${q}`));
  if (!res.writableFinished) await finished(res).catch(() => {});
}

if (process.argv[1] && process.argv[1].endsWith("agentd-fs.js")) {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  // only an agent's own uid (the image makes ag20000 to ag20063), never root, agentctl or a browser uid
  if (uid < 20000 || uid > 20063 || uid !== (typeof process.getuid === "function" ? process.getuid() : -1)) process.exit(2);
  serveFs({ root: HOME_OF(uid), downloads: DOWNLOADS_OF(uid), input: process.stdin, output: process.stdout })
    .then(() => process.stdout.write("", () => process.exit(0)), () => process.exit(3));
}

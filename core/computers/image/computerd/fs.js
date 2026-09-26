// @ts-check
// fs: computerd's /fs routes, the agent's home as Glass browses it (ADR 0005, decision 4).
//
// The contract is the header of core/glass/providers/computer.js, the other end of this pipe:
// list, stat, read (one Range), write (streamed, counted, renamed into place), move, mkdir and
// trash, every path relative to the home. computerd runs as the agent's user, so the kernel
// already stops it at the user's own files; the guard below is what stops it at the user's
// secrets. vyred applies the same guard before it ever sends a path, so a path is checked on
// both sides of the wire.
//
// computerd is copied alone into the image and cannot import core/glass, so the guard is copied
// here. DENY and the matching rules must equal core/glass/guard.js; core/glass/fs-parity.test.js
// fails the build when they drift. Change both or neither.
//
// The root is /home/agent, or COMPUTERD_FS_ROOT for tests.
//
// Errors are JSON `{ error: { code, message } }`: 400 bad path, 403 denied, 404 missing, 409
// exists, 413 larger than announced, 416 bad range. A message never carries an absolute path.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// ---- the guard: must equal core/glass/guard.js --------------------------------------------

/**
 * Names denied at any depth. A plain name matches a path segment exactly (case-insensitively);
 * `*` is a wildcard within one segment; a name with a slash matches those segments in a row.
 * Must equal DENY in core/glass/guard.js.
 */
export const DENY = Object.freeze([
  ".vyre", ".claude", ".claude.json", ".ssh", ".gnupg", ".aws", ".docker", ".kube", ".config/gcloud",
  ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx",
  "*.kdbx", "*.keychain*", "id_*", "credentials.json", "service-account*.json",
  "Cookies", "Login Data", "Login Data For Account", "Web Data", "secrets",
]);

/** Glass's own working files: never listed, and never the name of something a person makes. */
export const TRASH = ".vyre-trash";
export const UPLOAD_PREFIX = ".vyre-upload-";
export const MAX_ENTRIES = 5000;

/** An error with the status and code computerd answers with. */
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

const glob = s => new RegExp("^" + s.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const RULES = DENY.map(d => d.split("/").map(glob));

/** Does a list of path segments touch a denied place? */
export function deniedSegments(segments) {
  const low = segments.map(s => String(s).toLowerCase());
  for (const rule of RULES) {
    for (let i = 0; i + rule.length <= low.length; i++) {
      if (rule.every((re, j) => re.test(low[i + j]))) return true;
    }
  }
  return false;
}

/** Is one entry, seen in a listing of `parentSegments`, hidden? Denied names and Glass's own files. */
export function hidden(name, parentSegments = []) {
  if (name === TRASH || name.startsWith(UPLOAD_PREFIX)) return true;
  return deniedSegments([...parentSegments, name]);
}

/**
 * Check a relative path and return its normalized segments; "" is the root itself.
 * @param {unknown} rel
 * @returns {string[]}
 */
export function checkRel(rel) {
  if (rel === undefined || rel === null) rel = "";
  if (typeof rel !== "string") throw fail(400, "bad_path", "a path must be a string");
  if (rel.includes("\0")) throw fail(400, "bad_path", "a path may not contain NUL");
  if (rel.length > 4096) throw fail(400, "bad_path", "that path is too long");
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel) || /^~(?:[\\/]|$)/.test(rel)) throw fail(400, "bad_path", `"${rel}" is absolute; paths are relative to a root`);
  const raw = rel.split(/[\\/]+/);
  if (raw.includes("..")) throw fail(400, "bad_path", `"${rel}" climbs out with ..; paths stay inside their root`);
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  const segments = norm === "." ? [] : norm.split("/").filter(s => s && s !== ".");
  if (segments.includes("..")) throw fail(400, "bad_path", `"${rel}" climbs out with ..; paths stay inside their root`);
  if (deniedSegments(segments)) throw fail(403, "denied", `"${rel}" is a private place Glass does not open`);
  return segments;
}

/** Is `p` the directory `dir` or inside it? Both must already be real paths. */
export function inside(dir, p) {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** A name for a new file or folder: one segment, not denied, not one of Glass's own. */
export function checkName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name) || name.length > 255) throw fail(400, "bad_path", `"${name}" is not a file name`);
  if (hidden(name)) throw fail(403, "denied", `"${name}" is a private name Glass does not create`);
  return name;
}

/**
 * Resolve `rel` inside `root`, following symlinks, and refuse anything that ends outside the
 * root or on a denied name. With `{ create: true }` the parent is resolved instead, for a name
 * that must not exist yet. The same rules as resolveIn in core/glass/guard.js.
 * @param {string} root @param {unknown} rel @param {{ create?: boolean }} [opts]
 * @returns {{ abs: string, real: string, segments: string[] }}
 */
export function resolveIn(root, rel, opts = {}) {
  const segments = checkRel(rel);
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { throw fail(404, "missing", "the home folder is not there"); }
  const abs = path.join(realRoot, ...segments);
  const escape = () => fail(403, "denied", `"${rel}" leads outside its root`);
  const within = real => {
    if (!inside(realRoot, real)) throw escape();
    const under = path.relative(realRoot, real);
    if (under && deniedSegments(under.split(path.sep))) throw fail(403, "denied", `"${rel}" leads to a private place Glass does not open`);
    return real;
  };
  if (opts.create) {
    if (!segments.length) throw fail(400, "bad_path", "the home folder cannot be made or replaced");
    checkName(segments[segments.length - 1]);
    let parent;
    try { parent = fs.realpathSync(path.dirname(abs)); } catch { throw fail(404, "missing", `the folder for "${rel}" does not exist`); }
    within(parent);
    if (!fs.statSync(parent).isDirectory()) throw fail(400, "bad_path", `the folder for "${rel}" is not a folder`);
    const target = path.join(parent, segments[segments.length - 1]);
    // An existing symlink at the destination would redirect a write: resolve it like any read.
    let st = null;
    try { st = fs.lstatSync(target); } catch {}
    if (st && st.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(target); } catch { throw escape(); }
      within(real);
    }
    return { abs, real: target, segments };
  }
  let real;
  try { real = fs.realpathSync(abs); }
  catch (e) { throw /** @type {any} */ (e).code === "ENOENT" ? fail(404, "missing", `"${rel}" does not exist`) : fail(403, "denied", `"${rel}" cannot be opened`); }
  return { abs, real: within(real), segments };
}

// ---- bytes ---------------------------------------------------------------------------------

/** One byte range from a Range header, or null for the whole file. Throws 416 past the end. */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, total - Number(m[2])); end = total - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (!Number.isSafeInteger(start) || start >= total || end < start) throw Object.assign(fail(416, "range", "that range is outside the file"), { total });
  return { start, end };
}

/** Counts bytes and fails as soon as they pass `max`, so a lying upload stops at the lie. */
function counter(max) {
  const t = new Transform({
    transform(chunk, _enc, done) {
      const n = (/** @type {any} */ (t).bytes += chunk.length);
      if (n > max) done(fail(413, "too_large", `the upload is larger than the ${max} bytes it announced`));
      else done(null, chunk);
    },
  });
  /** @type {any} */ (t).bytes = 0;
  return /** @type {Transform & { bytes: number }} */ (t);
}

const kindOf = st => st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";

/** A trash name that sorts by when, and keeps the original name readable. */
const trashName = (name, at = Date.now()) => `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${name}`;

/** A small JSON body (move, mkdir, trash). */
async function readJson(req) {
  let raw = "";
  req.setEncoding("utf8");
  for await (const c of req) { raw += c; if (raw.length > 64_000) throw fail(413, "too_large", "request body too large"); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw fail(400, "bad_request", "body is not JSON"); }
}

// ---- the routes ----------------------------------------------------------------------------

/**
 * The /fs handler over one home folder. Call it after the bearer check; it answers every
 * /fs/... request, including with 404 for a route it does not have.
 * @param {{ root?: string }} [opts]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => Promise<void>}
 */
export function createFs(opts = {}) {
  const root = opts.root || process.env.COMPUTERD_FS_ROOT || "/home/agent";

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
    res.end(text);
  };

  async function list(rel) {
    const { real, segments } = resolveIn(root, rel);
    if (!fs.statSync(real).isDirectory()) throw fail(400, "not_a_folder", `"${rel}" is not a folder`);
    const realRoot = fs.realpathSync(root);
    /** @type {any[]} */
    const entries = [];
    let truncated = false;
    const dir = await fs.promises.opendir(real);
    for await (const d of dir) {
      if (hidden(d.name, segments)) continue;
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const p = path.join(real, d.name);
      if (d.isSymbolicLink()) {
        // Shown as a link; followed only when it lands inside the root on a name the guard allows.
        const e = { name: d.name, kind: "link", size: null, mtime: null, to: null };
        try {
          const target = fs.realpathSync(p);
          const under = path.relative(realRoot, target);
          if (inside(realRoot, target) && !(under && deniedSegments(under.split(path.sep)))) {
            const st = fs.statSync(target);
            const k = kindOf(st);
            if (k !== "other") Object.assign(e, { to: k, size: k === "file" ? st.size : null, mtime: st.mtimeMs });
          }
        } catch {}
        entries.push(e);
        continue;
      }
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      const kind = kindOf(st);
      entries.push({ name: d.name, kind, size: kind === "file" ? st.size : null, mtime: st.mtimeMs });
    }
    entries.sort((a, b) => Number(b.kind === "dir" || b.to === "dir") - Number(a.kind === "dir" || a.to === "dir") || a.name.localeCompare(b.name));
    return { entries, truncated };
  }

  function stat(rel) {
    const { real, segments } = resolveIn(root, rel);
    const st = fs.statSync(real);
    const name = segments.length ? segments[segments.length - 1] : "";
    return { name, kind: kindOf(st), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs };
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  async function read(rel, req, res) {
    const { real } = resolveIn(root, rel);
    const st = fs.statSync(real);
    if (!st.isFile()) throw fail(400, "not_a_file", `"${rel}" is not a file`);
    const total = st.size;
    let r;
    try { r = total ? parseRange(req.headers.range, total) : null; }
    catch (e) {
      res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
      res.end(JSON.stringify({ error: { code: "range", message: /** @type {Error} */ (e).message } }));
      return;
    }
    const start = r ? r.start : 0, end = r ? r.end : Math.max(0, total - 1);
    const length = total ? end - start + 1 : 0;
    // Opened before the head is written, so a file that vanished answers 404, not a cut body.
    const stream = fs.createReadStream(real, total ? { start, end } : {});
    await new Promise((resolve, reject) => { stream.once("open", resolve); stream.once("error", reject); });
    res.writeHead(r ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(length),
      ...(r ? { "content-range": `bytes ${start}-${end}/${total}` } : {}) });
    await pipeline(stream, res);
  }

  /** @param {import("node:http").IncomingMessage} body */
  async function write(rel, body, size, overwrite) {
    const { real } = resolveIn(root, rel, { create: true });
    const exists = fs.existsSync(real);
    if (exists && !overwrite) throw fail(409, "exists", `"${rel}" already exists`);
    if (exists && !fs.statSync(real).isFile()) throw fail(409, "exists", `"${rel}" is a folder`);
    const temp = path.join(path.dirname(real), UPLOAD_PREFIX + crypto.randomBytes(8).toString("hex"));
    const count = counter(size);
    try {
      await pipeline(body, count, fs.createWriteStream(temp, { flags: "wx", mode: 0o644 }));
      if (count.bytes !== size) throw fail(400, "wrong_size", `the upload announced ${size} bytes and sent ${count.bytes}`);
      if (overwrite) fs.renameSync(temp, real);
      else {
        // A hard link fails if the name was taken meanwhile, where a rename would clobber it.
        try { fs.linkSync(temp, real); }
        catch (e) {
          if (/** @type {any} */ (e).code === "EEXIST" || fs.existsSync(real)) throw fail(409, "exists", `"${rel}" already exists`);
          fs.renameSync(temp, real);
        }
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return { size: count.bytes };
  }

  function move(from, to) {
    const src = resolveIn(root, from);
    if (!src.segments.length) throw fail(400, "bad_path", "the home folder cannot be moved");
    // Move the entry itself, never what a link points at.
    const own = path.join(fs.realpathSync(path.dirname(src.abs)), path.basename(src.abs));
    const dst = resolveIn(root, to, { create: true });
    if (fs.existsSync(dst.real) || isLink(dst.real)) throw fail(409, "exists", `"${to}" already exists`);
    if (inside(own, dst.real)) throw fail(400, "bad_path", "a folder cannot move inside itself");
    try { fs.renameSync(own, dst.real); }
    catch (e) { throw fail(500, "failed", /** @type {any} */ (e).code === "EXDEV" ? "that move crosses disks, which Glass does not do" : "could not move it"); }
    return { moved: true };
  }

  function mkdir(rel) {
    const { real } = resolveIn(root, rel, { create: true });
    try { fs.mkdirSync(real); }
    catch (e) { throw /** @type {any} */ (e).code === "EEXIST" ? fail(409, "exists", `"${rel}" already exists`) : fail(500, "failed", `could not make "${rel}"`); }
    return { created: true };
  }

  function trash(rel) {
    const src = resolveIn(root, rel);
    if (!src.segments.length) throw fail(400, "bad_path", "the home folder cannot be trashed");
    if (src.segments[0] === TRASH) throw fail(400, "bad_path", "that is already in the trash");
    const own = path.join(fs.realpathSync(path.dirname(src.abs)), path.basename(src.abs));
    const bin = path.join(fs.realpathSync(root), TRASH);
    fs.mkdirSync(bin, { recursive: true });
    const name = trashName(src.segments[src.segments.length - 1]);
    fs.renameSync(own, path.join(bin, name));
    return { to: `${TRASH}/${name}` };
  }

  return async function handle(req, res, url) {
    try {
      const p = url.searchParams.get("path") || "";
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /fs/list") return send(res, 200, await list(p));
      if (route === "GET /fs/stat") return send(res, 200, stat(p));
      if (route === "GET /fs/read") return await read(p, req, res);
      if (route === "PUT /fs/write") {
        const size = Number(url.searchParams.get("size"));
        if (!url.searchParams.has("size") || !Number.isSafeInteger(size) || size < 0) throw fail(400, "bad_request", "write needs size, a whole number of bytes");
        return send(res, 200, await write(p, req, size, url.searchParams.get("overwrite") === "1"));
      }
      if (route === "POST /fs/move") { const b = await readJson(req); return send(res, 200, move(b.from, b.to)); }
      if (route === "POST /fs/mkdir") { const b = await readJson(req); return send(res, 200, mkdir(b.path)); }
      if (route === "POST /fs/trash") { const b = await readJson(req); return send(res, 200, trash(b.path)); }
      return send(res, 404, { error: { code: "not_found", message: `no such route: ${route}` } });
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (res.headersSent) { res.destroy(); return; }
      // A surprise from the disk (EACCES, ENOSPC) says what failed, never the absolute path.
      const status = Number(err.status) || 500;
      const message = err.status ? String(err.message) : `could not do that (${err.code || "error"})`;
      send(res, status, { error: { code: err.status ? err.code : "failed", message } });
    }
  };
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

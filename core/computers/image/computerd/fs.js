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
  "Cookies", "Login Data", "Login Data For Account", "Web Data", "secrets", ".vnc",
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

// ---- safe opens --------------------------------------------------------------------------
//
// resolveIn's realpath happens once, up front; every operation below used to reuse its result
// as a path string, opened moments later by name. In between, the agent -- who owns everything
// under root -- can rename a folder on the checked path out and put a symlink to /var/lib/vyre
// in its place, and computerd (running as vyre) would then open, read, or write through it
// (reviewer, 28 Sep). The fix: never re-walk a path by name after it is checked. Each directory
// in the chain is opened relative to the fd of the one before it, so a rename anywhere else in
// the tree cannot redirect a step that is already holding an open, real directory; the final
// component is always opened with O_NOFOLLOW, so a symlink swapped in at the very last moment is
// refused rather than followed. /proc/self/fd/<fd>/<name> is Linux's way to express that "open
// relative to this fd" without a native openat binding -- computerd only ever runs inside the
// computer image, which is Linux, so this is always available where it matters.
const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = fs.constants;
/** @param {number} fd @param {string} [name] */
const fdPath = (fd, name) => name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;

/**
 * A symlink sat at `fdPath(fd, name)` where a plain open (with `flags`) just failed -- a real,
 * pre-existing one (Glass follows those inside root, like docs-link in fs.test.js) or one just
 * swapped in for what this same request already checked as a plain entry (the reviewer's own
 * scenario, 28 Sep). Both look identical at this point, so both get the identical check resolveIn
 * already does for a symlink: resolve it right now, at the moment of the open, and only follow
 * if it still lands inside root on an allowed name -- a stale answer from earlier in this same
 * request is never trusted here. Returns a new, opened fd for the resolved target, or throws.
 * @param {string} realRoot @param {number} fd @param {string} name @param {number} flags
 */
function followChecked(realRoot, fd, name, flags) {
  let target;
  try { target = fs.realpathSync(fdPath(fd, name)); }
  catch { throw fail(404, "missing", "the path no longer exists"); }
  const under = path.relative(realRoot, target);
  if (!inside(realRoot, target) || (under && deniedSegments(under.split(path.sep)))) {
    throw fail(403, "denied", "a symlink here leads outside its root, or to a private place Glass does not open");
  }
  try { return fs.openSync(target, flags & ~O_NOFOLLOW); }
  catch { throw fail(400, "bad_path", "a file where a folder was expected"); }
}

/**
 * Opens `segments` one directory at a time from `realRoot` (trusted: fixed per computer, never
 * attacker-named) and returns the last one's own fd. The caller closes it.
 * @param {string} realRoot @param {string[]} segments
 */
function openDirChain(realRoot, segments) {
  let fd = fs.openSync(realRoot, O_DIRECTORY);
  for (const name of segments) {
    let next;
    try { next = fs.openSync(fdPath(fd, name), O_DIRECTORY | O_NOFOLLOW); }
    catch (e) {
      // O_NOFOLLOW + O_DIRECTORY on a symlink answers ENOTDIR on Linux, the same code a plain
      // file (never a symlink) answers -- lstat tells the two apart, since it never follows.
      let st = null;
      try { st = fs.lstatSync(fdPath(fd, name)); } catch {}
      if (!st || !st.isSymbolicLink()) {
        fs.closeSync(fd);
        if (!st) throw fail(404, "missing", "the path no longer exists");
        throw fail(400, "bad_path", "a file where a folder was expected");
      }
      try { next = followChecked(realRoot, fd, name, O_DIRECTORY | O_NOFOLLOW); }
      catch (e2) { fs.closeSync(fd); throw e2; }
    }
    fs.closeSync(fd);
    fd = next;
  }
  return fd;
}

/**
 * Like resolveIn, but for an operation that actually touches disk: in addition to `segments`, it
 * opens and pins the checked parent directory (root itself, when `rel` names the root), so the
 * caller can open, mkdir or rename the leaf by name through fdPath(parentFd, name) -- never by a
 * path string re-walked from the top. The caller always closes `parentFd`.
 * @param {string} root @param {unknown} rel @param {{ create?: boolean }} [opts]
 * @returns {{ parentFd: number, name: string|null, segments: string[], realRoot: string }}
 */
export function resolveOpen(root, rel, opts = {}) {
  const r = resolveIn(root, rel, opts);
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { throw fail(404, "missing", "the home folder is not there"); }
  const parentFd = openDirChain(realRoot, r.segments.slice(0, -1));
  return { parentFd, name: r.segments.length ? r.segments[r.segments.length - 1] : null, segments: r.segments, realRoot };
}

/**
 * Opens the leaf named `name` under the pinned `parentFd`, at the moment of the open rather than
 * by a path checked earlier: a plain entry opens with `flags` (O_NOFOLLOW included) as before; a
 * symlink there gets the same follow-and-revalidate treatment as an ancestor directory
 * (followChecked) rather than being refused outright, so an existing in-root symlink still reads
 * the same way it did before this fix, and only a swap since the last check is caught.
 * @param {string} realRoot @param {number} parentFd @param {string} name @param {number} flags @param {string} rel for the error message
 */
function openLeaf(realRoot, parentFd, name, flags, rel) {
  try { return fs.openSync(fdPath(parentFd, name), flags); }
  catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === "ENOENT") throw fail(404, "missing", `"${rel}" does not exist`);
    if (code === "ELOOP") { try { return followChecked(realRoot, parentFd, name, flags); } catch (e2) { throw e2; } }
    throw fail(403, "denied", `"${rel}" cannot be opened`);
  }
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
    const { parentFd, name, segments } = resolveOpen(root, rel);
    try {
      let dirFd = parentFd, ownFd = false;
      if (name !== null) {
        try { dirFd = fs.openSync(fdPath(parentFd, name), O_DIRECTORY | O_NOFOLLOW); ownFd = true; }
        catch (e) {
          const code = /** @type {any} */ (e).code;
          if (code === "ENOTDIR") throw fail(400, "not_a_folder", `"${rel}" is not a folder`);
          throw fail(403, "denied", `"${rel}" cannot be opened`);
        }
      }
      try {
        const realRoot = fs.realpathSync(root);
        /** @type {any[]} */
        const entries = [];
        let truncated = false;
        const dir = await fs.promises.opendir(fdPath(dirFd));
        for await (const d of dir) {
          if (hidden(d.name, segments)) continue;
          if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
          const p = fdPath(dirFd, d.name);
          if (d.isSymbolicLink()) {
            // Shown as a link; followed only when it lands inside the root on a name the guard
            // allows, and only for this one preview stat -- reads and writes never use `p` again.
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
      } finally { if (ownFd) fs.closeSync(dirFd); }
    } finally { fs.closeSync(parentFd); }
  }

  function stat(rel) {
    const { parentFd, name, segments, realRoot } = resolveOpen(root, rel);
    try {
      const fd = name === null ? parentFd : openLeaf(realRoot, parentFd, name, O_RDONLY | O_NOFOLLOW, rel);
      try {
        const st = fs.fstatSync(fd);
        return { name: segments.length ? segments[segments.length - 1] : "", kind: kindOf(st), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs };
      } finally { if (name !== null) fs.closeSync(fd); }
    } finally { fs.closeSync(parentFd); }
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  async function read(rel, req, res) {
    const { parentFd, name, realRoot } = resolveOpen(root, rel);
    let fd;
    try {
      if (name === null) throw fail(400, "not_a_file", `"${rel}" is not a file`);
      fd = openLeaf(realRoot, parentFd, name, O_RDONLY | O_NOFOLLOW, rel);
    } finally { fs.closeSync(parentFd); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw fail(400, "not_a_file", `"${rel}" is not a file`);
      const total = st.size;
      let r;
      try { r = total ? parseRange(req.headers.range, total) : null; }
      catch (e) {
        res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
        res.end(JSON.stringify({ error: { code: "range", message: /** @type {Error} */ (e).message } }));
        fs.closeSync(fd);
        return;
      }
      const start = r ? r.start : 0, end = r ? r.end : Math.max(0, total - 1);
      const length = total ? end - start + 1 : 0;
      // The fd is already open and already checked (openLeaf, above): nothing here re-opens by
      // name, so nothing here can be raced onto a different file.
      const stream = fs.createReadStream(null, { fd, autoClose: true, ...(total ? { start, end } : {}) });
      res.writeHead(r ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(length),
        ...(r ? { "content-range": `bytes ${start}-${end}/${total}` } : {}) });
      await pipeline(stream, res);
    } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
  }

  /** @param {import("node:http").IncomingMessage} body */
  async function write(rel, body, size, overwrite) {
    const { parentFd, name } = resolveOpen(root, rel, { create: true });
    try {
      // lstat, never following a final symlink: an existing entry there is exists/denied to us
      // whatever it is, the same way a plain file or folder would be. checked and used through
      // the one pinned parentFd, never a path re-walked from the top (reviewer, 28 Sep).
      let existing = null;
      try { existing = fs.lstatSync(fdPath(parentFd, name)); }
      catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw fail(403, "denied", `"${rel}" cannot be opened`); }
      if (existing && !overwrite) throw fail(409, "exists", `"${rel}" already exists`);
      if (existing && !existing.isFile()) throw fail(409, "exists", existing.isDirectory() ? `"${rel}" is a folder` : `"${rel}" already exists`);
      const temp = fdPath(parentFd, UPLOAD_PREFIX + crypto.randomBytes(8).toString("hex"));
      const dest = fdPath(parentFd, name);
      const count = counter(size);
      try {
        await pipeline(body, count, fs.createWriteStream(temp, { flags: "wx", mode: 0o644 }));
        if (count.bytes !== size) throw fail(400, "wrong_size", `the upload announced ${size} bytes and sent ${count.bytes}`);
        if (overwrite) fs.renameSync(temp, dest);
        else {
          // A hard link fails if the name was taken meanwhile, where a rename would clobber it.
          try { fs.linkSync(temp, dest); }
          catch (e) {
            if (/** @type {any} */ (e).code === "EEXIST" || fs.existsSync(dest)) throw fail(409, "exists", `"${rel}" already exists`);
            fs.renameSync(temp, dest);
          }
        }
      } finally {
        try { fs.rmSync(temp, { force: true }); } catch {}
      }
      return { size: count.bytes };
    } finally { fs.closeSync(parentFd); }
  }

  /** Is `ancestorFd`'s directory the same as, or an ancestor of, the directory `fd` opens? */
  function isSameOrAncestor(ancestorFd, fd) {
    const target = fs.fstatSync(ancestorFd);
    let cur = fs.openSync(fdPath(fd), O_DIRECTORY);
    try {
      for (let i = 0; i < 64; i++) {
        const st = fs.fstatSync(cur);
        if (st.dev === target.dev && st.ino === target.ino) return true;
        let up;
        try { up = fs.openSync(fdPath(cur, ".."), O_DIRECTORY); } catch { return false; }
        const upSt = fs.fstatSync(up);
        fs.closeSync(cur);
        cur = up;
        if (upSt.dev === st.dev && upSt.ino === st.ino) return false; // the real filesystem root
      }
      return false;
    } finally { try { fs.closeSync(cur); } catch {} }
  }

  function move(from, to) {
    const src = resolveOpen(root, from);
    try {
      if (src.name === null) throw fail(400, "bad_path", "the home folder cannot be moved");
      const dst = resolveOpen(root, to, { create: true });
      try {
        let dstExists = false;
        try { fs.lstatSync(fdPath(dst.parentFd, dst.name)); dstExists = true; }
        catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw fail(403, "denied", `"${to}" cannot be opened`); }
        if (dstExists) throw fail(409, "exists", `"${to}" already exists`);
        // A folder cannot move inside itself: open the source (never following it, so we check
        // exactly the entry being moved) and walk up from the destination's own parent looking
        // for it, through pinned fds the whole way rather than a string prefix check.
        let srcDirFd = null;
        try { srcDirFd = fs.openSync(fdPath(src.parentFd, src.name), O_DIRECTORY | O_NOFOLLOW); } catch {}
        if (srcDirFd !== null) {
          try { if (isSameOrAncestor(srcDirFd, dst.parentFd)) throw fail(400, "bad_path", "a folder cannot move inside itself"); }
          finally { fs.closeSync(srcDirFd); }
        }
        try { fs.renameSync(fdPath(src.parentFd, src.name), fdPath(dst.parentFd, dst.name)); }
        catch (e) { throw fail(500, "failed", /** @type {any} */ (e).code === "EXDEV" ? "that move crosses disks, which Glass does not do" : "could not move it"); }
        return { moved: true };
      } finally { fs.closeSync(dst.parentFd); }
    } finally { fs.closeSync(src.parentFd); }
  }

  function mkdir(rel) {
    const { parentFd, name } = resolveOpen(root, rel, { create: true });
    try {
      try { fs.mkdirSync(fdPath(parentFd, name)); }
      catch (e) { throw /** @type {any} */ (e).code === "EEXIST" ? fail(409, "exists", `"${rel}" already exists`) : fail(500, "failed", `could not make "${rel}"`); }
      return { created: true };
    } finally { fs.closeSync(parentFd); }
  }

  function trash(rel) {
    const src = resolveOpen(root, rel);
    try {
      if (src.name === null) throw fail(400, "bad_path", "the home folder cannot be trashed");
      if (src.segments[0] === TRASH) throw fail(400, "bad_path", "that is already in the trash");
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { throw fail(404, "missing", "the home folder is not there"); }
      const rootFd = fs.openSync(realRoot, O_DIRECTORY);
      try {
        fs.mkdirSync(fdPath(rootFd, TRASH), { recursive: true });
        const binFd = fs.openSync(fdPath(rootFd, TRASH), O_DIRECTORY | O_NOFOLLOW);
        try {
          const name = trashName(src.name);
          fs.renameSync(fdPath(src.parentFd, src.name), fdPath(binFd, name));
          return { to: `${TRASH}/${name}` };
        } finally { fs.closeSync(binFd); }
      } finally { fs.closeSync(rootFd); }
    } finally { fs.closeSync(src.parentFd); }
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
